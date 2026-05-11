/**
 * map-site-skill.ts — BFS orchestrator tools for autonomous website intelligence mapping.
 *
 * Flow:
 *   map_site_start(url) ->
 *     for each page in BFS queue:
 *       1. Navigate to page
 *       2. addNode (persistent store — written to disk immediately)
 *       3. Discover links -> addEdge for each (persistent store)
 *       4. saveAllFormats() — write fresh .ndjson + .json + .mmd to disk after every page
 *       5. Move to next page
 *     -> final summary with file paths
 *
 * All data is written to TWO locations simultaneously:
 *   ~/.browseros/graphs/<session>.ndjson  (home dir, always present)
 *   ./graphs/<session>.ndjson             (cwd, for easy access)
 * Plus .json and .mmd snapshots updated after EVERY page:
 *   ~/.browseros/graphs/<session>.json    (full JSON export)
 *   ~/.browseros/graphs/<session>.mmd     (Mermaid flowchart diagram)
 *   ./graphs/<session>.json
 *   ./graphs/<session>.mmd
 *
 * You do NOT need to call graph_export or graph_mermaid manually.
 * All three formats are auto-saved after every single page visit.
 */
import { z } from 'zod'
import { defineTool } from '../../framework'
import {
  addEdge,
  addNode,
  generateSessionId,
  getOrCreateSession,
  getSessionSummary,
  saveAllFormats,
} from './store'

interface BfsState {
  sessionId: string
  rootUrl: string
  visited: Set<string>
  queue: string[]
  maxDepth: number
  maxPages: number
  depthMap: Map<string, number>
  status: 'idle' | 'running' | 'done' | 'error'
  startedAt: number
  homePath: string
  cwdPath: string
  homeJsonPath: string
  cwdJsonPath: string
  homeMMDPath: string
  cwdMMDPath: string
  pagesVisited: number
  lastError: string | null
}

let bfsState: BfsState | null = null

// Slugify a URL into a safe session ID
function urlToSessionId(url: string): string {
  try {
    const u = new URL(url)
    const slug = (u.hostname + u.pathname)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase()
    return `map-${slug}-${Math.random().toString(36).slice(2, 6)}`
  } catch {
    return generateSessionId()
  }
}

export const map_site_start = defineTool({
  name: 'map_site_start',
  description: [
    'Autonomously BFS-crawl a website and build a persistent knowledge graph.',
    'Every page visit, link, and relationship is written to disk immediately (NDJSON).',
    'After every single page, THREE formats are auto-saved to disk:',
    '  .ndjson (raw append log), .json (full structured export), .mmd (Mermaid flowchart diagram).',
    'You do NOT need to call graph_export or graph_mermaid manually — it is all automatic.',
    'Returns file paths + summary when done.',
    'REQUIRED: url. OPTIONAL: maxDepth (1-5, default 2), maxPages (1-100, default 20),',
    'session_id (auto-generated from URL if omitted), mermaid_direction (LR or TD, default LR).',
  ].join(' '),
  approvalCategory: 'observation',
  input: z.object({
    url: z.string().describe('Root URL to start crawling from'),
    maxDepth: z.coerce.number().int().min(1).max(5).default(2)
      .describe('Maximum BFS depth (default: 2, max: 5)'),
    maxPages: z.coerce.number().int().min(1).max(100).default(20)
      .describe('Maximum pages to visit (default: 20, max: 100)'),
    session_id: z.string().optional()
      .describe('Graph session ID. Auto-generated from URL if omitted. Reuse to resume/extend a previous crawl.'),
    mermaid_direction: z.enum(['LR', 'TD']).default('LR')
      .describe('Mermaid diagram direction: LR (left-to-right, default) or TD (top-down).'),
  }),
  async handler(args, ctx, response) {
    const origin = (() => {
      try { return new URL(args.url).origin } catch { return args.url }
    })()

    // Create / reuse persistent graph session
    const sessionId = args.session_id ?? urlToSessionId(args.url)
    const session = await getOrCreateSession(sessionId)

    const mermaidDir = (args.mermaid_direction ?? 'LR') as 'LR' | 'TD'

    bfsState = {
      sessionId,
      rootUrl: args.url,
      visited: new Set(),
      queue: [args.url],
      maxDepth: args.maxDepth,
      maxPages: args.maxPages,
      depthMap: new Map([[args.url, 0]]),
      status: 'running',
      startedAt: Date.now(),
      homePath: session.homePath,
      cwdPath: session.cwdPath,
      homeJsonPath: session.homePath.replace(/\.ndjson$/, '.json'),
      cwdJsonPath: session.cwdPath.replace(/\.ndjson$/, '.json'),
      homeMMDPath: session.homePath.replace(/\.ndjson$/, '.mmd'),
      cwdMMDPath: session.cwdPath.replace(/\.ndjson$/, '.mmd'),
      pagesVisited: 0,
      lastError: null,
    }

    // Add root node immediately
    await addNode('Root', 'page', { url: args.url, depth: 0 }, sessionId)

    while (bfsState.queue.length > 0 && bfsState.pagesVisited < args.maxPages) {
      const url = bfsState.queue.shift()!
      if (bfsState.visited.has(url)) continue
      bfsState.visited.add(url)
      bfsState.pagesVisited++

      const depth = bfsState.depthMap.get(url) ?? 0
      let pageId: number | undefined

      try {
        pageId = await ctx.browser.newPage(url, { background: true })
        await ctx.browser.goto(pageId, url)

        // Get page title
        const titleResult = await ctx.browser.evaluate(
          pageId,
          'document.title || document.location.pathname',
        )
        const title = typeof titleResult.value === 'string' ? titleResult.value : url

        // Add page node to persistent store (written to disk immediately)
        const { nodeId } = await addNode(
          title,
          'page',
          { url, depth, statusCode: 200 },
          sessionId,
        )

        // Discover all same-site links
        if (depth < args.maxDepth) {
          const links = await ctx.browser.getPageLinks(pageId)
          const sameSiteLinks = links
            .map((l) => l.href)
            .filter((h) => {
              try { return new URL(h).origin === origin } catch { return false }
            })
            // Deduplicate
            .filter((h, i, arr) => arr.indexOf(h) === i)

          for (const link of sameSiteLinks) {
            // Add linked page node
            const { nodeId: linkedNodeId } = await addNode(
              link,
              'page',
              { url: link, depth: depth + 1, status: 'queued' },
              sessionId,
            )

            // Add navigates_to edge
            await addEdge(nodeId, linkedNodeId, 'navigates_to', { fromDepth: depth }, sessionId)

            if (!bfsState.visited.has(link) && !bfsState.queue.includes(link)) {
              bfsState.queue.push(link)
              bfsState.depthMap.set(link, depth + 1)
            }
          }
        }

        // Auto-save ALL THREE formats after every page — ndjson + json + mmd
        // No manual graph_export or graph_mermaid call needed.
        await saveAllFormats(sessionId, mermaidDir)

      } catch (err) {
        bfsState.lastError = err instanceof Error ? err.message : String(err)
        // Non-fatal: record the error node and continue
        await addNode(
          url,
          'page',
          { url, depth, error: bfsState.lastError, statusCode: 0 },
          sessionId,
        ).catch(() => {/* ignore double-add */})
        // Still save after error so partial data is never lost
        await saveAllFormats(sessionId, mermaidDir).catch(() => {/* ignore save error */})
      } finally {
        if (pageId !== undefined) {
          try { await ctx.browser.closePage(pageId) } catch { /* ignore */ }
        }
      }
    }

    bfsState.status = 'done'

    // Final save + summary
    const [saveResult, summary] = await Promise.all([
      saveAllFormats(sessionId, mermaidDir),
      getSessionSummary(sessionId),
    ])

    // Update bfsState paths from actual save result
    bfsState.homeMMDPath = saveResult.homeMMDPath
    bfsState.cwdMMDPath = saveResult.cwdMMDPath

    response.text(
      JSON.stringify(
        {
          status: 'done',
          sessionId,
          pagesVisited: bfsState.pagesVisited,
          graph: {
            nodes: summary.nodeCount,
            edges: summary.edgeCount,
            nodeTypes: summary.nodeTypes,
          },
          files: {
            ndjson: {
              home: saveResult.homeNdjsonPath,
              cwd: saveResult.cwdNdjsonPath,
            },
            json: {
              home: saveResult.homeJsonPath,
              cwd: saveResult.cwdJsonPath,
            },
            mermaid: {
              home: saveResult.homeMMDPath,
              cwd: saveResult.cwdMMDPath,
            },
          },
          note: [
            'All three formats saved to disk after every page — no manual export needed.',
            'Use graph_load to re-open this session.',
            'Use graph_query to inspect data.',
            'Use graph_read to read file content back.',
            'Paste the .mmd file at https://mermaid.live to visualise the graph.',
          ].join(' '),
        },
        null,
        2,
      ),
    )
  },
})

export const map_site_bfs_status = defineTool({
  name: 'map_site_bfs_status',
  description: 'Get the current status and file paths of an in-progress or completed map_site_start BFS crawl.',
  approvalCategory: 'observation',
  input: z.object({}),
  async handler(_args, _ctx, response) {
    if (!bfsState) {
      response.text(JSON.stringify({ status: 'idle', message: 'No crawl started yet. Call map_site_start first.' }))
      return
    }

    let summary = null
    try {
      summary = await getSessionSummary(bfsState.sessionId)
    } catch { /* session may not exist yet */ }

    response.text(
      JSON.stringify(
        {
          status: bfsState.status,
          sessionId: bfsState.sessionId,
          rootUrl: bfsState.rootUrl,
          pagesVisited: bfsState.pagesVisited,
          queued: bfsState.queue.length,
          elapsedMs: Date.now() - bfsState.startedAt,
          lastError: bfsState.lastError,
          files: {
            ndjson: { home: bfsState.homePath, cwd: bfsState.cwdPath },
            json: { home: bfsState.homeJsonPath, cwd: bfsState.cwdJsonPath },
            mermaid: { home: bfsState.homeMMDPath, cwd: bfsState.cwdMMDPath },
          },
          graph: summary
            ? { nodes: summary.nodeCount, edges: summary.edgeCount, nodeTypes: summary.nodeTypes }
            : null,
        },
        null,
        2,
      ),
    )
  },
})

export const map_site_enqueue = defineTool({
  name: 'map_site_enqueue',
  description: 'Manually enqueue a URL into the active BFS crawl queue.',
  approvalCategory: 'observation',
  input: z.object({
    url: z.string().describe('URL to add to the crawl queue'),
  }),
  async handler(args, _ctx, response) {
    if (!bfsState || bfsState.status === 'done') {
      response.text(JSON.stringify({ error: 'No active crawl. Run map_site_start first.' }))
      return
    }
    if (!bfsState.visited.has(args.url) && !bfsState.queue.includes(args.url)) {
      bfsState.queue.push(args.url)
      bfsState.depthMap.set(args.url, 0)
      response.text(JSON.stringify({ queued: true, url: args.url, sessionId: bfsState.sessionId }))
    } else {
      response.text(JSON.stringify({ queued: false, reason: 'Already visited or queued.', url: args.url }))
    }
  },
})

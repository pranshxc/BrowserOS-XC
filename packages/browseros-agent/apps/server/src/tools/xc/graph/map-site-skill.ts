/**
 * map-site-skill.ts — BFS orchestrator tools for autonomous website intelligence mapping.
 * Uses BrowserOS browser tools to crawl a site and populate the knowledge graph.
 */
import { z } from 'zod'
import { defineTool } from '../../framework'
import { addEdge, addNode, graphSummary } from './graph-store'

interface BfsState {
  rootUrl: string
  visited: Set<string>
  queue: string[]
  maxDepth: number
  maxPages: number
  depthMap: Map<string, number>
  status: 'idle' | 'running' | 'done'
  startedAt: number
}

let bfsState: BfsState | null = null

export const map_site_start = defineTool({
  name: 'map_site_start',
  description:
    'Start an autonomous BFS crawl of a website to build its knowledge graph. ' +
    'Navigates pages, discovers features, APIs, and workflows, and populates the graph. ' +
    'Call graph_export or graph_summary after completion to inspect results.',
  approvalCategory: 'read',
  input: z.object({
    url: z.string().describe('Root URL to start mapping from'),
    maxDepth: z.number().int().min(1).max(5).default(2).describe('Maximum BFS depth'),
    maxPages: z.number().int().min(1).max(100).default(20).describe('Maximum pages to visit'),
  }),
  async handler(args, ctx, response) {
    const origin = (() => {
      try { return new URL(args.url).origin } catch { return args.url }
    })()

    bfsState = {
      rootUrl: args.url,
      visited: new Set(),
      queue: [args.url],
      maxDepth: args.maxDepth,
      maxPages: args.maxPages,
      depthMap: new Map([[args.url, 0]]),
      status: 'running',
      startedAt: Date.now(),
    }

    addNode({
      id: `page:${args.url}`,
      kind: 'page',
      label: 'Root',
      url: args.url,
      description: 'Entry point',
    })

    let pagesVisited = 0

    while (bfsState.queue.length > 0 && pagesVisited < args.maxPages) {
      const url = bfsState.queue.shift()!
      if (bfsState.visited.has(url)) continue
      bfsState.visited.add(url)
      pagesVisited++

      const depth = bfsState.depthMap.get(url) ?? 0

      let pageId: number | undefined
      try {
        // Open a hidden background tab so the user's active tab is not disturbed
        pageId = await ctx.browser.newPage(url, { background: true })
        await ctx.browser.goto(pageId, url)

        // Get title via evaluate (returns { value?, error? })
        const titleResult = await ctx.browser.evaluate(
          pageId,
          'document.title || document.location.pathname',
        )
        const title = typeof titleResult.value === 'string' ? titleResult.value : url

        // Use built-in getPageLinks which walks the AX tree properly
        const links = await ctx.browser.getPageLinks(pageId)
        const sameSiteLinks = links
          .map((l) => l.href)
          .filter((h) => {
            try { return new URL(h).origin === origin } catch { return false }
          })

        // Upsert page node with resolved title
        addNode({
          id: `page:${url}`,
          kind: 'page',
          label: title,
          url,
          description: `Depth ${depth}`,
        })

        if (depth < args.maxDepth) {
          for (const link of sameSiteLinks) {
            if (!bfsState.visited.has(link) && !bfsState.queue.includes(link)) {
              bfsState.queue.push(link)
              bfsState.depthMap.set(link, depth + 1)
              addNode({
                id: `page:${link}`,
                kind: 'page',
                label: link,
                url: link,
                description: `Depth ${depth + 1} (queued)`,
              })
              addEdge({
                from: `page:${url}`,
                to: `page:${link}`,
                relation: 'navigates_to',
              })
            }
          }
        }
      } catch {
        // Non-fatal: skip pages that error (cross-origin, auth-wall, etc.)
      } finally {
        if (pageId !== undefined) {
          try { await ctx.browser.closePage(pageId) } catch { /* ignore */ }
        }
      }
    }

    bfsState.status = 'done'
    const summary = graphSummary()
    response.text(
      JSON.stringify({
        status: 'done',
        pagesVisited,
        graph: summary,
      }, null, 2),
    )
  },
})

export const map_site_bfs_status = defineTool({
  name: 'map_site_bfs_status',
  description: 'Get the current status of an in-progress map_site_start BFS crawl.',
  approvalCategory: 'read',
  input: z.object({}),
  async handler(_args, _ctx, response) {
    if (!bfsState) {
      response.text(JSON.stringify({ status: 'idle', message: 'No crawl started yet.' }))
      return
    }
    response.text(
      JSON.stringify({
        status: bfsState.status,
        rootUrl: bfsState.rootUrl,
        visited: bfsState.visited.size,
        queued: bfsState.queue.length,
        elapsedMs: Date.now() - bfsState.startedAt,
        graph: graphSummary(),
      }, null, 2),
    )
  },
})

export const map_site_enqueue = defineTool({
  name: 'map_site_enqueue',
  description: 'Manually enqueue a URL into the active BFS crawl queue.',
  approvalCategory: 'read',
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
      response.text(JSON.stringify({ queued: true, url: args.url }))
    } else {
      response.text(JSON.stringify({ queued: false, reason: 'Already visited or queued.' }))
    }
  },
})

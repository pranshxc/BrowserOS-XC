/**
 * BrowserOS-XC Phase 10 — MapSite Autonomous Orchestrator
 *
 * Exports:
 *   MAP_SITE_PROMPT      — mission briefing injected when agent enters MapSite mode
 *   map_site_start       — trigger tool: seeds BFS queue, inits graph, returns prompt
 *   map_site_bfs_status  — check queue state mid-run
 *   map_site_enqueue     — explicitly add URLs to the BFS queue
 */

import { tool } from 'ai'
import { z } from 'zod'
import { getGraph, initGraph, resetGraph } from './graph-store'

// ── BFS state (in-process) ────────────────────────────────────────────────────

interface QueueEntry {
  url: string
  depth: number
  parentFeatureId?: string
}

const _queue: QueueEntry[] = []
const _visited = new Set<string>()
let _rootUrl = ''
let _maxDepth = 3
let _maxPages = 50

export function bfsEnqueue(url: string, depth: number, parentFeatureId?: string): void {
  const norm = url.split('#')[0].replace(/\/$/, '')
  if (_visited.has(norm)) return
  if (_queue.some((e) => e.url === norm)) return
  _queue.push({ url: norm, depth, parentFeatureId })
}

export function bfsDequeue(): QueueEntry | undefined {
  const entry = _queue.shift()
  if (entry) _visited.add(entry.url.split('#')[0].replace(/\/$/, ''))
  return entry
}

export function bfsState() {
  return {
    queueLength: _queue.length,
    visitedCount: _visited.size,
    rootUrl: _rootUrl,
    maxDepth: _maxDepth,
    maxPages: _maxPages,
    nextUrls: _queue.slice(0, 5).map((e) => e.url),
  }
}

// ── Mission Prompt ────────────────────────────────────────────────────────────

export const MAP_SITE_PROMPT = `
# MapSite Mission — BrowserOS-XC Intelligence Mapping

You are in autonomous **MapSite** mode. Build a complete **Knowledge Graph** of
the target website — features, workflows, API calls, and dependencies.

## Phase A — Initialise
1. map_site_start({ url, maxDepth, maxPages })
2. add_init_script({ builtin: 'fetch_logger' })
3. add_init_script({ builtin: 'navigation_logger' })

## Phase B — Per-Page Loop (repeat until queue empty or maxPages reached)
1. map_site_bfs_status()               → get next URL
2. navigate_page({ url })
3. graph_add_page({ url, title, framework, interactiveElementCount })
4. start_request_capture()
5. [call applicable eval_extract_* tools]
6. snapshot_with_refs()                → all interactive elements
7. For each interactive element:
   • Infer feature name (LLM)
   • graph_query({ question: featureName })  → dedup check
   • graph_add_feature({ name, description, pageUrl, authRequired, confidence })
   • graph_add_edge({ from: pageId, to: featureId, type: 'renders_on' })
   • if link → map_site_enqueue({ urls: [href], depth: depth+1 })
8. For key buttons/forms:
   • ref_click → observe
   • stop_request_capture() → list_captured_requests()
   • graph_add_api({ method, urlPattern }) for each new request
   • graph_add_edge({ from: featureId, to: apiId, type: 'calls_api' })
   • if navigated → graph_add_edge({ type: 'navigates_to' })
   • if redirect to /login → mark authRequired, graph_add_edge({ type: 'requires' })
   • navigate back if needed, restart_request_capture()

## Phase C — Workflows
  graph_add_workflow({ name, steps, triggeredAPIs }) for each major journey

## Phase D — Export
  graph_summary()
  graph_export({ format: 'mermaid' })
  graph_export({ format: 'all' })

## Rules
- Never visit the same URL twice
- Never perform destructive actions (no real POSTs, no delete, no purchase)
- Parametrize API URLs: /item/12345 → /item/:id
- Always dedup with graph_query before graph_add_*
- Stop when queue empty OR maxPages reached
`.trim()

// ── map_site_start ────────────────────────────────────────────────────────────

export const map_site_start = tool({
  description:
    'Start a MapSite autonomous intelligence-mapping session. '
    + 'Seeds the BFS crawl queue, initialises the knowledge graph store, '
    + 'and returns the mission briefing the agent must follow. '
    + 'Call this ONCE at the start.',
  parameters: z.object({
    url: z.string().url().describe('Root URL to map, e.g. https://news.ycombinator.com'),
    maxDepth: z.number().int().min(1).max(10).default(3),
    maxPages: z.number().int().min(1).max(200).default(50),
    resetExisting: z.boolean().default(false).describe('Wipe existing graph data and start fresh'),
    label: z.string().optional(),
  }),
  execute: async ({ url, maxDepth, maxPages, resetExisting }) => {
    if (resetExisting) resetGraph(url)
    else initGraph(url)

    _rootUrl = url
    _maxDepth = maxDepth
    _maxPages = maxPages
    _queue.length = 0
    _visited.clear()
    bfsEnqueue(url, 0)

    return {
      ok: true,
      rootUrl: url,
      maxDepth,
      maxPages,
      graphVersion: getGraph().version,
      mission: MAP_SITE_PROMPT,
      bfsState: bfsState(),
      nextStep: 'Follow MAP_SITE_PROMPT. Start Phase A: inject init scripts, then Phase B loop at: ' + url,
    }
  },
})

// ── map_site_bfs_status ───────────────────────────────────────────────────────

export const map_site_bfs_status = tool({
  description:
    'Check current BFS crawl queue: pending count, visited count, next 5 URLs. '
    + 'Call at the start of each per-page loop iteration.',
  parameters: z.object({}),
  execute: async () => bfsState(),
})

// ── map_site_enqueue ──────────────────────────────────────────────────────────

export const map_site_enqueue = tool({
  description:
    'Add URLs to the MapSite BFS crawl queue. '
    + 'Already-visited or already-queued URLs are silently ignored.',
  parameters: z.object({
    urls: z.array(z.string()),
    depth: z.number().int().min(0).default(1),
    parentFeatureId: z.string().optional(),
  }),
  execute: async ({ urls, depth, parentFeatureId }) => {
    const before = _queue.length
    for (const u of urls) bfsEnqueue(u, depth, parentFeatureId)
    return { added: _queue.length - before, queueLength: _queue.length }
  },
})

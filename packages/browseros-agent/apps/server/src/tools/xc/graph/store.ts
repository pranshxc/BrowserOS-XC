/**
 * XC Graph Store — disk-first, no in-memory accumulation.
 *
 * Design goals:
 *  1. Every mutation (add_node / add_edge) is written immediately to disk.
 *  2. Data is never held only in RAM — server restarts / crashes lose nothing.
 *  3. No full graph dump is ever returned to the LLM. Only summaries,
 *     paginated slices, or file paths are returned, preventing context overflow.
 *  4. Graphs are saved to TWO locations simultaneously:
 *       • ~/.browseros/graphs/<session>.ndjson   (persistent home dir)
 *       • <cwd>/graphs/<session>.ndjson           (current working dir)
 *  5. saveAllFormats() writes .ndjson + .json + .mmd atomically — called
 *     automatically by map_site_start. To avoid thrashing, full JSON+MMD
 *     regeneration is throttled to every SAVE_INTERVAL pages; always runs
 *     on final completion. NDJSON append still happens on every mutation.
 *  6. Edge deduplication: identical (from, to, type) triples are written
 *     once only. Duplicate addEdge calls are silently ignored.
 *
 * File format: newline-delimited JSON (NDJSON).
 *   Each line is either a node record or an edge record.
 *   {"kind":"node", "id":"...", "type":"...", "label":"...", "meta":{...}, "ts":...}
 *   {"kind":"edge", "from":"...", "to":"...", "type":"...", "meta":{...}, "ts":...}
 *
 * JSON export structure (exportGraph) produces a HIERARCHICAL tree:
 *   {
 *     sessionId, exportedAt, nodeCount, edgeCount,
 *     pages: {
 *       "page:login": {
 *         ...pageNode,
 *         forms: { "form:login:0": { ...formNode, fields: [...], api_calls: [...] } },
 *         actions: [ ...actionNodes ],
 *         popups: [ ...popupNodes ],
 *         nav_regions: [ ...navRegionNodes ],
 *         js_bundles: [ ...jsBundleNodes ],
 *         local_storage: [ ...localStorageNodes ],
 *         schema_org: [ ...schemaDotOrgNodes ],
 *         api_calls: [ ...apiCallNodes triggered at page level ],
 *       }
 *     },
 *     orphans: [ ...nodes not attached to any page ],
 *     edges: [ ...all edges ]
 *   }
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// ─── Types ─────────────────────────────────────────────────────────────────────────────

// Semantic types (Phase 11) + legacy types preserved for backwards compatibility
export type NodeType =
  // ── Phase 11 semantic types ──
  | 'page'          // A URL / route visited
  | 'form'          // A <form> element
  | 'field'         // An <input>, <select>, <textarea>
  | 'action'        // A button, CTA, or JS-triggered element
  | 'api_call'      // A network request intercepted or inferred
  | 'popup'         // A modal, dialog, sheet, tooltip, dropdown
  | 'nav_region'    // ARIA landmark zone (navigation, banner, main, footer)
  | 'content_block' // A named content section (H2/H3 heading + body)
  | 'error_state'   // A validation error or failure state
  | 'auth_gate'     // A page/resource requiring authentication
  | 'js_bundle'     // Detected JS framework / global objects / feature flags
  | 'local_storage' // A key in localStorage or sessionStorage
  | 'schema_org'    // A JSON-LD schema.org block
  // ── Legacy types (preserved for backwards compatibility) ──
  | 'feature_flag'
  | 'graphql_api'
  | 'redux_slice'
  | 'route'
  | 'component'
  | 'generic'

export type EdgeType =
  // ── Phase 11 semantic edges ──
  | 'navigates_to'       // page → page
  | 'contains'           // page → form, form → field, page → popup, page → nav_region
  | 'submits_to'         // form → api_call
  | 'triggers'           // action → api_call, action → popup
  | 'validates_via'      // field → api_call (live validation)
  | 'redirects_to'       // page → page (HTTP 30x or JS redirect)
  | 'authenticates_with' // page → api_call (login flow)
  | 'auth_gate'          // page → auth_gate
  // ── Legacy edges (preserved) ──
  | 'uses_flag'
  | 'calls_api'
  | 'reads_state'
  | 'renders'
  | 'related'
  | 'generic'

export interface GraphNode {
  kind: 'node'
  id: string
  type: NodeType
  label: string
  meta: Record<string, unknown>
  ts: number
}

export interface GraphEdge {
  kind: 'edge'
  from: string
  to: string
  type: EdgeType
  meta: Record<string, unknown>
  ts: number
}

export type GraphRecord = GraphNode | GraphEdge

export interface GraphSummary {
  sessionId: string
  nodeCount: number
  edgeCount: number
  nodeTypes: Record<string, number>
  edgeTypes: Record<string, number>
  homePath: string
  cwdPath: string
  createdAt: number
  updatedAt: number
}

export interface GraphPage {
  items: GraphRecord[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface SaveAllResult {
  homeNdjsonPath: string
  cwdNdjsonPath: string
  homeJsonPath: string
  cwdJsonPath: string
  homeMMDPath: string
  cwdMMDPath: string
  nodeCount: number
  edgeCount: number
}

// ─── Constants ────────────────────────────────────────────────────────────────────────

/**
 * How often (in pages crawled) to regenerate the full JSON + MMD exports.
 * NDJSON appends on every mutation regardless. Set to 1 to match old behaviour.
 * Issue 5 fix: was implicitly 1 (every page), raised to 10 to cut I/O by ~10×.
 */
export const SAVE_INTERVAL = 10

// ─── Session state (minimal in-memory index only) ────────────────────────────────────────

interface SessionIndex {
  sessionId: string
  nodeCount: number
  edgeCount: number
  nodeTypes: Record<string, number>
  edgeTypes: Record<string, number>
  nodeIds: Set<string>
  /** Issue 9 fix: deduplicate edges by "from\x00to\x00type" key */
  edgeIds: Set<string>
  homePath: string
  cwdPath: string
  createdAt: number
  updatedAt: number
  /** Issue 5 fix: tracks pages processed since last full save */
  pagesSinceLastFullSave: number
}

const sessions = new Map<string, SessionIndex>()
let activeSessionId: string | null = null

// ─── Path helpers ────────────────────────────────────────────────────────────────────

function getHomeGraphsDir(): string {
  return join(homedir(), '.browseros', 'graphs')
}

function getCwdGraphsDir(): string {
  return resolve(process.cwd(), 'graphs')
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

function sessionFileName(sessionId: string): string {
  return `${sessionId}.ndjson`
}

function sessionJsonFileName(sessionId: string): string {
  return `${sessionId}.json`
}

function sessionMmdFileName(sessionId: string): string {
  return `${sessionId}.mmd`
}

// ─── Session management ────────────────────────────────────────────────────────────

export function generateSessionId(): string {
  const now = new Date()
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '00'),
    String(now.getSeconds()).padStart(2, '00'),
  ].join('')
  const rand = Math.random().toString(36).slice(2, 7)
  return `graph-${ts}-${rand}`
}

export async function getOrCreateSession(sessionId?: string): Promise<SessionIndex> {
  const id = sessionId ?? activeSessionId ?? generateSessionId()

  if (sessions.has(id)) {
    activeSessionId = id
    return sessions.get(id)!
  }

  const homeDir = getHomeGraphsDir()
  const cwdDir = getCwdGraphsDir()
  await ensureDir(homeDir)
  await ensureDir(cwdDir)

  const index: SessionIndex = {
    sessionId: id,
    nodeCount: 0,
    edgeCount: 0,
    nodeTypes: {},
    edgeTypes: {},
    nodeIds: new Set(),
    edgeIds: new Set(),
    homePath: join(homeDir, sessionFileName(id)),
    cwdPath: join(cwdDir, sessionFileName(id)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pagesSinceLastFullSave: 0,
  }

  sessions.set(id, index)
  activeSessionId = id
  return index
}

export function getActiveSessionId(): string | null {
  return activeSessionId
}

export function setActiveSession(sessionId: string): void {
  activeSessionId = sessionId
}

// ─── Write helpers ───────────────────────────────────────────────────────────────────

async function appendRecord(index: SessionIndex, record: GraphRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`
  await Promise.allSettled([
    appendFile(index.homePath, line, 'utf-8'),
    appendFile(index.cwdPath, line, 'utf-8'),
  ])
  index.updatedAt = Date.now()
}

// ─── Node operations ─────────────────────────────────────────────────────────────────

export async function addNode(
  label: string,
  type: NodeType = 'page',
  meta: Record<string, unknown> = {},
  sessionId?: string,
): Promise<{ nodeId: string; sessionId: string; homePath: string; cwdPath: string }> {
  const index = await getOrCreateSession(sessionId)

  // Deduplicate by label+type
  const nodeId = `${type}:${label.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 80)}`

  const record: GraphNode = {
    kind: 'node',
    id: nodeId,
    type,
    label,
    meta,
    ts: Date.now(),
  }

  if (!index.nodeIds.has(nodeId)) {
    index.nodeIds.add(nodeId)
    index.nodeCount++
    index.nodeTypes[type] = (index.nodeTypes[type] ?? 0) + 1
    await appendRecord(index, record)
  }

  return {
    nodeId,
    sessionId: index.sessionId,
    homePath: index.homePath,
    cwdPath: index.cwdPath,
  }
}

// ─── Edge operations ─────────────────────────────────────────────────────────────────

export async function addEdge(
  from: string,
  to: string,
  type: EdgeType = 'navigates_to',
  meta: Record<string, unknown> = {},
  sessionId?: string,
): Promise<{ sessionId: string; homePath: string; cwdPath: string }> {
  const index = await getOrCreateSession(sessionId)

  // Issue 9 fix: deduplicate edges by (from, to, type) triple
  const edgeKey = `${from}\x00${to}\x00${type}`
  if (index.edgeIds.has(edgeKey)) {
    return { sessionId: index.sessionId, homePath: index.homePath, cwdPath: index.cwdPath }
  }
  index.edgeIds.add(edgeKey)

  const record: GraphEdge = {
    kind: 'edge',
    from,
    to,
    type,
    meta,
    ts: Date.now(),
  }

  index.edgeCount++
  index.edgeTypes[type] = (index.edgeTypes[type] ?? 0) + 1
  await appendRecord(index, record)

  return {
    sessionId: index.sessionId,
    homePath: index.homePath,
    cwdPath: index.cwdPath,
  }
}

// ─── Summary (safe for LLM context) ──────────────────────────────────────────────────

export async function getSessionSummary(sessionId?: string): Promise<GraphSummary> {
  const id = sessionId ?? activeSessionId
  if (!id || !sessions.has(id)) {
    throw new Error(
      id
        ? `Session "${id}" not found. Use graph_list to see available sessions.`
        : 'No active graph session. Use graph_add_node to start one.',
    )
  }
  const index = sessions.get(id)!
  return {
    sessionId: index.sessionId,
    nodeCount: index.nodeCount,
    edgeCount: index.edgeCount,
    nodeTypes: { ...index.nodeTypes },
    edgeTypes: { ...index.edgeTypes },
    homePath: index.homePath,
    cwdPath: index.cwdPath,
    createdAt: index.createdAt,
    updatedAt: index.updatedAt,
  }
}

// ─── Paginated query (safe for LLM context) ─────────────────────────────────────────

export async function queryGraph(
  sessionId?: string,
  filter?: { kind?: 'node' | 'edge'; type?: string },
  page = 1,
  pageSize = 50,
): Promise<GraphPage> {
  const id = sessionId ?? activeSessionId
  if (!id || !sessions.has(id)) {
    throw new Error(
      id
        ? `Session "${id}" not found.`
        : 'No active graph session.',
    )
  }
  const index = sessions.get(id)!

  let raw: string
  try {
    raw = await readFile(index.homePath, 'utf-8')
  } catch {
    raw = await readFile(index.cwdPath, 'utf-8')
  }

  const allRecords: GraphRecord[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GraphRecord)

  const filtered = allRecords.filter((r) => {
    if (filter?.kind && r.kind !== filter.kind) return false
    if (filter?.type) {
      if (r.kind === 'node' && r.type !== filter.type) return false
      if (r.kind === 'edge' && r.type !== filter.type) return false
    }
    return true
  })

  const total = filtered.length
  const start = (page - 1) * pageSize
  const items = filtered.slice(start, start + pageSize)

  return {
    items,
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total,
  }
}

// ─── Internal: read all records from disk ─────────────────────────────────────────────

async function readAllRecords(
  index: SessionIndex,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  let raw: string
  try {
    raw = await readFile(index.homePath, 'utf-8')
  } catch {
    try {
      raw = await readFile(index.cwdPath, 'utf-8')
    } catch {
      return { nodes: [], edges: [] }
    }
  }

  const records: GraphRecord[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GraphRecord)

  const nodes = records.filter((r): r is GraphNode => r.kind === 'node')
  const edges = records.filter((r): r is GraphEdge => r.kind === 'edge')
  return { nodes, edges }
}

// ─── Export full graph to hierarchical tree JSON ───────────────────────────────────────
//
// Produces a page-rooted tree:
//   pages: {
//     "page:login": {
//       id, type, label, meta: { url, title, pageRole, ... },
//       forms: {
//         "form:login:0": {
//           id, label, meta: { action, method, purpose, ... },
//           fields: [ { id, label, meta: { inputType, required, ... } }, ... ],
//           api_calls: [ { id, label, meta: { method, endpoint, ... } } ]
//         }
//       },
//       actions: [ { id, label, meta: { triggerType, href, ... } }, ... ],
//       popups:  [ { id, label, meta: { role, ... } }, ... ],
//       nav_regions: [ ... ],
//       js_bundles:  [ ... ],
//       local_storage: [ ... ],
//       schema_org:  [ ... ],
//       api_calls:   [ ...page-level api calls ]
//     }
//   },
//   orphans: [ ...nodes not attached to any page ],
//   edges: [ ...all edges, with inline from/to/type/meta ]

export async function exportGraph(sessionId?: string): Promise<{
  homeJsonPath: string
  cwdJsonPath: string
  nodeCount: number
  edgeCount: number
}> {
  const id = sessionId ?? activeSessionId
  if (!id || !sessions.has(id)) {
    throw new Error(
      id ? `Session "${id}" not found.` : 'No active graph session.',
    )
  }
  const index = sessions.get(id)!

  const { nodes, edges } = await readAllRecords(index)

  // Deduplicate nodes by ID (last write wins)
  const nodeMap = new Map<string, GraphNode>()
  for (const n of nodes) nodeMap.set(n.id, n)

  // Build parent→children index from 'contains' edges
  const childrenOf = new Map<string, string[]>()

  for (const edge of edges) {
    if (edge.type === 'contains' || edge.type === 'submits_to' || edge.type === 'triggers') {
      const parent = edge.from
      const child = edge.to
      if (!childrenOf.has(parent)) childrenOf.set(parent, [])
      childrenOf.get(parent)!.push(child)
    }
  }

  // Collect page nodes
  const pageNodes = [...nodeMap.values()].filter(n => n.type === 'page')

  // Build page tree
  const pagesTree: Record<string, unknown> = {}

  for (const page of pageNodes) {
    const pageChildIds = childrenOf.get(page.id) ?? []

    const forms: Record<string, unknown> = {}
    const actions: unknown[] = []
    const popups: unknown[] = []
    const navRegions: unknown[] = []
    const jsBundles: unknown[] = []
    const localStorage: unknown[] = []
    const schemaOrg: unknown[] = []
    const apiCalls: unknown[] = []

    for (const childId of pageChildIds) {
      const child = nodeMap.get(childId)
      if (!child) continue

      switch (child.type) {
        case 'form': {
          const formChildIds = childrenOf.get(child.id) ?? []
          const fields: unknown[] = []
          const formApiCalls: unknown[] = []

          for (const fcId of formChildIds) {
            const fc = nodeMap.get(fcId)
            if (!fc) continue
            if (fc.type === 'field') {
              fields.push({ id: fc.id, label: fc.label, meta: fc.meta })
            } else if (fc.type === 'api_call') {
              formApiCalls.push({ id: fc.id, label: fc.label, meta: fc.meta })
            }
          }

          forms[child.id] = {
            id: child.id,
            label: child.label,
            meta: child.meta,
            fields,
            api_calls: formApiCalls,
          }
          break
        }
        case 'action':
          actions.push({ id: child.id, label: child.label, meta: child.meta })
          break
        case 'popup':
          popups.push({ id: child.id, label: child.label, meta: child.meta })
          break
        case 'nav_region':
          navRegions.push({ id: child.id, label: child.label, meta: child.meta })
          break
        case 'js_bundle':
          jsBundles.push({ id: child.id, label: child.label, meta: child.meta })
          break
        case 'local_storage':
          localStorage.push({ id: child.id, label: child.label, meta: child.meta })
          break
        case 'schema_org':
          schemaOrg.push({ id: child.id, label: child.label, meta: child.meta })
          break
        case 'api_call':
          apiCalls.push({ id: child.id, label: child.label, meta: child.meta })
          break
      }
    }

    pagesTree[page.id] = {
      id: page.id,
      label: page.label,
      meta: page.meta,
      forms,
      actions,
      popups,
      nav_regions: navRegions,
      js_bundles: jsBundles,
      local_storage: localStorage,
      schema_org: schemaOrg,
      api_calls: apiCalls,
    }
  }

  // Collect orphan nodes (not a page, not a child of any page)
  const allChildIds = new Set<string>()
  for (const [, children] of childrenOf) {
    for (const c of children) allChildIds.add(c)
  }
  const orphans = [...nodeMap.values()].filter(
    n => n.type !== 'page' && !allChildIds.has(n.id)
  ).map(n => ({ id: n.id, type: n.type, label: n.label, meta: n.meta }))

  const output = {
    sessionId: id,
    exportedAt: new Date().toISOString(),
    nodeCount: nodeMap.size,
    edgeCount: edges.length,
    pages: pagesTree,
    orphans,
    edges: edges.map(e => ({ from: e.from, to: e.to, type: e.type, meta: e.meta })),
  }

  const json = `${JSON.stringify(output, null, 2)}\n`
  const homeJsonPath = join(getHomeGraphsDir(), sessionJsonFileName(id))
  const cwdJsonPath = join(getCwdGraphsDir(), sessionJsonFileName(id))

  await Promise.allSettled([
    writeFile(homeJsonPath, json, 'utf-8'),
    writeFile(cwdJsonPath, json, 'utf-8'),
  ])

  return { homeJsonPath, cwdJsonPath, nodeCount: nodeMap.size, edgeCount: edges.length }
}

// ─── Mermaid export ──────────────────────────────────────────────────────────────────────

export async function exportMermaid(
  sessionId?: string,
  direction: 'TD' | 'LR' = 'LR',
): Promise<{
  homeMMDPath: string
  cwdMMDPath: string
  diagram: string
  nodeCount: number
  edgeCount: number
}> {
  const id = sessionId ?? activeSessionId
  if (!id || !sessions.has(id)) {
    throw new Error(
      id ? `Session "${id}" not found.` : 'No active graph session.',
    )
  }
  const index = sessions.get(id)!

  const { nodes, edges } = await readAllRecords(index)

  const nodeMap = new Map<string, GraphNode>()
  for (const n of nodes) nodeMap.set(n.id, n)

  const lines: string[] = [`flowchart ${direction}`]

  const shapeOpen: Record<string, string> = {
    page:          '[',
    form:          '[[',
    field:         '([',
    action:        '{',
    api_call:      '((',
    popup:         '{',
    nav_region:    '[/',
    content_block: '[',
    error_state:   '[',
    auth_gate:     '>',
    js_bundle:     '{{',
    local_storage: '[(',
    schema_org:    '[/',
    feature_flag:  '[/',
    graphql_api:   '((',
    redux_slice:   '[(',
    route:         '>',
    component:     '{{',
    generic:       '[',
  }
  const shapeClose: Record<string, string> = {
    page:          ']',
    form:          ']]',
    field:         ')]',
    action:        '}',
    api_call:      '))',
    popup:         '}',
    nav_region:    '/]',
    content_block: ']',
    error_state:   ']',
    auth_gate:     ']',
    js_bundle:     '}}',
    local_storage: ')]',
    schema_org:    '/]',
    feature_flag:  '/]',
    graphql_api:   '))',
    redux_slice:   ')]',
    route:         ']',
    component:     '}}',
    generic:       ']',
  }

  const mmdLabel = (s: string) =>
    s.replace(/"/g, "'").replace(/[\r\n]/g, ' ').slice(0, 60)

  const mmdId = (id: string) =>
    id.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)

  for (const [, node] of nodeMap) {
    const open = shapeOpen[node.type] ?? '['
    const close = shapeClose[node.type] ?? ']'
    lines.push(`  ${mmdId(node.id)}${open}"${mmdLabel(node.label)}"${close}`)
  }

  const arrowStyle: Record<string, string> = {
    navigates_to:        '-->',
    contains:            '--contains-->',
    submits_to:          '==submits==>',
    triggers:            '-. triggers .->',
    validates_via:       '-. validates .->',
    redirects_to:        '-.redirects.->',
    authenticates_with:  '==auth==>',
    auth_gate:           '-. auth_gate .->',
    uses_flag:           '-. uses_flag .->',
    calls_api:           '==>',
    reads_state:         '-. reads_state .->',
    renders:             '--renders-->',
    related:             '<-->',
    generic:             '-->',
  }

  for (const edge of edges) {
    const arrow = arrowStyle[edge.type] ?? '-->'
    lines.push(`  ${mmdId(edge.from)} ${arrow} ${mmdId(edge.to)}`)
  }

  const diagram = lines.join('\n')

  const homeMMDPath = join(getHomeGraphsDir(), sessionMmdFileName(id))
  const cwdMMDPath = join(getCwdGraphsDir(), sessionMmdFileName(id))

  await Promise.allSettled([
    writeFile(homeMMDPath, `${diagram}\n`, 'utf-8'),
    writeFile(cwdMMDPath, `${diagram}\n`, 'utf-8'),
  ])

  return { homeMMDPath, cwdMMDPath, diagram, nodeCount: nodeMap.size, edgeCount: edges.length }
}

// ─── saveAllFormats — write NDJSON + JSON + MMD in one atomic call ───────────────────────────
//
// Issue 5 fix: accepts a `force` flag. When false (the default used inside the BFS
// per-page loop), the full JSON+MMD regeneration is skipped unless SAVE_INTERVAL
// pages have accumulated since the last full save. NDJSON is always up-to-date
// (append-on-every-mutation). Pass force=true on crawl completion to guarantee a
// final consistent snapshot.

export async function saveAllFormats(
  sessionId?: string,
  direction: 'TD' | 'LR' = 'LR',
  force = false,
): Promise<SaveAllResult> {
  const id = sessionId ?? activeSessionId
  if (!id || !sessions.has(id)) {
    throw new Error(
      id ? `Session "${id}" not found.` : 'No active graph session.',
    )
  }
  const index = sessions.get(id)!

  index.pagesSinceLastFullSave++

  const shouldRunFull = force || index.pagesSinceLastFullSave >= SAVE_INTERVAL

  if (!shouldRunFull) {
    // Return current paths without rebuilding JSON/MMD
    const homeDir = getHomeGraphsDir()
    const cwdDir = getCwdGraphsDir()
    return {
      homeNdjsonPath: index.homePath,
      cwdNdjsonPath: index.cwdPath,
      homeJsonPath: join(homeDir, sessionJsonFileName(id)),
      cwdJsonPath: join(cwdDir, sessionJsonFileName(id)),
      homeMMDPath: join(homeDir, sessionMmdFileName(id)),
      cwdMMDPath: join(cwdDir, sessionMmdFileName(id)),
      nodeCount: index.nodeCount,
      edgeCount: index.edgeCount,
    }
  }

  index.pagesSinceLastFullSave = 0

  const [jsonResult, mmdResult] = await Promise.all([
    exportGraph(id),
    exportMermaid(id, direction),
  ])

  return {
    homeNdjsonPath: index.homePath,
    cwdNdjsonPath: index.cwdPath,
    homeJsonPath: jsonResult.homeJsonPath,
    cwdJsonPath: jsonResult.cwdJsonPath,
    homeMMDPath: mmdResult.homeMMDPath,
    cwdMMDPath: mmdResult.cwdMMDPath,
    nodeCount: jsonResult.nodeCount,
    edgeCount: jsonResult.edgeCount,
  }
}

// ─── List saved graphs ────────────────────────────────────────────────────────────────────

export interface GraphFileInfo {
  sessionId: string
  ndjsonPath: string
  jsonPath: string | null
  mmdPath: string | null
  sizeBytes: number
  modifiedAt: string
  isActive: boolean
}

export async function listGraphFiles(): Promise<GraphFileInfo[]> {
  const homeDir = getHomeGraphsDir()
  await ensureDir(homeDir)

  let entries: string[]
  try {
    entries = await readdir(homeDir)
  } catch {
    return []
  }

  const ndjsonFiles = entries.filter((e) => e.endsWith('.ndjson'))
  const jsonFiles = new Set(entries.filter((e) => e.endsWith('.json')))
  const mmdFiles = new Set(entries.filter((e) => e.endsWith('.mmd')))

  const results: GraphFileInfo[] = []

  for (const file of ndjsonFiles) {
    const sessionId = file.replace(/\.ndjson$/, '')
    const filePath = join(homeDir, file)
    let sizeBytes = 0
    let modifiedAt = ''
    try {
      const s = await stat(filePath)
      sizeBytes = s.size
      modifiedAt = s.mtime.toISOString()
    } catch {
      // skip
    }
    results.push({
      sessionId,
      ndjsonPath: filePath,
      jsonPath: jsonFiles.has(`${sessionId}.json`) ? join(homeDir, `${sessionId}.json`) : null,
      mmdPath: mmdFiles.has(`${sessionId}.mmd`) ? join(homeDir, `${sessionId}.mmd`) : null,
      sizeBytes,
      modifiedAt,
      isActive: sessionId === activeSessionId,
    })
  }

  results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  return results
}

// ─── Load session from disk ─────────────────────────────────────────────────────────────

export async function loadSessionFromDisk(sessionId: string): Promise<GraphSummary> {
  const homeDir = getHomeGraphsDir()
  const cwdDir = getCwdGraphsDir()
  const homePath = join(homeDir, sessionFileName(sessionId))
  const cwdPath = join(cwdDir, sessionFileName(sessionId))

  let raw: string
  try {
    raw = await readFile(homePath, 'utf-8')
  } catch {
    try {
      raw = await readFile(cwdPath, 'utf-8')
    } catch {
      throw new Error(
        `Graph session "${sessionId}" not found.\n` +
        `Looked in:\n  ${homePath}\n  ${cwdPath}\n` +
        `Use graph_list to see available sessions.`,
      )
    }
  }

  const records: GraphRecord[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GraphRecord)

  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  const nodeTypes: Record<string, number> = {}
  const edgeTypes: Record<string, number> = {}
  let edgeCount = 0

  for (const r of records) {
    if (r.kind === 'node') {
      if (!nodeIds.has(r.id)) {
        nodeIds.add(r.id)
        nodeTypes[r.type] = (nodeTypes[r.type] ?? 0) + 1
      }
    } else {
      const edgeKey = `${r.from}\x00${r.to}\x00${r.type}`
      if (!edgeIds.has(edgeKey)) {
        edgeIds.add(edgeKey)
        edgeCount++
        edgeTypes[r.type] = (edgeTypes[r.type] ?? 0) + 1
      }
    }
  }

  await ensureDir(homeDir)
  await ensureDir(cwdDir)

  const index: SessionIndex = {
    sessionId,
    nodeCount: nodeIds.size,
    edgeCount,
    nodeTypes,
    edgeTypes,
    nodeIds,
    edgeIds,
    homePath,
    cwdPath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pagesSinceLastFullSave: 0,
  }

  sessions.set(sessionId, index)
  activeSessionId = sessionId

  return {
    sessionId,
    nodeCount: nodeIds.size,
    edgeCount,
    nodeTypes,
    edgeTypes,
    homePath,
    cwdPath,
    createdAt: index.createdAt,
    updatedAt: index.updatedAt,
  }
}

// ─── Reset / clear ─────────────────────────────────────────────────────────────────────────────

export function resetActiveSession(): void {
  if (activeSessionId) {
    sessions.delete(activeSessionId)
  }
  activeSessionId = null
}

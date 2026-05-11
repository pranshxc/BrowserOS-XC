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
 *
 * File format: newline-delimited JSON (NDJSON).
 *   Each line is either a node record or an edge record.
 *   {"kind":"node", "id":"...", "type":"...", "label":"...", "meta":{...}, "ts":...}
 *   {"kind":"edge", "from":"...", "to":"...", "type":"...", "meta":{...}, "ts":...}
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

export type NodeType =
  | 'page'
  | 'feature_flag'
  | 'graphql_api'
  | 'redux_slice'
  | 'route'
  | 'component'
  | 'generic'

export type EdgeType =
  | 'navigates_to'
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

// ─── Session state (minimal in-memory index only) ────────────────────────────

interface SessionIndex {
  sessionId: string
  nodeCount: number
  edgeCount: number
  nodeTypes: Record<string, number>
  edgeTypes: Record<string, number>
  nodeIds: Set<string>
  homePath: string
  cwdPath: string
  createdAt: number
  updatedAt: number
}

const sessions = new Map<string, SessionIndex>()
let activeSessionId: string | null = null

// ─── Path helpers ────────────────────────────────────────────────────────────

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

// ─── Session management ──────────────────────────────────────────────────────

export function generateSessionId(): string {
  const now = new Date()
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
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
    homePath: join(homeDir, sessionFileName(id)),
    cwdPath: join(cwdDir, sessionFileName(id)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

// ─── Write helpers ────────────────────────────────────────────────────────────

async function appendRecord(index: SessionIndex, record: GraphRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`
  // Write to both paths concurrently; never fail the mutation if one write fails
  await Promise.allSettled([
    appendFile(index.homePath, line, 'utf-8'),
    appendFile(index.cwdPath, line, 'utf-8'),
  ])
  index.updatedAt = Date.now()
}

// ─── Node operations ─────────────────────────────────────────────────────────

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

// ─── Edge operations ─────────────────────────────────────────────────────────

export async function addEdge(
  from: string,
  to: string,
  type: EdgeType = 'navigates_to',
  meta: Record<string, unknown> = {},
  sessionId?: string,
): Promise<{ sessionId: string; homePath: string; cwdPath: string }> {
  const index = await getOrCreateSession(sessionId)

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

// ─── Summary (safe for LLM context) ──────────────────────────────────────────

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

// ─── Paginated query (safe for LLM context) ──────────────────────────────────

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

  // Read from disk (source of truth)
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

// ─── Export full graph to JSON file ──────────────────────────────────────────

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

  let raw: string
  try {
    raw = await readFile(index.homePath, 'utf-8')
  } catch {
    raw = await readFile(index.cwdPath, 'utf-8')
  }

  const records: GraphRecord[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GraphRecord)

  const nodes = records.filter((r): r is GraphNode => r.kind === 'node')
  const edges = records.filter((r): r is GraphEdge => r.kind === 'edge')

  const output = {
    sessionId: id,
    exportedAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
  }

  const json = `${JSON.stringify(output, null, 2)}\n`
  const homeJsonPath = join(getHomeGraphsDir(), sessionJsonFileName(id))
  const cwdJsonPath = join(getCwdGraphsDir(), sessionJsonFileName(id))

  await Promise.allSettled([
    writeFile(homeJsonPath, json, 'utf-8'),
    writeFile(cwdJsonPath, json, 'utf-8'),
  ])

  return { homeJsonPath, cwdJsonPath, nodeCount: nodes.length, edgeCount: edges.length }
}

// ─── Mermaid export ───────────────────────────────────────────────────────────

export async function exportMermaid(sessionId?: string, direction: 'TD' | 'LR' = 'LR'): Promise<{
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

  let raw: string
  try {
    raw = await readFile(index.homePath, 'utf-8')
  } catch {
    raw = await readFile(index.cwdPath, 'utf-8')
  }

  const records: GraphRecord[] = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GraphRecord)

  const nodes = records.filter((r): r is GraphNode => r.kind === 'node')
  const edges = records.filter((r): r is GraphEdge => r.kind === 'edge')

  // Build a deduplicated node map (last write wins for label)
  const nodeMap = new Map<string, GraphNode>()
  for (const n of nodes) nodeMap.set(n.id, n)

  const lines: string[] = [`flowchart ${direction}`]

  // Node type → Mermaid shape
  const shapeOpen: Record<NodeType, string> = {
    page: '[',
    feature_flag: '[/',
    graphql_api: '([',
    redux_slice: '[(',
    route: '>',
    component: '{{',
    generic: '[',
  }
  const shapeClose: Record<NodeType, string> = {
    page: ']',
    feature_flag: '/]',
    graphql_api: ')]',
    redux_slice: ')]',
    route: ']',
    component: '}}',
    generic: ']',
  }

  // Sanitise label for Mermaid (no quotes, max 60 chars)
  const mmdLabel = (s: string) =>
    s.replace(/"/g, "'").replace(/[\r\n]/g, ' ').slice(0, 60)

  // Safe node id for Mermaid (alphanumeric + underscore only)
  const mmdId = (id: string) =>
    id.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)

  for (const [, node] of nodeMap) {
    const open = shapeOpen[node.type] ?? '['
    const close = shapeClose[node.type] ?? ']'
    lines.push(`  ${mmdId(node.id)}${open}"${mmdLabel(node.label)}"${close}`)
  }

  // Edge type → Mermaid arrow style
  const arrowStyle: Record<EdgeType, string> = {
    navigates_to: '-->',
    uses_flag: '-. uses_flag .->',
    calls_api: '==>',
    reads_state: '-. reads_state .->',
    renders: '--renders-->',
    related: '<-->',
    generic: '-->',
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

// ─── List saved graphs ────────────────────────────────────────────────────────

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

// ─── Load session from disk ───────────────────────────────────────────────────

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
      edgeCount++
      edgeTypes[r.type] = (edgeTypes[r.type] ?? 0) + 1
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
    homePath,
    cwdPath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

// ─── Reset / clear ────────────────────────────────────────────────────────────

export function resetActiveSession(): void {
  if (activeSessionId) {
    sessions.delete(activeSessionId)
  }
  activeSessionId = null
}

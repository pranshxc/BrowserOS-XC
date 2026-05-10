/**
 * XC Phase 10 — Graph Store
 *
 * In-memory graph with file persistence, deduplication, merge logic,
 * and multi-format export.
 *
 * Architecture
 * ────────────
 * The store is a singleton Map<nodeId, AnyNode> + Map<edgeId, DependencyEdge>.
 * A single graph session is maintained; call initSession() to start fresh.
 *
 * Deduplication
 * ─────────────
 * Node IDs are deterministic: sha256(type + primaryKey) truncated to 12 hex chars.
 * Primary keys by type:
 *   page          → normalized URL path
 *   feature       → lowercase(name)
 *   workflow      → lowercase(name)
 *   api_endpoint  → method.toUpperCase() + '|' + normalizeUrlPattern(urlPattern)
 *   ui_component  → framework + '|' + name
 *   storage       → storageType + '|' + key
 *   worker        → scriptUrl
 *
 * Merge logic (when adding a node with an existing ID)
 * ───────────────────────────────────────────────────────
 *   arrays  → union merge (deduplicated)
 *   strings → longer/non-empty wins
 *   numbers → confidence: max; timing: average
 *   booleans → OR (true wins)
 *   objects → recursive merge
 *   evidence → union, capped at 20 items
 *
 * Export formats
 * ─────────────
 *   json      → full GraphSnapshot as JSON (for programmatic consumption)
 *   jsonld    → JSON-LD with @context (for knowledge base ingestion)
 *   graphml   → GraphML XML (for Gephi, Cytoscape, yEd)
 *   mermaid   → Mermaid flowchart (for AI readback + docs)
 *   summary   → plain text summary for pasting into LLM context
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  AnyNode,
  APIEndpointNode,
  DependencyEdge,
  EdgeType,
  FeatureNode,
  GraphSession,
  GraphSnapshot,
  GraphStats,
  MappingConfig,
  NodeType,
  PageNode,
  StorageNode,
  UIComponentNode,
  WorkerNode,
  WorkflowNode,
} from './schema'
import { JSON_LD_CONTEXT } from './schema'

// ── ID generation ─────────────────────────────────────────────────────────────────

function stableId(type: string, primaryKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`${type}|${primaryKey.toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 16)
}

export function nodeId(node: Omit<AnyNode, 'id'>): string {
  switch (node.type) {
    case 'page': return stableId('page', (node as Omit<PageNode, 'id'>).path)
    case 'feature': return stableId('feature', (node as Omit<FeatureNode, 'id'>).name)
    case 'workflow': return stableId('workflow', (node as Omit<WorkflowNode, 'id'>).name)
    case 'api_endpoint': {
      const n = node as Omit<APIEndpointNode, 'id'>
      const key = `${n.method.toUpperCase()}|${n.urlPattern.replace(/:[^/]+/g, ':param').replace(/\{[^}]+\}/g, ':param')}`
      return stableId('api', key)
    }
    case 'ui_component': {
      const n = node as Omit<UIComponentNode, 'id'>
      return stableId('component', `${n.framework}|${n.name}`)
    }
    case 'storage': {
      const n = node as Omit<StorageNode, 'id'>
      return stableId('storage', `${n.storageType}|${n.key}`)
    }
    case 'worker': return stableId('worker', (node as Omit<WorkerNode, 'id'>).scriptUrl)
    default: return stableId('unknown', JSON.stringify(node).slice(0, 64))
  }
}

export function edgeId(from: string, to: string, type: EdgeType): string {
  return stableId('edge', `${from}|${to}|${type}`)
}

// ── Deep merge ───────────────────────────────────────────────────────────────────

function mergeArrays<T>(a: T[], b: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of [...a, ...b]) {
    const key = typeof item === 'object' ? JSON.stringify(item) : String(item)
    if (!seen.has(key)) { seen.add(key); result.push(item) }
  }
  return result
}

function mergeNodes(existing: AnyNode, incoming: AnyNode): AnyNode {
  const merged: Record<string, unknown> = { ...existing }
  const now = new Date().toISOString()

  for (const [key, inVal] of Object.entries(incoming)) {
    if (key === 'id' || key === 'type') continue
    const exVal = (existing as Record<string, unknown>)[key]

    if (key === 'confidence') {
      merged[key] = Math.max((exVal as number) ?? 0, (inVal as number) ?? 0)
    } else if (key === 'provenance') {
      const ep = exVal as AnyNode['provenance']
      const ip = inVal as AnyNode['provenance']
      merged[key] = {
        ...ep,
        updatedAt: now,
        evidence: mergeArrays(ep.evidence ?? [], ip.evidence ?? []).slice(0, 20),
      }
    } else if (Array.isArray(inVal) && Array.isArray(exVal)) {
      merged[key] = mergeArrays(exVal, inVal)
    } else if (typeof inVal === 'string' && typeof exVal === 'string') {
      merged[key] = inVal.length >= exVal.length ? inVal : exVal
    } else if (typeof inVal === 'boolean') {
      merged[key] = (exVal as boolean) || inVal
    } else if (typeof inVal === 'number' && key !== 'confidence') {
      merged[key] = inVal // take latest for non-confidence numbers
    } else if (inVal !== undefined && inVal !== null && inVal !== '') {
      merged[key] = inVal
    }
  }

  return merged as AnyNode
}

// ── Graph store ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MappingConfig = {
  maxPages: 50,
  maxDepth: 5,
  sameOriginOnly: true,
  skipPatterns: [],
  includeAuthPages: false,
  captureNetwork: true,
  runEvalPresets: true,
}

class GraphStore {
  private nodes: Map<string, AnyNode> = new Map()
  private edges: Map<string, DependencyEdge> = new Map()
  private session: GraphSession | null = null
  private outputDir: string | null = null
  private mutationCount = 0
  private readonly AUTO_SAVE_INTERVAL = 10 // save every N mutations

  // ── Session management ──────────────────────────────────────────────────

  initSession(targetUrl: string, config?: Partial<MappingConfig>, outputDir?: string): GraphSession {
    const id = stableId('session', targetUrl + Date.now())
    this.session = {
      id,
      targetUrl,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'idle',
      frontier: [targetUrl],
      visited: new Set(),
      errors: [],
      config: { ...DEFAULT_CONFIG, ...config, outputDir },
    }
    this.outputDir = outputDir ?? null
    if (outputDir && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }
    return this.session
  }

  getSession(): GraphSession | null { return this.session }

  updateSessionStatus(status: GraphSession['status']): void {
    if (this.session) {
      this.session.status = status
      this.session.updatedAt = new Date().toISOString()
    }
  }

  markVisited(url: string): void {
    if (this.session) {
      this.session.visited.add(url)
      this.session.frontier = this.session.frontier.filter(u => u !== url)
    }
  }

  addToFrontier(urls: string[]): void {
    if (!this.session) return
    const origin = new URL(this.session.targetUrl).origin
    for (const url of urls) {
      try {
        const u = new URL(url)
        if (this.session.config.sameOriginOnly && u.origin !== origin) continue
        const normalized = u.origin + u.pathname
        if (
          !this.session.visited.has(normalized) &&
          !this.session.frontier.includes(normalized) &&
          !this.session.config.skipPatterns.some(p => url.includes(p))
        ) {
          this.session.frontier.push(normalized)
        }
      } catch { /* invalid URL */ }
    }
  }

  recordError(url: string, error: string): void {
    this.session?.errors.push({ url, error, ts: new Date().toISOString() })
  }

  // ── Node CRUD ─────────────────────────────────────────────────────────────

  upsertNode(nodeWithoutId: Omit<AnyNode, 'id'>): { node: AnyNode; wasNew: boolean } {
    const id = nodeId(nodeWithoutId)
    const node = { ...nodeWithoutId, id } as AnyNode
    const existing = this.nodes.get(id)

    if (existing) {
      const merged = mergeNodes(existing, node)
      this.nodes.set(id, merged)
      this.onMutation()
      return { node: merged, wasNew: false }
    } else {
      this.nodes.set(id, node)
      this.onMutation()
      return { node, wasNew: true }
    }
  }

  upsertEdge(from: string, to: string, type: EdgeType, label: string, confidence: number, tool: string, properties?: Record<string, unknown>): { edge: DependencyEdge; wasNew: boolean } {
    const id = edgeId(from, to, type)
    const existing = this.edges.get(id)

    const edge: DependencyEdge = {
      id,
      from,
      to,
      type,
      label,
      confidence: existing ? Math.max(existing.confidence, confidence) : confidence,
      discoveredAt: existing?.discoveredAt ?? new Date().toISOString(),
      tool,
      properties,
    }

    this.edges.set(id, edge)
    this.onMutation()
    return { edge, wasNew: !existing }
  }

  getNode(id: string): AnyNode | undefined { return this.nodes.get(id) }
  getEdge(id: string): DependencyEdge | undefined { return this.edges.get(id) }

  getAllNodes(): AnyNode[] { return [...this.nodes.values()] }
  getAllEdges(): DependencyEdge[] { return [...this.edges.values()] }

  getNodesByType(type: NodeType): AnyNode[] {
    return [...this.nodes.values()].filter(n => n.type === type)
  }

  getEdgesForNode(nodeId: string): { outbound: DependencyEdge[]; inbound: DependencyEdge[] } {
    const outbound = [...this.edges.values()].filter(e => e.from === nodeId)
    const inbound = [...this.edges.values()].filter(e => e.to === nodeId)
    return { outbound, inbound }
  }

  clear(): void {
    this.nodes.clear()
    this.edges.clear()
    this.mutationCount = 0
  }

  // ── Search ────────────────────────────────────────────────────────────────────

  search(query: string, limit = 20): Array<{ node: AnyNode; score: number; matchedFields: string[] }> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const results: Array<{ node: AnyNode; score: number; matchedFields: string[] }> = []

    for (const node of this.nodes.values()) {
      const matchedFields: string[] = []
      let score = 0

      const searchIn = [
        { field: 'summary', value: node.summary, weight: 3 },
        { field: 'tags', value: node.tags.join(' '), weight: 2 },
        { field: 'type', value: node.type, weight: 1 },
        { field: 'notes', value: node.notes ?? '', weight: 1 },
        ...Object.entries(node).map(([k, v]) => ({
          field: k,
          value: typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '',
          weight: 1,
        })),
      ]

      for (const { field, value, weight } of searchIn) {
        if (!value) continue
        const lower = value.toLowerCase()
        for (const term of terms) {
          if (lower.includes(term)) {
            score += weight
            if (!matchedFields.includes(field)) matchedFields.push(field)
          }
        }
      }

      if (score > 0) results.push({ node, score, matchedFields })
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────

  getStats(): GraphStats {
    const nodes = [...this.nodes.values()]
    const edges = [...this.edges.values()]

    const byType = {} as Record<NodeType, number>
    for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1

    const byEdgeType = {} as Record<EdgeType, number>
    for (const e of edges) byEdgeType[e.type] = (byEdgeType[e.type] ?? 0) + 1

    const avgConfidence = nodes.length
      ? nodes.reduce((s, n) => s + n.confidence, 0) / nodes.length
      : 0

    // Compute degree for top connected
    const degree = new Map<string, number>()
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
    }
    const topConnected = [...degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, deg]) => ({
        id,
        summary: this.nodes.get(id)?.summary ?? id,
        degree: deg,
      }))

    // Coverage score: heuristic based on node types present + confidence
    let coverageScore = 0
    if (byType.page > 0) coverageScore += 20
    if (byType.feature > 0) coverageScore += 20
    if (byType.api_endpoint > 0) coverageScore += 20
    if (byType.workflow > 0) coverageScore += 15
    if (byType.ui_component > 0) coverageScore += 10
    if (byType.storage > 0) coverageScore += 10
    if (byType.worker > 0) coverageScore += 5
    coverageScore = Math.round(coverageScore * Math.min(1, avgConfidence + 0.3))

    const session = this.session
    const sessionDurationSec = session
      ? Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000)
      : undefined

    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      byType,
      byEdgeType,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      pagesVisited: session?.visited.size ?? 0,
      pagesRemaining: session?.frontier.length ?? 0,
      topConnected,
      coverageScore,
      sessionDurationSec,
    }
  }

  // ── Export formats ─────────────────────────────────────────────────────────────

  private getSnapshot(): GraphSnapshot {
    const stats = this.getStats()
    const session = this.session ?? {
      id: 'no-session',
      targetUrl: 'unknown',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'idle' as const,
      frontier: [],
      visited: new Set<string>(),
      errors: [],
      config: DEFAULT_CONFIG,
    }
    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      session: { ...session, visited: [...session.visited] },
      nodes: this.getAllNodes(),
      edges: this.getAllEdges(),
      stats,
    }
  }

  exportJson(): string {
    return JSON.stringify(this.getSnapshot(), null, 2)
  }

  exportJsonLd(): string {
    const snapshot = this.getSnapshot()
    const graph = {
      '@context': JSON_LD_CONTEXT,
      '@graph': [
        ...snapshot.nodes.map(n => ({ ...n, '@id': n.id, '@type': n.type })),
        ...snapshot.edges.map(e => ({
          '@id': e.id,
          '@type': 'DependencyEdge',
          from: e.from,
          to: e.to,
          edgeType: e.type,
          label: e.label,
          confidence: e.confidence,
        })),
      ],
      meta: {
        session: snapshot.session,
        stats: snapshot.stats,
        exportedAt: snapshot.exportedAt,
      },
    }
    return JSON.stringify(graph, null, 2)
  }

  exportGraphML(): string {
    const nodes = this.getAllNodes()
    const edges = this.getAllEdges()

    const nodeAttrs = [
      { id: 'type', type: 'string' },
      { id: 'summary', type: 'string' },
      { id: 'confidence', type: 'double' },
      { id: 'tags', type: 'string' },
      { id: 'url', type: 'string' },
      { id: 'name', type: 'string' },
    ]
    const edgeAttrs = [
      { id: 'label', type: 'string' },
      { id: 'edgeType', type: 'string' },
      { id: 'confidence', type: 'double' },
    ]

    const esc = (s: string) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<graphml xmlns="http://graphml.graphdrawing.org/graphml">',
      ...nodeAttrs.map(a => `  <key id="n_${a.id}" for="node" attr.name="${a.id}" attr.type="${a.type}"/>`),
      ...edgeAttrs.map(a => `  <key id="e_${a.id}" for="edge" attr.name="${a.id}" attr.type="${a.type}"/>`),
      '  <graph id="G" edgedefault="directed">',
    ]

    for (const n of nodes) {
      const r = n as Record<string, unknown>
      lines.push(`    <node id="${esc(n.id)}">`)
      lines.push(`      <data key="n_type">${esc(n.type)}</data>`)
      lines.push(`      <data key="n_summary">${esc(n.summary.slice(0, 200))}</data>`)
      lines.push(`      <data key="n_confidence">${n.confidence}</data>`)
      lines.push(`      <data key="n_tags">${esc(n.tags.join(', '))}</data>`)
      if (r.url) lines.push(`      <data key="n_url">${esc(r.url as string)}</data>`)
      if (r.name) lines.push(`      <data key="n_name">${esc(r.name as string)}</data>`)
      lines.push('    </node>')
    }

    for (const e of edges) {
      lines.push(`    <edge id="${esc(e.id)}" source="${esc(e.from)}" target="${esc(e.to)}">`)
      lines.push(`      <data key="e_label">${esc(e.label)}</data>`)
      lines.push(`      <data key="e_edgeType">${esc(e.type)}</data>`)
      lines.push(`      <data key="e_confidence">${e.confidence}</data>`)
      lines.push('    </edge>')
    }

    lines.push('  </graph>', '</graphml>')
    return lines.join('\n')
  }

  exportMermaid(): string {
    const nodes = this.getAllNodes()
    const edges = this.getAllEdges()

    // Sanitize node labels for Mermaid (no quotes, no brackets)
    const mId = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_')
    const mLabel = (s: string) => s.replace(/["\[\]()]/g, '').slice(0, 60)

    const typeEmoji: Record<string, string> = {
      page: '\uD83D\uDCC4',
      feature: '\u2728',
      workflow: '\uD83D\uDD04',
      api_endpoint: '\uD83D\uDD17',
      ui_component: '\uD83E\uDDF1',
      storage: '\uD83D\uDDB3\uFE0F',
      worker: '\u2699\uFE0F',
    }

    const edgeArrow: Record<string, string> = {
      navigates_to: '-->',
      requires: '-.->',
      triggers: '==>',
      calls_api: '--o',
      renders: '--+',
      reads_storage: '--r-->',
      writes_storage: '--w-->',
      uses_worker: '--w-->',
      part_of: '--\u25B7',
      guarded_by: '-.-|guard|',
    }

    const lines = [
      '```mermaid',
      'flowchart TD',
      '',
      '  %% Node Definitions',
    ]

    // Group nodes by type
    const grouped = new Map<string, AnyNode[]>()
    for (const n of nodes) {
      if (!grouped.has(n.type)) grouped.set(n.type, [])
      grouped.get(n.type)!.push(n)
    }

    for (const [type, typeNodes] of grouped) {
      lines.push(`  subgraph ${type}_nodes["${typeEmoji[type] ?? ''} ${type.replace('_', ' ').toUpperCase()}S"]`)
      for (const n of typeNodes) {
        const label = mLabel(n.summary)
        const shape = {
          page: `["${label}"]`,
          feature: `("${label}")`,
          workflow: `[/"${label}"/]`,
          api_endpoint: `>"${label}"]`,
          ui_component: `["${label}"]`,
          storage: `[("${label}")]`,
          worker: `{{"${label}"}}`,
        }[n.type] ?? `["${label}"]`
        lines.push(`    ${mId(n.id)}${shape}`)
      }
      lines.push('  end')
    }

    lines.push('', '  %% Edges')
    for (const e of edges) {
      const arrow = edgeArrow[e.type] ?? '-->'
      const edgeLabel = e.label.slice(0, 40)
      lines.push(`  ${mId(e.from)} ${arrow}|"${mLabel(edgeLabel)}"|${mId(e.to)}`)
    }

    lines.push('')
    lines.push('  %% Legend')
    lines.push('  classDef page fill:#e3f2fd,stroke:#1565c0')
    lines.push('  classDef feature fill:#f3e5f5,stroke:#6a1b9a')
    lines.push('  classDef workflow fill:#e8f5e9,stroke:#2e7d32')
    lines.push('  classDef api fill:#fff3e0,stroke:#e65100')
    lines.push('  classDef storage fill:#fce4ec,stroke:#880e4f')
    lines.push('  classDef worker fill:#e0f7fa,stroke:#006064')

    for (const n of nodes) {
      const cls = { api_endpoint: 'api', ui_component: 'feature' }[n.type] ?? n.type
      lines.push(`  class ${mId(n.id)} ${cls}`)
    }

    lines.push('```')
    return lines.join('\n')
  }

  exportSummary(): string {
    const stats = this.getStats()
    const session = this.session
    const nodes = this.getAllNodes()

    const lines = [
      `# Website Intelligence Map`,
      `**Target:** ${session?.targetUrl ?? 'unknown'}`,
      `**Session:** ${session?.id ?? 'none'} | **Status:** ${session?.status ?? 'unknown'}`,
      `**Started:** ${session?.startedAt ?? '-'} | **Updated:** ${session?.updatedAt ?? '-'}`,
      `**Coverage Score:** ${stats.coverageScore}/100`,
      '',
      '## Graph Statistics',
      `- Total nodes: **${stats.totalNodes}**`,
      `- Total edges: **${stats.totalEdges}**`,
      `- Avg confidence: **${(stats.avgConfidence * 100).toFixed(0)}%**`,
      `- Pages visited: **${stats.pagesVisited}** | Remaining: **${stats.pagesRemaining}**`,
      '',
      '## Nodes by Type',
      ...Object.entries(stats.byType).map(([t, c]) => `- ${t}: ${c}`),
      '',
      '## Top Connected Nodes',
      ...stats.topConnected.map(n => `- [${n.degree} edges] ${n.summary.slice(0, 100)}`),
      '',
      '## Pages',
      ...nodes
        .filter(n => n.type === 'page')
        .map(n => {
          const p = n as PageNode
          return `- ${p.path}${p.requiresAuth ? ' 🔒' : ''} — ${p.title.slice(0, 60)}`
        }),
      '',
      '## Features',
      ...nodes
        .filter(n => n.type === 'feature')
        .map(n => {
          const f = n as FeatureNode
          return `- **${f.name}**${f.isHidden ? ' [HIDDEN]' : ''} — ${f.description.slice(0, 100)}`
        }),
      '',
      '## API Endpoints',
      ...nodes
        .filter(n => n.type === 'api_endpoint')
        .map(n => {
          const a = n as APIEndpointNode
          return `- \`${a.method} ${a.urlPattern}\`${a.requiresAuth ? ' 🔒' : ''} [${a.apiType}]`
        }),
      '',
      '## Workflows',
      ...nodes
        .filter(n => n.type === 'workflow')
        .map(n => {
          const w = n as WorkflowNode
          return `- **${w.name}** (${w.steps.length} steps, ${w.complexity}) — ${w.goal.slice(0, 80)}`
        }),
    ]

    if (session?.errors.length) {
      lines.push('', '## Errors', ...session.errors.map(e => `- ${e.url}: ${e.error}`))
    }

    return lines.join('\n')
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  saveAll(dir?: string): { json: string; graphml: string; mermaid: string; summary: string } {
    const outputDir = dir ?? this.outputDir
    if (!outputDir) throw new Error('No output directory set')
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

    const paths = {
      json: path.join(outputDir, 'graph.json'),
      graphml: path.join(outputDir, 'graph.graphml'),
      mermaid: path.join(outputDir, 'graph.md'),
      summary: path.join(outputDir, 'graph-summary.md'),
    }

    fs.writeFileSync(paths.json, this.exportJson(), 'utf8')
    fs.writeFileSync(paths.graphml, this.exportGraphML(), 'utf8')
    fs.writeFileSync(paths.mermaid, this.exportMermaid(), 'utf8')
    fs.writeFileSync(paths.summary, this.exportSummary(), 'utf8')

    return paths
  }

  loadFromFile(jsonPath: string): void {
    const raw = fs.readFileSync(jsonPath, 'utf8')
    const snapshot = JSON.parse(raw) as GraphSnapshot
    this.nodes.clear()
    this.edges.clear()
    for (const n of snapshot.nodes) this.nodes.set(n.id, n)
    for (const e of snapshot.edges) this.edges.set(e.id, e)
    this.session = {
      ...snapshot.session,
      visited: new Set(snapshot.session.visited),
    }
  }

  private onMutation(): void {
    if (this.session) this.session.updatedAt = new Date().toISOString()
    this.mutationCount++
    if (this.outputDir && this.mutationCount % this.AUTO_SAVE_INTERVAL === 0) {
      try { this.saveAll() } catch { /* ignore auto-save errors */ }
    }
  }
}

// Singleton export
export const graph = new GraphStore()

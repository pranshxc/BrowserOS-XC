/**
 * graph-store.ts — legacy in-memory knowledge graph store.
 *
 * UPGRADED: now bridges to the disk-persistent store.ts so that all mutations
 * (addNode / addEdge) are written to disk immediately, just like the newer
 * graph_add_node and map_site_start tools. The in-memory Map is kept for
 * backwards-compatible queryNodes / queryEdges calls within the same process.
 *
 * Singleton per server process; survives across tool calls within a session.
 */

import {
  addNode as diskAddNode,
  addEdge as diskAddEdge,
  type NodeType,
  type EdgeType,
} from './store'

export type NodeKind = 'page' | 'feature' | 'api' | 'workflow'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  url?: string
  description?: string
  metadata?: Record<string, unknown>
  createdAt: number
}

export interface GraphEdge {
  from: string
  to: string
  relation: string
  metadata?: Record<string, unknown>
}

export interface KnowledgeGraph {
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
}

const graph: KnowledgeGraph = {
  nodes: new Map(),
  edges: [],
}

// Map legacy NodeKind → disk NodeType
function kindToNodeType(kind: NodeKind): NodeType {
  const map: Record<NodeKind, NodeType> = {
    page: 'page',
    feature: 'generic',
    api: 'graphql_api',
    workflow: 'generic',
  }
  return map[kind] ?? 'generic'
}

// Map legacy relation string → disk EdgeType
function relationToEdgeType(relation: string): EdgeType {
  const map: Record<string, EdgeType> = {
    navigates_to: 'navigates_to',
    calls: 'calls_api',
    calls_api: 'calls_api',
    requires: 'related',
    part_of: 'related',
    renders: 'renders',
    reads_state: 'reads_state',
    uses_flag: 'uses_flag',
    related: 'related',
  }
  return (map[relation] as EdgeType) ?? 'generic'
}

export function addNode(node: Omit<GraphNode, 'createdAt'>): GraphNode {
  const full: GraphNode = { ...node, createdAt: Date.now() }
  graph.nodes.set(node.id, full)
  // Bridge: also write to persistent disk store (fire-and-forget; never blocks)
  diskAddNode(
    node.label || node.id,
    kindToNodeType(node.kind),
    { id: node.id, url: node.url, description: node.description, ...node.metadata },
  ).catch(() => { /* disk write errors are non-fatal for legacy callers */ })
  return full
}

export function addEdge(edge: GraphEdge): void {
  graph.edges.push(edge)
  // Bridge: also write to persistent disk store (fire-and-forget; never blocks)
  diskAddEdge(
    edge.from,
    edge.to,
    relationToEdgeType(edge.relation),
    edge.metadata ?? {},
  ).catch(() => { /* disk write errors are non-fatal for legacy callers */ })
}

export function getNode(id: string): GraphNode | undefined {
  return graph.nodes.get(id)
}

export function queryNodes(kind?: NodeKind): GraphNode[] {
  const all = [...graph.nodes.values()]
  return kind ? all.filter((n) => n.kind === kind) : all
}

export function queryEdges(fromId?: string, relation?: string): GraphEdge[] {
  return graph.edges.filter(
    (e) =>
      (fromId === undefined || e.from === fromId) &&
      (relation === undefined || e.relation === relation),
  )
}

export function exportGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
  }
}

export function clearGraph(): void {
  graph.nodes.clear()
  graph.edges.length = 0
}

export function graphSummary(): {
  totalNodes: number
  totalEdges: number
  byKind: Record<string, number>
} {
  const byKind: Record<string, number> = {}
  for (const node of graph.nodes.values()) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1
  }
  return {
    totalNodes: graph.nodes.size,
    totalEdges: graph.edges.length,
    byKind,
  }
}

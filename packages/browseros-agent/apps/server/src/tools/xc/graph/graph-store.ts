/**
 * graph-store.ts — in-memory knowledge graph store for website intelligence mapping.
 * Singleton per server process; survives across tool calls within a session.
 */

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

export function addNode(node: Omit<GraphNode, 'createdAt'>): GraphNode {
  const full: GraphNode = { ...node, createdAt: Date.now() }
  graph.nodes.set(node.id, full)
  return full
}

export function addEdge(edge: GraphEdge): void {
  graph.edges.push(edge)
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

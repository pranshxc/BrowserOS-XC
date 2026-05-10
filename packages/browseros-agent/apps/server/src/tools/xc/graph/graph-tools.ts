/**
 * graph-tools.ts — MCP tool definitions for the knowledge graph.
 */
import { z } from 'zod'
import { defineTool } from '../../framework'
import {
  addEdge,
  addNode,
  exportGraph,
  graphSummary,
  queryEdges,
  queryNodes,
} from './graph-store'

export const graph_add_page = defineTool({
  name: 'graph_add_page',
  description: 'Add a discovered page/route to the knowledge graph.',
  approvalCategory: 'read',
  input: z.object({
    id: z.string().describe('Unique node ID, e.g. page:/dashboard'),
    label: z.string().describe('Human-readable page name'),
    url: z.string().optional().describe('Full URL of the page'),
    description: z.string().optional().describe('What this page does'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    const node = addNode({ kind: 'page', ...args })
    response.text(`Added page node: ${node.id}`)
  },
})

export const graph_add_feature = defineTool({
  name: 'graph_add_feature',
  description: 'Add a discovered UI feature or capability to the knowledge graph.',
  approvalCategory: 'read',
  input: z.object({
    id: z.string().describe('Unique node ID, e.g. feature:login'),
    label: z.string().describe('Feature name'),
    description: z.string().optional().describe('What this feature enables'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    const node = addNode({ kind: 'feature', ...args })
    response.text(`Added feature node: ${node.id}`)
  },
})

export const graph_add_api = defineTool({
  name: 'graph_add_api',
  description: 'Add a discovered API endpoint or background request to the knowledge graph.',
  approvalCategory: 'read',
  input: z.object({
    id: z.string().describe('Unique node ID, e.g. api:POST:/auth/login'),
    label: z.string().describe('Endpoint label'),
    url: z.string().optional().describe('Endpoint URL pattern'),
    description: z.string().optional().describe('What this endpoint does'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    const node = addNode({ kind: 'api', ...args })
    response.text(`Added api node: ${node.id}`)
  },
})

export const graph_add_workflow = defineTool({
  name: 'graph_add_workflow',
  description: 'Add a multi-step user workflow or journey to the knowledge graph.',
  approvalCategory: 'read',
  input: z.object({
    id: z.string().describe('Unique node ID, e.g. workflow:signup'),
    label: z.string().describe('Workflow name'),
    description: z.string().optional().describe('Step-by-step description'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    const node = addNode({ kind: 'workflow', ...args })
    response.text(`Added workflow node: ${node.id}`)
  },
})

export const graph_add_edge = defineTool({
  name: 'graph_add_edge',
  description: 'Add a directed relationship (edge) between two nodes in the knowledge graph.',
  approvalCategory: 'read',
  input: z.object({
    from: z.string().describe('Source node ID'),
    to: z.string().describe('Target node ID'),
    relation: z.string().describe('Relationship type, e.g. "navigates_to", "calls", "requires", "part_of"'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    addEdge(args)
    response.text(`Added edge: ${args.from} -[${args.relation}]-> ${args.to}`)
  },
})

export const graph_query = defineTool({
  name: 'graph_query',
  description: 'Query nodes and edges from the knowledge graph.',
  approvalCategory: 'read',
  input: z.object({
    kind: z.enum(['page', 'feature', 'api', 'workflow']).optional().describe('Filter nodes by kind'),
    fromId: z.string().optional().describe('Filter edges by source node ID'),
    relation: z.string().optional().describe('Filter edges by relation type'),
  }),
  async handler(args, _ctx, response) {
    const nodes = queryNodes(args.kind)
    const edges = queryEdges(args.fromId, args.relation)
    response.text(JSON.stringify({ nodes, edges }, null, 2))
  },
})

export const graph_export = defineTool({
  name: 'graph_export',
  description: 'Export the full knowledge graph as JSON.',
  approvalCategory: 'read',
  input: z.object({}),
  async handler(_args, _ctx, response) {
    const data = exportGraph()
    response.text(JSON.stringify(data, null, 2))
  },
})

export const graph_summary = defineTool({
  name: 'graph_summary',
  description: 'Get a summary of the current knowledge graph (node/edge counts by kind).',
  approvalCategory: 'read',
  input: z.object({}),
  async handler(_args, _ctx, response) {
    const summary = graphSummary()
    response.text(JSON.stringify(summary, null, 2))
  },
})

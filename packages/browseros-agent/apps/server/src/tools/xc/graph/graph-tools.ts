/**
 * graph-tools.ts — legacy MCP tool definitions for the knowledge graph.
 *
 * UPGRADED: graph_export now saves to disk and returns file paths (instead of
 * dumping raw JSON into LLM context). All other tools are preserved as-is.
 * graph_add_page / graph_add_feature / graph_add_api / graph_add_workflow all
 * persist to disk via the bridged graph-store.ts.
 */
import { z } from 'zod'
import { defineTool } from '../../framework'
import {
  addEdge,
  addNode,
  graphSummary,
  queryEdges,
  queryNodes,
} from './graph-store'
import { saveAllFormats, getActiveSessionId } from './store'

export const graph_add_page = defineTool({
  name: 'graph_add_page',
  description: 'Add a discovered page/route to the knowledge graph. Persisted to disk immediately.',
  approvalCategory: 'observation',
  input: z.object({
    id: z.string().describe('Unique node ID, e.g. page:/dashboard'),
    label: z.string().describe('Human-readable page name'),
    url: z.string().optional().describe('Full URL of the page'),
    description: z.string().optional().describe('What this page does'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    const node = addNode({ kind: 'page', ...args })
    response.text(`Added page node: ${node.id} (persisted to disk)`)
  },
})

export const graph_add_feature = defineTool({
  name: 'graph_add_feature',
  description: 'Add a discovered UI feature or capability to the knowledge graph. Persisted to disk immediately.',
  approvalCategory: 'observation',
  input: z.object({
    id: z.string().describe('Unique node ID, e.g. feature:login'),
    label: z.string().describe('Feature name'),
    description: z.string().optional().describe('What this feature enables'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    const node = addNode({ kind: 'feature', ...args })
    response.text(`Added feature node: ${node.id} (persisted to disk)`)
  },
})

export const graph_add_api = defineTool({
  name: 'graph_add_api',
  description: 'Add a discovered API endpoint or background request to the knowledge graph. Persisted to disk immediately.',
  approvalCategory: 'observation',
  input: z.object({
    id: z.string().describe('Unique node ID, e.g. api:POST:/auth/login'),
    label: z.string().describe('Endpoint label'),
    url: z.string().optional().describe('Endpoint URL pattern'),
    description: z.string().optional().describe('What this endpoint does'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    const node = addNode({ kind: 'api', ...args })
    response.text(`Added api node: ${node.id} (persisted to disk)`)
  },
})

export const graph_add_workflow = defineTool({
  name: 'graph_add_workflow',
  description: 'Add a multi-step user workflow or journey to the knowledge graph. Persisted to disk immediately.',
  approvalCategory: 'observation',
  input: z.object({
    id: z.string().describe('Unique node ID, e.g. workflow:signup'),
    label: z.string().describe('Workflow name'),
    description: z.string().optional().describe('Step-by-step description'),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    const node = addNode({ kind: 'workflow', ...args })
    response.text(`Added workflow node: ${node.id} (persisted to disk)`)
  },
})

export const graph_add_relation = defineTool({
  name: 'graph_add_relation',
  description: 'Add a directed relationship (edge) between two nodes in the knowledge graph. Persisted to disk immediately.',
  approvalCategory: 'observation',
  input: z.object({
    from: z.string().describe('Source node ID'),
    to: z.string().describe('Target node ID'),
    relation: z.string().describe(
      'Relationship type, e.g. "navigates_to", "calls", "requires", "part_of"',
    ),
    metadata: z.record(z.unknown()).optional(),
  }),
  async handler(args, _ctx, response) {
    addEdge(args)
    response.text(`Added edge: ${args.from} -[${args.relation}]-> ${args.to} (persisted to disk)`)
  },
})

export const graph_query_legacy = defineTool({
  name: 'graph_query_legacy',
  description: 'Query nodes and edges from the in-memory knowledge graph (legacy graph_add_page/feature/api/workflow nodes).',
  approvalCategory: 'observation',
  input: z.object({
    kind: z
      .enum(['page', 'feature', 'api', 'workflow'])
      .optional()
      .describe('Filter nodes by kind'),
    fromId: z.string().optional().describe('Filter edges by source node ID'),
    relation: z.string().optional().describe('Filter edges by relation type'),
  }),
  async handler(args, _ctx, response) {
    const nodes = queryNodes(args.kind)
    const edges = queryEdges(args.fromId, args.relation)
    response.text(JSON.stringify({ nodes, edges }, null, 2))
  },
})

export const graph_export_legacy = defineTool({
  name: 'graph_export_legacy',
  description: [
    'Export all graph data (from graph_add_page/feature/api/workflow AND graph_add_node) to disk.',
    'Saves .ndjson + .json + .mmd to both ~/.browseros/graphs/ and ./graphs/.',
    'Returns file paths only — raw data is NOT returned to avoid context overflow.',
    'Use graph_read to read a saved file back.',
  ].join(' '),
  approvalCategory: 'filesystem_write',
  input: z.object({
    direction: z.enum(['LR', 'TD']).default('LR').describe('Mermaid diagram direction (LR or TD).'),
  }),
  async handler(args, _ctx, response) {
    const sessionId = getActiveSessionId() ?? undefined
    if (!sessionId) {
      response.text('No active graph session. Add nodes first with graph_add_node or graph_add_page.')
      return
    }
    const result = await saveAllFormats(sessionId, (args.direction ?? 'LR') as 'LR' | 'TD')
    response.text(
      [
        `✅ Graph exported (all formats)`,
        `  nodes : ${result.nodeCount}`,
        `  edges : ${result.edgeCount}`,
        ``,
        `  Files saved:`,
        `    ndjson home : ${result.homeNdjsonPath}`,
        `    ndjson cwd  : ${result.cwdNdjsonPath}`,
        `    json home   : ${result.homeJsonPath}`,
        `    json cwd    : ${result.cwdJsonPath}`,
        `    mmd  home   : ${result.homeMMDPath}`,
        `    mmd  cwd    : ${result.cwdMMDPath}`,
        ``,
        `Paste the .mmd file contents at https://mermaid.live to render the diagram.`,
        `Use graph_read to read file contents back into this conversation.`,
      ].join('\n'),
    )
  },
})

export const graph_summary_legacy = defineTool({
  name: 'graph_summary_legacy',
  description: 'Get a summary of the in-memory knowledge graph built with graph_add_page/feature/api/workflow (node/edge counts by kind).',
  approvalCategory: 'observation',
  input: z.object({}),
  async handler(_args, _ctx, response) {
    const summary = graphSummary()
    response.text(JSON.stringify(summary, null, 2))
  },
})

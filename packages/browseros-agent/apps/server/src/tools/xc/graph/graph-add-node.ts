import { defineTool } from '../../framework'
import {
  addNode,
  type NodeType,
} from './store'
import { z } from 'zod'

const NODE_TYPES: [NodeType, ...NodeType[]] = [
  'page',
  'feature_flag',
  'graphql_api',
  'redux_slice',
  'route',
  'component',
  'generic',
]

export const graph_add_node = defineTool({
  name: 'graph_add_node',
  description: [
    'Add a node to the knowledge graph.',
    'Each node represents a discovered entity: a page URL, feature flag, GraphQL API, Redux slice, route, or component.',
    'Nodes are written immediately to disk at ~/.browseros/graphs/ AND ./graphs/ -- never lost.',
    'Returns the node ID and file paths. Does NOT return the full graph (use graph_summary or graph_query for that).',
    'If no session is active, a new one is created automatically.',
    'REQUIRED: label (string). OPTIONAL: type (default: page), meta (object), session_id (string).',
  ].join(' '),
  approvalCategory: 'filesystem_write',
  input: z.object({
    label: z.string().describe(
      'Human-readable label for the node, e.g. a URL, flag name, API name, or Redux slice name.',
    ),
    type: z.enum(NODE_TYPES).default('page').describe(
      'Node type: page | feature_flag | graphql_api | redux_slice | route | component | generic. Default: page',
    ),
    meta: z
      .record(z.unknown())
      .default({})
      .describe('Optional metadata key/value pairs, e.g. { method: "GET", domain: "twilio.com" }. Default: {}'),
    session_id: z.string().optional().describe(
      'Session ID to write to. Omit to use the active session (auto-created if none exists).',
    ),
  }),
  handler: async (args, _ctx, response) => {
    const { label, type, meta, session_id } = args as {
      label: string
      type: NodeType
      meta: Record<string, unknown>
      session_id?: string
    }

    const result = await addNode(label, type, meta ?? {}, session_id)

    response.text(
      [
        `Node added`,
        `  node_id   : ${result.nodeId}`,
        `  type      : ${type}`,
        `  session   : ${result.sessionId}`,
        `  home_path : ${result.homePath}`,
        `  cwd_path  : ${result.cwdPath}`,
        ``,
        `Data is persisted to disk. Use graph_summary to see counts.`,
      ].join('\n'),
    )
  },
})

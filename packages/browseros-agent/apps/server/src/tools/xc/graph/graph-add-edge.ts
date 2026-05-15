import { defineTool } from '../../framework'
import { addEdge, type EdgeType } from './store'
import { z } from 'zod'

const EDGE_TYPES: [EdgeType, ...EdgeType[]] = [
  'navigates_to',
  'contains',
  'submits_to',
  'triggers',
  'validates_via',
  'redirects_to',
  'authenticates_with',
  'auth_gate',
  'reveals',
  'opens_dialog',
  'client_route_to',
  'depends_on_state',
  'background_sync',
  'uses_flag',
  'calls_api',
  'reads_state',
  'renders',
  'related',
  'generic',
]

export const graph_add_edge = defineTool({
  name: 'graph_add_edge',
  description: [
    'Add a directed edge between two nodes in the knowledge graph.',
    'Use node IDs returned by graph_add_node.',
    'Edge is written immediately to disk. Returns file paths.',
    'Does NOT return the full graph.',
    'REQUIRED: from (string node ID), to (string node ID). OPTIONAL: type (default: navigates_to), meta (object), session_id.',
  ].join(' '),
  approvalCategory: 'data-modification',
  input: z.object({
    from: z.string().describe('Source node ID (returned by graph_add_node)'),
    to: z.string().describe('Target node ID (returned by graph_add_node)'),
    type: z.enum(EDGE_TYPES).default('navigates_to').describe(
      'Edge type: navigates_to | contains | submits_to | triggers | validates_via | redirects_to | authenticates_with | auth_gate | reveals | opens_dialog | client_route_to | depends_on_state | background_sync | uses_flag | calls_api | reads_state | renders | related | generic. Default: navigates_to',
    ),
    meta: z
      .record(z.unknown())
      .default({})
      .describe('Optional metadata for this edge. Default: {}'),
    session_id: z.string().optional().describe(
      'Session ID. Omit to use active session.',
    ),
  }),
  handler: async (args, _ctx, response) => {
    const { from, to, type, meta, session_id } = args as {
      from: string
      to: string
      type: EdgeType
      meta: Record<string, unknown>
      session_id?: string
    }

    const result = await addEdge(from, to, type, meta ?? {}, session_id)

    response.text(
      [
        `Edge added`,
        `  ${from} --[${type}]--> ${to}`,
        `  session   : ${result.sessionId}`,
        `  home_path : ${result.homePath}`,
        `  cwd_path  : ${result.cwdPath}`,
      ].join('\n'),
    )
  },
})

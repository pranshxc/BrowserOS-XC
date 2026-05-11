import { defineTool } from '../../framework'
import {
  addNode,
  type NodeType,
} from './store'
import { z } from 'zod'

const NODE_TYPES: [NodeType, ...NodeType[]] = [
  // Phase 11 semantic types
  'page',
  'form',
  'field',
  'action',
  'api_call',
  'popup',
  'nav_region',
  'content_block',
  'error_state',
  'auth_gate',
  'js_bundle',
  'local_storage',
  'schema_org',
  // Legacy types (preserved)
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
    'Add a semantic node to the knowledge graph.',
    'Node types: page (URL/route), form (<form> element), field (<input>/<select>/<textarea>),',
    'action (button/CTA/JS trigger), api_call (network request), popup (modal/dialog/tooltip),',
    'nav_region (ARIA landmark), content_block (heading+body section), error_state (validation failure),',
    'auth_gate (requires auth), js_bundle (framework/feature flags), local_storage (client-side key),',
    'schema_org (JSON-LD block).',
    'Also supports legacy types: feature_flag, graphql_api, redux_slice, route, component, generic.',
    'Nodes are written immediately to disk at ~/.browseros/graphs/ AND ./graphs/ -- never lost.',
    'Returns the node ID and file paths.',
    'REQUIRED: label (string). OPTIONAL: type (default: page), meta (object), session_id (string).',
  ].join(' '),
  approvalCategory: 'filesystem_write',
  input: z.object({
    label: z.string().describe(
      'Human-readable label for the node, e.g. a URL, form name, field label, button text, or API endpoint.',
    ),
    type: z.enum(NODE_TYPES).default('page').describe(
      'Node type. Default: page. See description for full list.',
    ),
    meta: z
      .record(z.unknown())
      .default({})
      .describe('Optional metadata, e.g. { url, pageRole, inputType, method, endpoint }. Default: {}'),
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

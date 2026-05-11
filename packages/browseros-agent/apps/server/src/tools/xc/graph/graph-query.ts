import { defineTool } from '../../framework'
import { queryGraph } from './store'
import { z } from 'zod'

export const graph_query = defineTool({
  name: 'graph_query',
  description: [
    'Query nodes or edges from the graph in paginated slices.',
    'Use this instead of graph_export when you need to inspect graph data inside the conversation.',
    'Results are paginated (default 50 per page) to prevent LLM context overflow.',
    'Filter by kind (node|edge) and/or type (e.g. page, feature_flag, navigates_to).',
    'Use hasMore + page parameter to iterate through all results.',
    'IMPORTANT: page and page_size must be numbers (e.g. 1, 50). Omit them to use defaults.',
  ].join(' '),
  approvalCategory: 'read',
  input: z.object({
    session_id: z.string().optional().describe('Session ID. Omit to use active session.'),
    kind: z.enum(['node', 'edge']).optional().describe('Filter to only nodes or only edges.'),
    type: z
      .string()
      .optional()
      .describe(
        'Filter by node type (page, feature_flag, graphql_api, redux_slice, route, component, generic) or edge type (navigates_to, uses_flag, calls_api, reads_state, renders, related, generic).',
      ),
    page: z.coerce.number().int().min(1).default(1).describe('Page number (1-based). Default: 1'),
    page_size: z.coerce.number().int().min(1).max(100).default(50).describe(
      'Items per page (max 100). Default: 50. Keep low to avoid context overflow.',
    ),
  }),
  handler: async (args, _ctx, response) => {
    const { session_id, kind, type, page, page_size } = args as {
      session_id?: string
      kind?: 'node' | 'edge'
      type?: string
      page: number
      page_size: number
    }

    const result = await queryGraph(
      session_id,
      kind || type ? { kind, type } : undefined,
      page,
      page_size,
    )

    const lines: string[] = [
      `Graph Query Results`,
      `  total   : ${result.total}`,
      `  page    : ${result.page} / ${Math.ceil(result.total / result.pageSize) || 1}`,
      `  showing : ${result.items.length} items`,
      `  hasMore : ${result.hasMore}`,
      ``,
    ]

    for (const item of result.items) {
      if (item.kind === 'node') {
        lines.push(`  [node] ${item.id}  type=${item.type}  label="${item.label}"`)
        if (Object.keys(item.meta).length > 0) {
          lines.push(`         meta=${JSON.stringify(item.meta)}`)
        }
      } else {
        lines.push(`  [edge] ${item.from} --[${item.type}]--> ${item.to}`)
        if (Object.keys(item.meta).length > 0) {
          lines.push(`         meta=${JSON.stringify(item.meta)}`)
        }
      }
    }

    if (result.hasMore) {
      lines.push(``, `  Call graph_query with page=${result.page + 1} to get the next page.`)
    }

    response.text(lines.join('\n'))
  },
})

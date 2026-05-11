import { defineTool } from '../../framework'
import { queryGraph } from './store'
import { z } from 'zod'

export const graph_query = defineTool({
  name: 'graph_query',
  description: [
    'Query nodes or edges from the active knowledge graph in paginated slices.',
    'Use this to inspect graph contents inside the conversation without causing context overflow.',
    'NOTE: page_num and per_page are PAGINATION controls for the graph data, NOT browser tab IDs.',
    'Filter by kind (node or edge) and/or type.',
    'Use hasMore + page_num to iterate through all results.',
    'Omit page_num and per_page to use defaults (page 1, 50 items).',
  ].join(' '),
  approvalCategory: 'read',
  input: z.object({
    session_id: z
      .string()
      .optional()
      .describe('Graph session ID. Omit to use the active session.'),
    kind: z
      .enum(['node', 'edge'])
      .optional()
      .describe('Filter to only nodes or only edges. Omit for both.'),
    type: z
      .string()
      .optional()
      .describe(
        'Filter by node type (page, feature_flag, graphql_api, redux_slice, route, component, generic) ' +
        'or edge type (navigates_to, uses_flag, calls_api, reads_state, renders, related, generic). Omit for all types.',
      ),
    page_num: z
      .coerce.number()
      .int()
      .min(1)
      .default(1)
      .describe('Pagination: which page of results to return (1-based). Default: 1. NOT a browser tab ID.'),
    per_page: z
      .coerce.number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe('Pagination: number of items per page (max 100). Default: 50. Keep low to avoid context overflow.'),
  }),
  handler: async (args, _ctx, response) => {
    const { session_id, kind, type, page_num, per_page } = args as {
      session_id?: string
      kind?: 'node' | 'edge'
      type?: string
      page_num: number
      per_page: number
    }

    const result = await queryGraph(
      session_id,
      kind || type ? { kind, type } : undefined,
      page_num,
      per_page,
    )

    const totalPages = Math.ceil(result.total / result.pageSize) || 1
    const lines: string[] = [
      'Graph Query Results',
      `  total   : ${result.total}`,
      `  page    : ${result.page} / ${totalPages}`,
      `  showing : ${result.items.length} items`,
      `  hasMore : ${result.hasMore}`,
      '',
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
      lines.push('', `  Call graph_query with page_num=${result.page + 1} to get the next page.`)
    }

    response.text(lines.join('\n'))
  },
})

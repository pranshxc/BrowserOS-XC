import { defineTool } from '../../framework'
import { loadSessionFromDisk } from './store'
import { z } from 'zod'

export const graph_load = defineTool({
  name: 'graph_load',
  description: [
    'Load a previously saved graph session from disk back into the active session.',
    'Use graph_list to find the session_id of the graph you want to restore.',
    'After loading, graph_add_node / graph_add_edge will append to that session.',
    'Returns a summary of the restored graph.',
  ].join(' '),
  approvalCategory: 'read',
  input: z.object({
    session_id: z.string().describe(
      'The session ID to load. Get this from graph_list.',
    ),
  }),
  handler: async (args, _ctx, response) => {
    const { session_id } = args as { session_id: string }

    const summary = await loadSessionFromDisk(session_id)

    const nodeBreakdown = Object.entries(summary.nodeTypes)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n')

    const edgeBreakdown = Object.entries(summary.edgeTypes)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n')

    response.text(
      [
        `✅ Graph session loaded and set as active`,
        `  session_id : ${summary.sessionId}`,
        `  nodes      : ${summary.nodeCount}`,
        `  edges      : ${summary.edgeCount}`,
        ``,
        `  Node types:`,
        nodeBreakdown || '    (none)',
        ``,
        `  Edge types:`,
        edgeBreakdown || '    (none)',
        ``,
        `  home_path  : ${summary.homePath}`,
        `  cwd_path   : ${summary.cwdPath}`,
        ``,
        `You can now use graph_add_node / graph_add_edge to continue building this graph.`,
      ].join('\n'),
    )
  },
})

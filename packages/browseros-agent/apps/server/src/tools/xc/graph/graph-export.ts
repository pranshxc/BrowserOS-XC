import { defineTool } from '../../framework'
import { exportGraph } from './store'
import { z } from 'zod'

export const graph_export = defineTool({
  name: 'graph_export',
  description: [
    'Export the full graph as a pretty-printed JSON file to disk.',
    'Returns only the file PATHS — NOT the raw JSON content — so LLM context is never overwhelmed.',
    'Files are saved to both ~/.browseros/graphs/<session>.json AND ./graphs/<session>.json.',
    'Use graph_summary to check node/edge counts before exporting.',
    'Use graph_mermaid to get a visual diagram instead.',
  ].join(' '),
  approvalCategory: 'filesystem_write',
  input: z.object({
    session_id: z.string().optional().describe('Session ID. Omit to use active session.'),
  }),
  handler: async (args, _ctx, response) => {
    const { session_id } = args as { session_id?: string }

    const result = await exportGraph(session_id)

    response.text(
      [
        `✅ Graph exported to disk`,
        `  nodes      : ${result.nodeCount}`,
        `  edges      : ${result.edgeCount}`,
        ``,
        `  Files saved:`,
        `    home : ${result.homeJsonPath}`,
        `    cwd  : ${result.cwdJsonPath}`,
        ``,
        `Open either file in any text editor or JSON viewer.`,
        `The full JSON is NOT returned here to avoid context overflow.`,
      ].join('\n'),
    )
  },
})

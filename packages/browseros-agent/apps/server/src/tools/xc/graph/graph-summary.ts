import { defineTool } from '../../framework'
import { getActiveSessionId, getSessionSummary } from './store'
import { z } from 'zod'

export const graph_summary = defineTool({
  name: 'graph_summary',
  description: [
    'Get a compact summary of the active (or specified) graph session.',
    'Returns counts, node/edge type breakdowns, and disk file paths.',
    'This is ALWAYS safe to call — it never returns raw graph data and will never overflow LLM context.',
    'Call this after adding nodes/edges to confirm progress, or at any time to check the state of the graph.',
  ].join(' '),
  approvalCategory: 'read',
  input: z.object({
    session_id: z.string().optional().describe(
      'Session ID to summarise. Omit to use active session.',
    ),
  }),
  handler: async (args, _ctx, response) => {
    const { session_id } = args as { session_id?: string }

    const summary = await getSessionSummary(session_id)

    const nodeBreakdown = Object.entries(summary.nodeTypes)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n')

    const edgeBreakdown = Object.entries(summary.edgeTypes)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n')

    response.text(
      [
        `📊 Graph Summary`,
        `  session_id : ${summary.sessionId}`,
        `  nodes      : ${summary.nodeCount}`,
        `  edges      : ${summary.edgeCount}`,
        ``,
        `  Node types:`,
        nodeBreakdown || '    (none yet)',
        ``,
        `  Edge types:`,
        edgeBreakdown || '    (none yet)',
        ``,
        `  Persisted at:`,
        `    home : ${summary.homePath}`,
        `    cwd  : ${summary.cwdPath}`,
        ``,
        `  Created : ${new Date(summary.createdAt).toISOString()}`,
        `  Updated : ${new Date(summary.updatedAt).toISOString()}`,
        ``,
        `Use graph_query to browse nodes/edges. Use graph_export for full JSON. Use graph_mermaid for diagram.`,
      ].join('\n'),
    )
  },
})

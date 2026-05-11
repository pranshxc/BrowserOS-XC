import { defineTool } from '../../framework'
import { exportMermaid } from './store'
import { z } from 'zod'

export const graph_mermaid = defineTool({
  name: 'graph_mermaid',
  description: [
    'Generate a Mermaid flowchart diagram from the knowledge graph and save it to disk.',
    'Returns the file path AND a compact inline preview of the diagram (the full .mmd file is on disk).',
    'Node shapes reflect type: pages=[rect], feature_flags=[/parallelogram/], graphql_apis=([stadium]),',
    'redux_slices=[(cylinder)], routes=[>flag], components={{hex}}.',
    'Edge styles reflect type: navigates_to=-->, calls_api===>, uses_flag=-.->, reads_state=-.->, renders=--renders-->.',
    'Saved to ~/.browseros/graphs/<session>.mmd AND ./graphs/<session>.mmd.',
  ].join(' '),
  approvalCategory: 'filesystem_write',
  input: z.object({
    session_id: z.string().optional().describe('Session ID. Omit to use active session.'),
    direction: z
      .enum(['TD', 'LR'])
      .default('LR')
      .describe('Diagram direction: LR (left-to-right) or TD (top-down). LR is better for wide site maps.'),
  }),
  handler: async (args, _ctx, response) => {
    const { session_id, direction } = args as {
      session_id?: string
      direction: 'TD' | 'LR'
    }

    const result = await exportMermaid(session_id, direction)

    // Inline preview: first 60 lines only to be LLM-safe
    const previewLines = result.diagram.split('\n').slice(0, 60)
    const truncated = result.diagram.split('\n').length > 60
    const preview = previewLines.join('\n') + (truncated ? '\n  ... (truncated — see file for full diagram)' : '')

    response.text(
      [
        `✅ Mermaid diagram generated`,
        `  nodes  : ${result.nodeCount}`,
        `  edges  : ${result.edgeCount}`,
        ``,
        `  Files saved:`,
        `    home : ${result.homeMMDPath}`,
        `    cwd  : ${result.cwdMMDPath}`,
        ``,
        `  Diagram preview (paste into https://mermaid.live to render):`,
        `\`\`\`mermaid`,
        preview,
        `\`\`\``,
      ].join('\n'),
    )
  },
})

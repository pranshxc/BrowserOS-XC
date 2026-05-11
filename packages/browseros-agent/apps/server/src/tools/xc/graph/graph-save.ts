/**
 * graph-save.ts — save all graph formats to disk right now.
 *
 * Writes .ndjson + .json + .mmd for the active (or specified) session.
 * This is the manual counterpart to the automatic save that happens inside
 * map_site_start after every page. Call this anytime you want to flush
 * the current graph state to all three formats.
 *
 * No data is truncated — full graph is written in every format.
 */
import { defineTool } from '../../framework'
import { saveAllFormats } from './store'
import { z } from 'zod'

export const graph_save = defineTool({
  name: 'graph_save',
  description: [
    'Save all graph formats to disk right now: .ndjson (append log) + .json (full export) + .mmd (Mermaid diagram).',
    'Call this after manually adding nodes/edges with graph_add_node or graph_add_page to ensure everything is persisted.',
    'Files are saved to BOTH ~/.browseros/graphs/ AND ./graphs/ (current working directory).',
    'Returns all 6 file paths (home + cwd for each format).',
    'No data is truncated — the full graph is written in every format.',
    'Use graph_read afterwards to read back and verify the saved contents.',
  ].join(' '),
  approvalCategory: 'filesystem_write',
  input: z.object({
    session_id: z.string().optional().describe('Session ID to save. Omit to use the active session.'),
    direction: z
      .enum(['LR', 'TD'])
      .default('LR')
      .describe('Mermaid diagram direction: LR (left-to-right, default) or TD (top-down).'),
  }),
  handler: async (args, _ctx, response) => {
    const { session_id, direction } = args as {
      session_id?: string
      direction: 'LR' | 'TD'
    }

    const result = await saveAllFormats(session_id, direction)

    response.text(
      [
        `✅ Graph saved — all formats`,
        `  nodes : ${result.nodeCount}`,
        `  edges : ${result.edgeCount}`,
        ``,
        `  NDJSON (append log):`,
        `    home : ${result.homeNdjsonPath}`,
        `    cwd  : ${result.cwdNdjsonPath}`,
        ``,
        `  JSON (full structured export):`,
        `    home : ${result.homeJsonPath}`,
        `    cwd  : ${result.cwdJsonPath}`,
        ``,
        `  Mermaid diagram (.mmd):`,
        `    home : ${result.homeMMDPath}`,
        `    cwd  : ${result.cwdMMDPath}`,
        ``,
        `Paste the .mmd file at https://mermaid.live to render the flowchart.`,
        `Use graph_read to read any of these files back into the conversation.`,
      ].join('\n'),
    )
  },
})

import { defineTool } from '../../framework'
import { listGraphFiles } from './store'
import { z } from 'zod'

export const graph_list = defineTool({
  name: 'graph_list',
  description: [
    'List all saved graph sessions on disk.',
    'Shows session IDs, file paths, sizes, and last-modified timestamps.',
    'Use this to find graphs from previous sessions that can be reloaded with graph_load.',
    'The currently active session is marked with [ACTIVE].',
  ].join(' '),
  approvalCategory: 'read',
  input: z.object({}),
  handler: async (_args, _ctx, response) => {
    const files = await listGraphFiles()

    if (files.length === 0) {
      response.text(
        [
          `📂 No graph sessions found.`,
          ``,
          `Graphs are stored at:`,
          `  ~/.browseros/graphs/`,
          `  ./graphs/  (relative to server cwd)`,
          ``,
          `Start building a graph with graph_add_node.`,
        ].join('\n'),
      )
      return
    }

    const lines = [`📂 Graph Sessions (${files.length} found)`, ``]

    for (const f of files) {
      const tag = f.isActive ? ' [ACTIVE]' : ''
      const kb = (f.sizeBytes / 1024).toFixed(1)
      lines.push(`  ${f.sessionId}${tag}`)
      lines.push(`    ndjson : ${f.ndjsonPath}  (${kb} KB)`)
      if (f.jsonPath) lines.push(`    json   : ${f.jsonPath}`)
      if (f.mmdPath) lines.push(`    mmd    : ${f.mmdPath}`)
      lines.push(`    updated: ${f.modifiedAt}`)
      lines.push(``)
    }

    lines.push(`Use graph_load to restore a session. Use graph_summary for the active session.`)
    response.text(lines.join('\n'))
  },
})

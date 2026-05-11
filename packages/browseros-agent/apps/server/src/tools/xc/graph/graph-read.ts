/**
 * graph-read.ts — read a saved graph file back into the LLM context.
 *
 * Allows the LLM to inspect the contents of a saved .json or .mmd file
 * without leaving the conversation. Reads from disk (source of truth).
 *
 * For large graphs, prefer graph_query (paginated) to avoid context overflow.
 * graph_read is best for .mmd files and small-to-medium .json graphs.
 */
import { defineTool } from '../../framework'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'

function getHomeGraphsDir(): string {
  return join(homedir(), '.browseros', 'graphs')
}

function getCwdGraphsDir(): string {
  return resolve(process.cwd(), 'graphs')
}

export const graph_read = defineTool({
  name: 'graph_read',
  description: [
    'Read a saved graph file (.json, .mmd, or .ndjson) back into the conversation.',
    'Provide either: a full absolute file path, OR a session_id + format combination.',
    'For .mmd (Mermaid) files: paste the output at https://mermaid.live to visualise.',
    'For large .json or .ndjson files, use graph_query instead to avoid context overflow.',
    'Looks in ~/.browseros/graphs/ first, then ./graphs/ (cwd).',
    'REQUIRED: one of (file_path) OR (session_id + format).',
  ].join(' '),
  approvalCategory: 'read',
  input: z.object({
    file_path: z
      .string()
      .optional()
      .describe('Absolute path to the file to read. If provided, session_id and format are ignored.'),
    session_id: z
      .string()
      .optional()
      .describe('Graph session ID (from graph_list or graph_summary). Used with format.'),
    format: z
      .enum(['json', 'mmd', 'ndjson'])
      .optional()
      .describe('File format to read: json (full export), mmd (Mermaid diagram), ndjson (raw append log).'),
    max_chars: z
      .coerce.number()
      .int()
      .min(100)
      .max(200000)
      .default(40000)
      .describe(
        'Maximum characters to return (default: 40000). Increase for large graphs. ' +
        'For very large files prefer graph_query (paginated).'
      ),
  }),
  handler: async (args, _ctx, response) => {
    const { file_path, session_id, format, max_chars } = args as {
      file_path?: string
      session_id?: string
      format?: 'json' | 'mmd' | 'ndjson'
      max_chars: number
    }

    let resolvedPath: string | null = null

    if (file_path) {
      resolvedPath = isAbsolute(file_path)
        ? file_path
        : resolve(process.cwd(), file_path)
    } else if (session_id && format) {
      const ext = format === 'ndjson' ? 'ndjson' : format
      const fileName = `${session_id}.${ext}`
      // Try home dir first, then cwd
      const homePath = join(getHomeGraphsDir(), fileName)
      const cwdPath = join(getCwdGraphsDir(), fileName)
      try {
        await readFile(homePath)
        resolvedPath = homePath
      } catch {
        resolvedPath = cwdPath
      }
    } else {
      response.text(
        'Provide either file_path (absolute path), or both session_id AND format (json | mmd | ndjson).',
      )
      return
    }

    let content: string
    try {
      content = await readFile(resolvedPath, 'utf-8')
    } catch (err) {
      response.text(
        [
          `❌ Could not read file: ${resolvedPath}`,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          ``,
          `Use graph_list to see available graph sessions and their file paths.`,
        ].join('\n'),
      )
      return
    }

    const totalChars = content.length
    const truncated = totalChars > max_chars
    const displayContent = truncated ? content.slice(0, max_chars) : content

    const ext = resolvedPath.split('.').pop() ?? ''
    const isMmd = ext === 'mmd'

    const lines: string[] = [
      `📄 File: ${resolvedPath}`,
      `   Size: ${totalChars.toLocaleString()} chars${truncated ? ` (showing first ${max_chars.toLocaleString()} — increase max_chars to see more)` : ''}`,
      ``,
    ]

    if (isMmd) {
      lines.push('```mermaid')
      lines.push(displayContent)
      lines.push('```')
      lines.push('')
      lines.push('Paste the above at https://mermaid.live to render the flowchart.')
    } else {
      lines.push(displayContent)
    }

    response.text(lines.join('\n'))
  },
})

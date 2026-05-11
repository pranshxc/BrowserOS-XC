import { defineTool } from '../../framework'
import { resetActiveSession } from './store'
import { z } from 'zod'

export const graph_reset = defineTool({
  name: 'graph_reset',
  description: [
    'Clear the active in-memory graph session index.',
    'This does NOT delete any files on disk — all data at ~/.browseros/graphs/ is preserved.',
    'Use this to start fresh without loading a previous session.',
    'After reset, the next graph_add_node call will create a new session automatically.',
  ].join(' '),
  approvalCategory: 'filesystem_write',
  input: z.object({
    confirm: z
      .boolean()
      .describe('Must be true to confirm the reset. Set to true to proceed.'),
  }),
  handler: async (args, _ctx, response) => {
    const { confirm } = args as { confirm: boolean }

    if (!confirm) {
      response.text('Reset cancelled. Set confirm=true to proceed.')
      return
    }

    resetActiveSession()

    response.text(
      [
        `✅ Active graph session cleared.`,
        `All disk files are preserved at ~/.browseros/graphs/`,
        `Use graph_list to see them. Use graph_load to restore one.`,
        `The next graph_add_node will start a fresh session.`,
      ].join('\n'),
    )
  },
})

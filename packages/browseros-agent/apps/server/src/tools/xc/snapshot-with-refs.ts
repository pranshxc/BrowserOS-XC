/**
 * XC Phase 2 — snapshot_with_refs tool
 *
 * Wraps the existing browser.snapshot() call and post-processes the output
 * through RefStore to produce a deterministic @e1…@eN annotated tree.
 *
 * The AI agent should:
 *   1. Call snapshot_with_refs once.
 *   2. Read @eN labels from the returned tree.
 *   3. Call ref_click / ref_fill / ref_hover using those @eN labels.
 *   4. Never need to re-snapshot between steps (unless navigation occurs).
 *
 * Previous refs for the same page are replaced on every call, so the store
 * always reflects the most recent snapshot.
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'
import { refStore } from './ref-store'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')

export const snapshot_with_refs = defineXcTool({
  name: 'snapshot_with_refs',
  description:
    'Take a page snapshot and annotate every interactive element with a stable @eN ref. ' +
    'Use the returned @eN refs with ref_click, ref_fill, and ref_hover — no need to re-scan ' +
    'the DOM between actions. Previous refs for this page are replaced on every call. ' +
    'Refs are invalidated automatically when you navigate.',
  input: z.object({
    page: pageParam,
  }),
  output: z.object({
    snapshot: z.string(),
    refCount: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const raw = await ctx.browser.snapshot(args.page)

    if (!raw) {
      refStore.invalidate(args.page)
      response.text('Page has no interactive elements.')
      response.data({ snapshot: '', refCount: 0 })
      return
    }

    // Populate RefStore and get back the annotated snapshot string.
    const annotated = refStore.populate(args.page, raw)
    const refCount = refStore.listRefs(args.page).length

    response.text(
      `Snapshot with ${refCount} refs (use @e1…@e${refCount} with ref_click / ref_fill / ref_hover):\n\n${annotated}`,
    )
    response.data({ snapshot: annotated, refCount })
  },
})

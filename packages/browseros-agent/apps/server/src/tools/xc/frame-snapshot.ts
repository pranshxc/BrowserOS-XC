/**
 * XC Phase 4 — Frame Snapshot
 *
 * snapshot_all_frames() returns a nested accessibility tree where each
 * iframe's content appears as a labelled child subtree.
 *
 * This lets the AI see the entire page — including embedded Stripe/PayPal
 * checkout forms, OAuth iframes, Google Maps, YouTube embeds — in a single
 * call without needing to switch context manually.
 *
 * Implementation
 * ──────────────
 * Uses session.Accessibility.getFullAXTree({ frameId }) for each frame in
 * the frame tree (same approach as browser.ts's fetchAXTree). Each frame's
 * interactive elements are extracted via buildInteractiveTree from snapshot.ts
 * and prefixed with the frame URL for agent clarity.
 *
 * Tools exported:
 *   snapshot_all_frames  — full nested snapshot across all iframes
 *   snapshot_frame       — snapshot a single frame by frameId
 */

import { buildInteractiveTree } from '../../browser/snapshot'
import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')

type CdpFrame = {
  id: string
  url: string
  name?: string
  parentId?: string
}

type CdpFrameTree = {
  frame: CdpFrame
  childFrames?: CdpFrameTree[]
}

type AXNode = {
  nodeId: string
  ignored?: boolean
  role?: { type: string; value?: string | number | boolean }
  name?: { type: string; value?: string | number | boolean }
  description?: { type: string; value?: string | number | boolean }
  value?: { type: string; value?: string | number | boolean }
  properties?: Array<{ name: string; value: { type: string; value?: string | number | boolean } }>
  childIds?: string[]
  backendDOMNodeId?: number
}

// ── snapshot_all_frames ────────────────────────────────────────────────────────

export const snapshot_all_frames = defineXcTool({
  name: 'snapshot_all_frames',
  description:
    'Take an accessibility snapshot of the page AND all its iframes in one call. ' +
    'Each iframe appears as a labelled section showing its URL and interactive elements. ' +
    'Essential for pages with Stripe/PayPal checkout, OAuth iframes, Google Maps embeds. ' +
    'Use this instead of take_snapshot when you know the page has iframes.',
  input: z.object({
    page: pageParam,
    includeMainFrame: z
      .boolean()
      .default(true)
      .describe('Include main frame content (default true)'),
    iframesOnly: z
      .boolean()
      .default(false)
      .describe('Only show iframe content, skip main frame'),
  }),
  output: z.object({
    snapshot: z.string(),
    frameCount: z.number(),
    iframeCount: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    await session.Page.enable()
    const treeResult = await session.Page.getFrameTree()
    const frameTree = treeResult.frameTree as CdpFrameTree

    // Flatten frame tree preserving order and depth
    const allFrames: Array<{ frameId: string; url: string; name: string; depth: number }> = []
    function flatten(node: CdpFrameTree, depth: number): void {
      allFrames.push({
        frameId: node.frame.id,
        url: node.frame.url ?? '',
        name: node.frame.name ?? '',
        depth,
      })
      if (node.childFrames) {
        for (const child of node.childFrames) flatten(child, depth + 1)
      }
    }
    flatten(frameTree, 0)

    const sections: string[] = []
    let iframeCount = 0

    for (const frame of allFrames) {
      const isMain = frame.depth === 0
      if (isMain && args.iframesOnly) continue
      if (!isMain) iframeCount++
      if (isMain && !args.includeMainFrame) continue

      let lines: string[] = []

      try {
        const axResult = await session.Accessibility.getFullAXTree({
          frameId: frame.frameId,
        })
        const nodes = (axResult.nodes ?? []) as AXNode[]
        lines = buildInteractiveTree(nodes)
      } catch {
        // Cross-origin frame may be blocked — note it but continue
        lines = ['(cross-origin frame — AX tree unavailable; cookies/network still accessible)']
      }

      const indent = '  '.repeat(frame.depth)
      const header = isMain
        ? `=== MAIN FRAME: ${frame.url} ===`
        : `${'  '.repeat(frame.depth - 1)}=== IFRAME [${frame.frameId}]${frame.name ? ` name="${frame.name}"` : ''}: ${frame.url || '(about:blank)'} ===`

      sections.push(header)
      if (lines.length === 0) {
        sections.push(`${indent}(no interactive elements)`)
      } else {
        for (const line of lines) sections.push(`${indent}${line}`)
      }
      sections.push('')
    }

    const snapshot = sections.join('\n')
    response.text(snapshot || '(no frames found)')
    response.data({
      snapshot,
      frameCount: allFrames.length,
      iframeCount,
    })
  },
})

// ── snapshot_frame ─────────────────────────────────────────────────────────────

export const snapshot_frame = defineXcTool({
  name: 'snapshot_frame',
  description:
    'Take an accessibility snapshot of a single frame by its frameId. ' +
    'Use list_frames to get frameIds, then call this to inspect a specific iframe\'s content.',
  input: z.object({
    page: pageParam,
    frameId: z.string().describe('CDP frameId from list_frames'),
  }),
  output: z.object({
    snapshot: z.string(),
    frameId: z.string(),
    elementCount: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    let lines: string[] = []
    try {
      const axResult = await session.Accessibility.getFullAXTree({
        frameId: args.frameId,
      })
      const nodes = (axResult.nodes ?? []) as AXNode[]
      lines = buildInteractiveTree(nodes)
    } catch (err) {
      response.error(
        `Could not get AX tree for frame ${args.frameId}. ` +
          'This may be a cross-origin frame. Error: ' +
          String(err),
      )
      return
    }

    const snapshot = lines.join('\n')
    response.text(
      lines.length === 0
        ? `Frame ${args.frameId} has no interactive elements.`
        : `Frame ${args.frameId} — ${lines.length} element(s):\n${snapshot}`,
    )
    response.data({
      snapshot,
      frameId: args.frameId,
      elementCount: lines.length,
    })
  },
})

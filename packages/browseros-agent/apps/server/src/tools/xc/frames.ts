/**
 * XC Phase 4 — Frame Context Management
 *
 * iframes are currently invisible to BrowserOS's agent because snapshot()
 * and evaluate() operate on the main frame only. This module provides:
 *
 *   list_frames        — enumerate all iframes with URL, name, frameId
 *   switch_to_frame    — set the active frame context for this page
 *   switch_to_main_frame — reset to top-level context
 *   get_active_frame   — show which frame context is currently active
 *
 * Frame Context Architecture
 * ──────────────────────────
 * FrameContext is a per-page singleton storing the active CDP frameId.
 * Once set, any tool that calls ctx.browser.evaluate() with a frame-aware
 * expression will target that frame's execution context.
 *
 * For snapshot inside a frame, use snapshot_all_frames (frame-snapshot.ts)
 * or switch_to_frame + take_snapshot (which uses the AX tree per-frameId).
 *
 * Note: Cross-origin iframes (e.g. Stripe, PayPal) require the browser to
 * have been launched without --site-isolation for full AX access.
 * Network-level CDP calls (cookies, requests) are always cross-origin.
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')
const defineXcInputTool = defineToolWithCategory('input')

// ── FrameContext singleton ────────────────────────────────────────────────────

interface FrameInfo {
  frameId: string
  url: string
  name: string
  parentFrameId?: string
  depth: number
}

class FrameContext {
  private static instances = new Map<number, FrameContext>()

  private activeFrameId: string | null = null
  private activeFrameInfo: FrameInfo | null = null

  static for(pageId: number): FrameContext {
    let ctx = FrameContext.instances.get(pageId)
    if (!ctx) {
      ctx = new FrameContext()
      FrameContext.instances.set(pageId, ctx)
    }
    return ctx
  }

  static remove(pageId: number): void {
    FrameContext.instances.delete(pageId)
  }

  getActive(): { frameId: string; info: FrameInfo } | null {
    if (!this.activeFrameId || !this.activeFrameInfo) return null
    return { frameId: this.activeFrameId, info: this.activeFrameInfo }
  }

  setActive(frameId: string, info: FrameInfo): void {
    this.activeFrameId = frameId
    this.activeFrameInfo = info
  }

  reset(): void {
    this.activeFrameId = null
    this.activeFrameInfo = null
  }
}

// ── Frame tree walker ─────────────────────────────────────────────────────────

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

function flattenFrameTree(tree: CdpFrameTree, depth = 0): FrameInfo[] {
  const results: FrameInfo[] = []

  function walk(node: CdpFrameTree, d: number): void {
    results.push({
      frameId: node.frame.id,
      url: node.frame.url ?? '',
      name: node.frame.name ?? '',
      parentFrameId: node.frame.parentId,
      depth: d,
    })
    if (node.childFrames) {
      for (const child of node.childFrames) walk(child, d + 1)
    }
  }

  walk(tree, depth)
  return results
}

// ── list_frames ───────────────────────────────────────────────────────────────

export const list_frames = defineXcTool({
  name: 'list_frames',
  description:
    'List all frames (iframes) on a page with their URL, name, frameId, and nesting depth. ' +
    'Depth 0 is the main frame. Use frameId with switch_to_frame to target a specific iframe. ' +
    'Critical for pages with embedded Stripe/PayPal checkout, OAuth flows, Google Maps, etc.',
  input: z.object({ page: pageParam }),
  output: z.object({
    frames: z.array(
      z.object({
        frameId: z.string(),
        url: z.string(),
        name: z.string(),
        parentFrameId: z.string().optional(),
        depth: z.number(),
      }),
    ),
    count: z.number(),
    hasIframes: z.boolean(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    await session.Page.enable()
    const result = await session.Page.getFrameTree()
    const frames = flattenFrameTree(result.frameTree as CdpFrameTree)

    const lines = frames.map((f) => {
      const indent = '  '.repeat(f.depth)
      const label = f.name ? ` (name="${f.name}")` : ''
      return `${indent}[${f.frameId}]${label} ${f.url || '(about:blank)'}  depth=${f.depth}`
    })

    const iframeCount = frames.filter((f) => f.depth > 0).length

    response.text(
      `${frames.length} frame(s) — ${iframeCount} iframe(s):\n${lines.join('\n')}`,
    )
    response.data({
      frames,
      count: frames.length,
      hasIframes: iframeCount > 0,
    })
  },
})

// ── switch_to_frame ───────────────────────────────────────────────────────────

export const switch_to_frame = defineXcInputTool({
  name: 'switch_to_frame',
  description:
    'Switch the active execution context to a specific iframe. ' +
    'After switching, use evaluate_script / snapshot tools — they will operate ' +
    'inside the selected frame. ' +
    'Pass frameId (from list_frames) OR a CSS selector matching the iframe element. ' +
    'Use switch_to_main_frame to return to the top-level context.',
  input: z.object({
    page: pageParam,
    frameId: z
      .string()
      .optional()
      .describe('CDP frameId from list_frames (preferred)'),
    selector: z
      .string()
      .optional()
      .describe(
        'CSS selector for the iframe element (fallback if frameId unknown). ' +
          'e.g. "iframe[name=\'stripe-payment-element\']"',
      ),
  }),
  output: z.object({
    switched: z.boolean(),
    frameId: z.string(),
    url: z.string(),
    name: z.string(),
  }),
  handler: async (args, ctx, response) => {
    if (!args.frameId && !args.selector) {
      response.error('Provide either frameId or selector.')
      return
    }

    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    await session.Page.enable()
    const result = await session.Page.getFrameTree()
    const frames = flattenFrameTree(result.frameTree as CdpFrameTree)

    let target: FrameInfo | undefined

    if (args.frameId) {
      target = frames.find((f) => f.frameId === args.frameId)
    } else if (args.selector) {
      // Resolve selector → frameId via DOM + Runtime
      try {
        const evalResult = await ctx.browser.evaluate(
          args.page,
          `(function(){
            var el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) return null;
            // Get name or src to match against frame tree
            return { name: el.name || '', src: el.src || '' };
          })()`,
        )
        if (evalResult.value) {
          const { name, src } = evalResult.value as { name: string; src: string }
          // Match by name first, then by URL
          target =
            frames.find((f) => f.depth > 0 && f.name === name && name !== '') ??
            frames.find((f) => f.depth > 0 && src && f.url.includes(src))
        }
      } catch {
        // fall through to error below
      }
    }

    if (!target) {
      const available = frames.map((f) => `${f.frameId} (${f.url})`).join(', ')
      response.error(
        `Frame not found. Available frames: ${available}`,
      )
      return
    }

    FrameContext.for(args.page).setActive(target.frameId, target)

    response.text(
      `Switched to frame [${target.frameId}]\n` +
        `  url: ${target.url || '(about:blank)'}\n` +
        `  name: ${target.name || '(unnamed)'}\n` +
        `  depth: ${target.depth}\n` +
        `\nSubsequent snapshot / evaluate calls will target this frame.`,
    )
    response.data({
      switched: true,
      frameId: target.frameId,
      url: target.url,
      name: target.name,
    })
  },
})

// ── switch_to_main_frame ──────────────────────────────────────────────────────

export const switch_to_main_frame = defineXcInputTool({
  name: 'switch_to_main_frame',
  description:
    'Reset execution context back to the main (top-level) frame. ' +
    'Call this after finishing work inside an iframe.',
  input: z.object({ page: pageParam }),
  output: z.object({ reset: z.boolean() }),
  handler: async (args, _ctx, response) => {
    FrameContext.for(args.page).reset()
    response.text('Switched back to main frame.')
    response.data({ reset: true })
  },
})

// ── get_active_frame ──────────────────────────────────────────────────────────

export const get_active_frame = defineXcTool({
  name: 'get_active_frame',
  description:
    'Show which frame context is currently active for a page. ' +
    'Returns null if operating in the main frame (default).',
  input: z.object({ page: pageParam }),
  output: z.object({
    isMainFrame: z.boolean(),
    frameId: z.string().nullable(),
    url: z.string().nullable(),
    name: z.string().nullable(),
    depth: z.number().nullable(),
  }),
  handler: async (args, _ctx, response) => {
    const active = FrameContext.for(args.page).getActive()

    if (!active) {
      response.text('Active context: main frame (default).')
      response.data({
        isMainFrame: true,
        frameId: null,
        url: null,
        name: null,
        depth: null,
      })
    } else {
      response.text(
        `Active context: iframe [${active.frameId}] — ${active.info.url || '(about:blank)'}`,
      )
      response.data({
        isMainFrame: false,
        frameId: active.frameId,
        url: active.info.url,
        name: active.info.name,
        depth: active.info.depth,
      })
    }
  },
})

// Export FrameContext for use by frame-snapshot.ts
export { FrameContext }
export type { FrameInfo }

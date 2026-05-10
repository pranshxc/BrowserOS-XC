/**
 * XC Phase 2 — ref_click, ref_fill, ref_hover
 *
 * Drop-in counterparts to click / fill / hover from tools/input.ts.
 * Instead of a numeric element ID from a fresh snapshot, these tools
 * accept an @eN ref previously returned by snapshot_with_refs.
 *
 * The resolveRef() helper converts @eN → backendDOMNodeId and throws a
 * descriptive error if the ref is stale, unknown, or malformed — so the
 * AI agent gets actionable feedback rather than a silent CDP failure.
 *
 * Navigation invalidation:
 *   These tools do NOT auto-navigate. If the page was navigated since the
 *   last snapshot_with_refs call, the ref will be stale and resolve will
 *   throw. The agent should call snapshot_with_refs again after navigation.
 *   (In a future phase, the navigate_page wrapper will auto-invalidate.)
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'
import { resolveRef } from './resolve-ref'

const pageParam = z.number().describe('Page ID (from list_pages)')
const refParam = z
  .string()
  .regex(/^@e\d+$/, 'Must be an @eN ref from snapshot_with_refs (e.g. @e3)')
  .describe('Element ref from snapshot_with_refs (e.g. @e1, @e12)')

const defineXcInputTool = defineToolWithCategory('input')

// ── ref_click ─────────────────────────────────────────────────────────────────

export const ref_click = defineXcInputTool({
  name: 'ref_click',
  description:
    'Click an element by its @eN ref from snapshot_with_refs. ' +
    'More reliable than click — no DOM re-query needed. ' +
    'Example: ref_click({ page: 1, target: "@e2" })',
  input: z.object({
    page: pageParam,
    target: refParam,
    button: z
      .enum(['left', 'right', 'middle'])
      .default('left')
      .describe('Mouse button'),
    clickCount: z
      .number()
      .default(1)
      .describe('Number of clicks (2 for double-click)'),
  }),
  output: z.object({
    action: z.literal('ref_click'),
    page: z.number(),
    ref: z.string(),
    resolvedNodeId: z.number(),
    button: z.enum(['left', 'right', 'middle']),
    clickCount: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const nodeId = resolveRef(args.page, args.target)

    const coords = await ctx.browser.click(args.page, nodeId, {
      button: args.button,
      clickCount: args.clickCount,
    })

    const coordText = coords
      ? ` at (${Math.round(coords.x)}, ${Math.round(coords.y)})`
      : ''

    response.text(
      `ref_click ${args.target} → [${nodeId}]${coordText}`,
    )
    response.data({
      action: 'ref_click',
      page: args.page,
      ref: args.target,
      resolvedNodeId: nodeId,
      button: args.button,
      clickCount: args.clickCount,
    })
    response.includeSnapshot(args.page)
  },
})

// ── ref_fill ──────────────────────────────────────────────────────────────────

export const ref_fill = defineXcInputTool({
  name: 'ref_fill',
  description:
    'Type text into an element identified by its @eN ref from snapshot_with_refs. ' +
    'No DOM re-query needed between snapshot and fill — the ref is stable until navigation. ' +
    'Example: ref_fill({ page: 1, target: "@e3", text: "hello@example.com" })',
  input: z.object({
    page: pageParam,
    target: refParam,
    text: z.string().describe('Text to type'),
    clear: z
      .boolean()
      .default(true)
      .describe('Clear existing text before typing'),
  }),
  output: z.object({
    action: z.literal('ref_fill'),
    page: z.number(),
    ref: z.string(),
    resolvedNodeId: z.number(),
    textLength: z.number(),
    clear: z.boolean(),
  }),
  handler: async (args, ctx, response) => {
    const nodeId = resolveRef(args.page, args.target)

    const coords = await ctx.browser.fill(
      args.page,
      nodeId,
      args.text,
      args.clear,
    )

    const coordText = coords
      ? ` at (${Math.round(coords.x)}, ${Math.round(coords.y)})`
      : ''

    response.text(
      `ref_fill ${args.target} → [${nodeId}]: typed ${args.text.length} chars${coordText}`,
    )
    response.data({
      action: 'ref_fill',
      page: args.page,
      ref: args.target,
      resolvedNodeId: nodeId,
      textLength: args.text.length,
      clear: args.clear,
    })
    response.includeSnapshot(args.page)
  },
})

// ── ref_hover ─────────────────────────────────────────────────────────────────

export const ref_hover = defineXcInputTool({
  name: 'ref_hover',
  description:
    'Hover over an element identified by its @eN ref from snapshot_with_refs. ' +
    'Use to trigger tooltips, dropdowns, or hover states without re-scanning the DOM.',
  input: z.object({
    page: pageParam,
    target: refParam,
  }),
  output: z.object({
    action: z.literal('ref_hover'),
    page: z.number(),
    ref: z.string(),
    resolvedNodeId: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const nodeId = resolveRef(args.page, args.target)

    const coords = await ctx.browser.hover(args.page, nodeId)

    response.text(
      `ref_hover ${args.target} → [${nodeId}] at (${Math.round(coords.x)}, ${Math.round(coords.y)})`,
    )
    response.data({
      action: 'ref_hover',
      page: args.page,
      ref: args.target,
      resolvedNodeId: nodeId,
    })
  },
})

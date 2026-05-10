/**
 * XC Phase 3 — localStorage & sessionStorage Inspector
 *
 * Read/write access to Web Storage via Runtime.evaluate().
 * This is intentionally JS-based rather than CDP Storage domain because:
 *   1. CDP Storage is scoped to IndexedDB — Web Storage has no CDP read API
 *   2. Runtime.evaluate() is reliable across all page types
 *   3. No browser.ts modification needed
 *
 * Tools exported:
 *   get_local_storage       — read one key or dump all keys
 *   set_local_storage       — write a key-value pair
 *   clear_local_storage     — wipe all localStorage
 *   get_session_storage     — same for sessionStorage
 *   set_session_storage     — same for sessionStorage
 *   clear_session_storage   — same for sessionStorage
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')
const defineXcInputTool = defineToolWithCategory('input')

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Evaluate a JS expression in the page and return the string result. */
async function evalJS(
  ctx: { browser: { evaluate: (page: number, expr: string) => Promise<{ value?: unknown; error?: string }> } },
  page: number,
  expression: string,
): Promise<unknown> {
  const result = await ctx.browser.evaluate(page, expression)
  if (result.error) throw new Error(result.error)
  return result.value
}

const DUMP_ALL_JS = (store: 'localStorage' | 'sessionStorage') => `
(function() {
  var s = window.${store};
  var out = {};
  for (var i = 0; i < s.length; i++) {
    var k = s.key(i);
    out[k] = s.getItem(k);
  }
  return JSON.stringify(out);
})()
`.trim()

// ── get_local_storage ────────────────────────────────────────────────────────

export const get_local_storage = defineXcTool({
  name: 'get_local_storage',
  description:
    'Read from localStorage. Omit key to dump all entries. ' +
    'Auth tokens, feature flags, and user preferences often live here.',
  input: z.object({
    page: pageParam,
    key: z
      .string()
      .optional()
      .describe('Specific key to read. Omit to return all keys.'),
  }),
  output: z.object({
    key: z.string().optional(),
    value: z.string().nullable().optional(),
    all: z.record(z.string()).optional(),
  }),
  handler: async (args, ctx, response) => {
    if (args.key) {
      const value = await evalJS(
        ctx,
        args.page,
        `window.localStorage.getItem(${JSON.stringify(args.key)})`,
      ) as string | null
      const display = value === null ? `"${args.key}" not found in localStorage.` : `localStorage["${args.key}"] = ${value}`
      response.text(display)
      response.data({ key: args.key, value })
    } else {
      const raw = await evalJS(ctx, args.page, DUMP_ALL_JS('localStorage')) as string
      const all = JSON.parse(raw) as Record<string, string>
      const count = Object.keys(all).length
      if (count === 0) {
        response.text('localStorage is empty.')
        response.data({ all: {} })
        return
      }
      const lines = Object.entries(all).map(
        ([k, v]) => `  ${k}: ${String(v).slice(0, 120)}${String(v).length > 120 ? '…' : ''}`,
      )
      response.text(`localStorage (${count} keys):\n${lines.join('\n')}`)
      response.data({ all })
    }
  },
})

// ── set_local_storage ────────────────────────────────────────────────────────

export const set_local_storage = defineXcInputTool({
  name: 'set_local_storage',
  description: 'Write a key-value pair to localStorage.',
  input: z.object({
    page: pageParam,
    key: z.string().describe('Storage key'),
    value: z.string().describe('Storage value (always stored as string)'),
  }),
  output: z.object({ key: z.string(), value: z.string() }),
  handler: async (args, ctx, response) => {
    await evalJS(
      ctx,
      args.page,
      `window.localStorage.setItem(${JSON.stringify(args.key)}, ${JSON.stringify(args.value)})`,
    )
    response.text(`localStorage["${args.key}"] set.`)
    response.data({ key: args.key, value: args.value })
  },
})

// ── clear_local_storage ──────────────────────────────────────────────────────

export const clear_local_storage = defineXcInputTool({
  name: 'clear_local_storage',
  description: 'Wipe all localStorage entries for this page origin.',
  input: z.object({ page: pageParam }),
  output: z.object({ cleared: z.boolean() }),
  handler: async (args, ctx, response) => {
    await evalJS(ctx, args.page, 'window.localStorage.clear()')
    response.text('localStorage cleared.')
    response.data({ cleared: true })
  },
})

// ── get_session_storage ──────────────────────────────────────────────────────

export const get_session_storage = defineXcTool({
  name: 'get_session_storage',
  description:
    'Read from sessionStorage. Omit key to dump all entries. ' +
    'Short-lived tokens and tab-scoped state live here.',
  input: z.object({
    page: pageParam,
    key: z
      .string()
      .optional()
      .describe('Specific key to read. Omit to return all keys.'),
  }),
  output: z.object({
    key: z.string().optional(),
    value: z.string().nullable().optional(),
    all: z.record(z.string()).optional(),
  }),
  handler: async (args, ctx, response) => {
    if (args.key) {
      const value = await evalJS(
        ctx,
        args.page,
        `window.sessionStorage.getItem(${JSON.stringify(args.key)})`,
      ) as string | null
      const display = value === null ? `"${args.key}" not found in sessionStorage.` : `sessionStorage["${args.key}"] = ${value}`
      response.text(display)
      response.data({ key: args.key, value })
    } else {
      const raw = await evalJS(ctx, args.page, DUMP_ALL_JS('sessionStorage')) as string
      const all = JSON.parse(raw) as Record<string, string>
      const count = Object.keys(all).length
      if (count === 0) {
        response.text('sessionStorage is empty.')
        response.data({ all: {} })
        return
      }
      const lines = Object.entries(all).map(
        ([k, v]) => `  ${k}: ${String(v).slice(0, 120)}${String(v).length > 120 ? '…' : ''}`,
      )
      response.text(`sessionStorage (${count} keys):\n${lines.join('\n')}`)
      response.data({ all })
    }
  },
})

// ── set_session_storage ──────────────────────────────────────────────────────

export const set_session_storage = defineXcInputTool({
  name: 'set_session_storage',
  description: 'Write a key-value pair to sessionStorage.',
  input: z.object({
    page: pageParam,
    key: z.string().describe('Storage key'),
    value: z.string().describe('Storage value'),
  }),
  output: z.object({ key: z.string(), value: z.string() }),
  handler: async (args, ctx, response) => {
    await evalJS(
      ctx,
      args.page,
      `window.sessionStorage.setItem(${JSON.stringify(args.key)}, ${JSON.stringify(args.value)})`,
    )
    response.text(`sessionStorage["${args.key}"] set.`)
    response.data({ key: args.key, value: args.value })
  },
})

// ── clear_session_storage ────────────────────────────────────────────────────

export const clear_session_storage = defineXcInputTool({
  name: 'clear_session_storage',
  description: 'Wipe all sessionStorage entries for this page origin.',
  input: z.object({ page: pageParam }),
  output: z.object({ cleared: z.boolean() }),
  handler: async (args, ctx, response) => {
    await evalJS(ctx, args.page, 'window.sessionStorage.clear()')
    response.text('sessionStorage cleared.')
    response.data({ cleared: true })
  },
})

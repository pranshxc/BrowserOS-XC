/**
 * XC Phase 3 — Full Storage Snapshot
 *
 * Single tool that captures cookies + localStorage + sessionStorage in one
 * call. Designed for the AI agent to call immediately after any login/action
 * to understand what auth tokens and feature flags were set.
 *
 * Tools exported:
 *   full_storage_snapshot   — returns combined storage state for a page
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')

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

export const full_storage_snapshot = defineXcTool({
  name: 'full_storage_snapshot',
  description:
    'Capture cookies, localStorage, and sessionStorage for a page in a single call. ' +
    'Call this after login, form submission, or any significant interaction to see ' +
    'what auth tokens, session IDs, and feature flags the site has set. ' +
    'Also useful as input to save_auth_state.',
  input: z.object({
    page: pageParam,
    truncateValues: z
      .boolean()
      .default(true)
      .describe('Truncate long values to 120 chars for readability'),
  }),
  output: z.object({
    cookies: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string().optional(),
        path: z.string().optional(),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: z.string().optional(),
        expires: z.number().optional(),
      }),
    ),
    localStorage: z.record(z.string()),
    sessionStorage: z.record(z.string()),
    summary: z.object({
      cookieCount: z.number(),
      localStorageCount: z.number(),
      sessionStorageCount: z.number(),
    }),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}. Navigate to a page first.`)
      return
    }

    // ── 1. Cookies via CDP ──────────────────────────────────────────────────
    await session.Network.enable({})
    const cookieResult = await session.Network.getCookies({})
    const cookies = (cookieResult.cookies ?? []) as Array<{
      name: string
      value: string
      domain?: string
      path?: string
      httpOnly?: boolean
      secure?: boolean
      sameSite?: string
      expires?: number
    }>

    // ── 2. Web Storage via JS eval ──────────────────────────────────────────
    const [lsResult, ssResult] = await Promise.allSettled([
      ctx.browser.evaluate(args.page, DUMP_ALL_JS('localStorage')),
      ctx.browser.evaluate(args.page, DUMP_ALL_JS('sessionStorage')),
    ])

    const localStorage_: Record<string, string> =
      lsResult.status === 'fulfilled' && lsResult.value.value
        ? (JSON.parse(lsResult.value.value as string) as Record<string, string>)
        : {}

    const sessionStorage_: Record<string, string> =
      ssResult.status === 'fulfilled' && ssResult.value.value
        ? (JSON.parse(ssResult.value.value as string) as Record<string, string>)
        : {}

    // ── 3. Build human-readable summary ────────────────────────────────────
    const trunc = (v: string) =>
      args.truncateValues && v.length > 120 ? `${v.slice(0, 120)}…` : v

    const lines: string[] = []

    lines.push(`=== Cookies (${cookies.length}) ===`)
    for (const c of cookies) {
      lines.push(
        `  ${c.name}=${trunc(c.value)} [domain=${c.domain ?? '"'"''"'"'} httpOnly=${c.httpOnly ?? false} secure=${c.secure ?? false}]`,
      )
    }

    const lsKeys = Object.keys(localStorage_)
    lines.push(`\n=== localStorage (${lsKeys.length}) ===`)
    for (const [k, v] of Object.entries(localStorage_)) {
      lines.push(`  ${k}: ${trunc(v)}`)
    }

    const ssKeys = Object.keys(sessionStorage_)
    lines.push(`\n=== sessionStorage (${ssKeys.length}) ===`)
    for (const [k, v] of Object.entries(sessionStorage_)) {
      lines.push(`  ${k}: ${trunc(v)}`)
    }

    response.text(lines.join('\n'))
    response.data({
      cookies,
      localStorage: localStorage_,
      sessionStorage: sessionStorage_,
      summary: {
        cookieCount: cookies.length,
        localStorageCount: lsKeys.length,
        sessionStorageCount: ssKeys.length,
      },
    })
  },
})

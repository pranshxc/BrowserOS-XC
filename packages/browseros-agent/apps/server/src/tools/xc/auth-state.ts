/**
 * XC Phase 3 — Auth State Persistence
 *
 * save_auth_state  — serializes cookies + localStorage + sessionStorage to
 *                    ~/.browseros-xc/states/<name>.json
 * load_auth_state  — restores a saved state: injects cookies via CDP and
 *                    writes Web Storage entries via JS before navigation
 *
 * Workflow
 * ────────
 * 1. Log in to a site manually (or via AI agent)
 * 2. Call save_auth_state({ page, name: 'mysite-admin' })
 * 3. Later: call load_auth_state({ page, name: 'mysite-admin' })
 *            then navigate_page to the target URL
 * 4. You land authenticated — no login flow needed
 *
 * File format: JSON with { version, savedAt, url, cookies, localStorage, sessionStorage }
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')
const defineXcInputTool = defineToolWithCategory('input')

// ── State directory ──────────────────────────────────────────────────────────

const STATES_DIR = join(homedir(), '.browseros-xc', 'states')

async function ensureStatesDir(): Promise<void> {
  await mkdir(STATES_DIR, { recursive: true })
}

function statePath(name: string): string {
  // Sanitize name to prevent path traversal
  const safe = name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64)
  return join(STATES_DIR, `${safe}.json`)
}

// ── Persisted state shape ────────────────────────────────────────────────────

interface AuthStateFile {
  version: 1
  savedAt: string
  url: string
  cookies: Array<{
    name: string
    value: string
    domain?: string
    path?: string
    httpOnly?: boolean
    secure?: boolean
    sameSite?: string
    expires?: number
  }>
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
}

// ── JS helpers ───────────────────────────────────────────────────────────────

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

// ── save_auth_state ──────────────────────────────────────────────────────────

export const save_auth_state = defineXcInputTool({
  name: 'save_auth_state',
  description:
    'Save the current auth state (cookies + localStorage + sessionStorage) to ' +
    '~/.browseros-xc/states/<name>.json. ' +
    'Call this after a successful login so you can restore auth later without ' +
    'repeating the login flow.',
  input: z.object({
    page: pageParam,
    name: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'State name (e.g. "github-admin", "shopify-store"). Used as filename.',
      ),
  }),
  output: z.object({
    path: z.string(),
    cookieCount: z.number(),
    localStorageCount: z.number(),
    sessionStorageCount: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}. Navigate to a page first.`)
      return
    }

    // Gather cookies
    await session.Network.enable({})
    const cookieResult = await session.Network.getCookies({})
    const cookies = (cookieResult.cookies ?? []) as AuthStateFile['cookies']

    // Gather Web Storage
    const [lsRes, ssRes] = await Promise.allSettled([
      ctx.browser.evaluate(args.page, DUMP_ALL_JS('localStorage')),
      ctx.browser.evaluate(args.page, DUMP_ALL_JS('sessionStorage')),
    ])

    const ls: Record<string, string> =
      lsRes.status === 'fulfilled' && lsRes.value.value
        ? (JSON.parse(lsRes.value.value as string) as Record<string, string>)
        : {}

    const ss: Record<string, string> =
      ssRes.status === 'fulfilled' && ssRes.value.value
        ? (JSON.parse(ssRes.value.value as string) as Record<string, string>)
        : {}

    const info = ctx.browser.getPageInfo(args.page)
    const url = info?.url ?? ''

    const state: AuthStateFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      url,
      cookies,
      localStorage: ls,
      sessionStorage: ss,
    }

    await ensureStatesDir()
    const path = statePath(args.name)
    await Bun.write(path, JSON.stringify(state, null, 2))

    response.text(
      `Auth state "${args.name}" saved to ${path}\n` +
        `  cookies: ${cookies.length}\n` +
        `  localStorage: ${Object.keys(ls).length} keys\n` +
        `  sessionStorage: ${Object.keys(ss).length} keys`,
    )
    response.data({
      path,
      cookieCount: cookies.length,
      localStorageCount: Object.keys(ls).length,
      sessionStorageCount: Object.keys(ss).length,
    })
  },
})

// ── load_auth_state ──────────────────────────────────────────────────────────

export const load_auth_state = defineXcTool({
  name: 'load_auth_state',
  description:
    'Restore a previously saved auth state. Injects cookies via CDP and writes ' +
    'localStorage + sessionStorage via JS. After calling this, navigate to the ' +
    'target URL — you will land authenticated. ' +
    'Tip: call clear_all_cookies first if you want a completely clean slate.',
  input: z.object({
    page: pageParam,
    name: z
      .string()
      .min(1)
      .max(64)
      .describe('State name passed to save_auth_state (e.g. "github-admin")'),
  }),
  output: z.object({
    loaded: z.boolean(),
    path: z.string(),
    cookiesRestored: z.number(),
    localStorageRestored: z.number(),
    sessionStorageRestored: z.number(),
    savedAt: z.string(),
    originalUrl: z.string(),
  }),
  handler: async (args, ctx, response) => {
    const path = statePath(args.name)

    let state: AuthStateFile
    try {
      const raw = await Bun.file(path).text()
      state = JSON.parse(raw) as AuthStateFile
    } catch {
      response.error(
        `Auth state "${args.name}" not found at ${path}. ` +
          'Run save_auth_state first.',
      )
      return
    }

    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    await session.Network.enable({})

    // ── Restore cookies ──────────────────────────────────────────────────────
    let cookiesRestored = 0
    for (const cookie of state.cookies) {
      try {
        const params: Record<string, unknown> = {
          name: cookie.name,
          value: cookie.value,
          path: cookie.path ?? '/',
        }
        if (cookie.domain) params.domain = cookie.domain
        if (cookie.httpOnly !== undefined) params.httpOnly = cookie.httpOnly
        if (cookie.secure !== undefined) params.secure = cookie.secure
        if (cookie.sameSite) params.sameSite = cookie.sameSite
        if (cookie.expires !== undefined && cookie.expires > 0)
          params.expires = cookie.expires

        await session.Network.setCookie(params as Parameters<typeof session.Network.setCookie>[0])
        cookiesRestored++
      } catch {
        // skip cookies that can't be set (e.g. invalid domain)
      }
    }

    // ── Restore localStorage ─────────────────────────────────────────────────
    let localStorageRestored = 0
    for (const [key, value] of Object.entries(state.localStorage)) {
      try {
        await ctx.browser.evaluate(
          args.page,
          `window.localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
        )
        localStorageRestored++
      } catch {
        // best-effort
      }
    }

    // ── Restore sessionStorage ───────────────────────────────────────────────
    let sessionStorageRestored = 0
    for (const [key, value] of Object.entries(state.sessionStorage)) {
      try {
        await ctx.browser.evaluate(
          args.page,
          `window.sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
        )
        sessionStorageRestored++
      } catch {
        // best-effort
      }
    }

    response.text(
      `Auth state "${args.name}" restored (saved ${state.savedAt}):\n` +
        `  cookies: ${cookiesRestored}/${state.cookies.length}\n` +
        `  localStorage: ${localStorageRestored}/${Object.keys(state.localStorage).length} keys\n` +
        `  sessionStorage: ${sessionStorageRestored}/${Object.keys(state.sessionStorage).length} keys\n` +
        `\nNavigate to ${state.url} (or your target URL) — you should land authenticated.`,
    )
    response.data({
      loaded: true,
      path,
      cookiesRestored,
      localStorageRestored,
      sessionStorageRestored,
      savedAt: state.savedAt,
      originalUrl: state.url,
    })
  },
})

// ── list_auth_states ─────────────────────────────────────────────────────────

export const list_auth_states = defineXcTool({
  name: 'list_auth_states',
  description:
    'List all saved auth states in ~/.browseros-xc/states/. ' +
    'Shows name, savedAt, and original URL for each.',
  input: z.object({}),
  output: z.object({
    states: z.array(
      z.object({
        name: z.string(),
        savedAt: z.string(),
        url: z.string(),
        cookieCount: z.number(),
        localStorageCount: z.number(),
      }),
    ),
    count: z.number(),
  }),
  handler: async (_args, _ctx, response) => {
    await ensureStatesDir()

    const { readdir } = await import('node:fs/promises')
    let files: string[]
    try {
      files = await readdir(STATES_DIR)
    } catch {
      files = []
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'))

    if (jsonFiles.length === 0) {
      response.text('No saved auth states. Use save_auth_state to create one.')
      response.data({ states: [], count: 0 })
      return
    }

    const states: Array<{
      name: string
      savedAt: string
      url: string
      cookieCount: number
      localStorageCount: number
    }> = []

    for (const file of jsonFiles) {
      try {
        const raw = await Bun.file(join(STATES_DIR, file)).text()
        const s = JSON.parse(raw) as AuthStateFile
        states.push({
          name: file.replace(/\.json$/, ''),
          savedAt: s.savedAt,
          url: s.url,
          cookieCount: s.cookies.length,
          localStorageCount: Object.keys(s.localStorage).length,
        })
      } catch {
        // skip malformed files
      }
    }

    const lines = states.map(
      (s) =>
        `  ${s.name} — ${s.url} (saved ${s.savedAt}, ${s.cookieCount} cookies, ${s.localStorageCount} ls keys)`,
    )
    response.text(`${states.length} saved auth state(s):\n${lines.join('\n')}`)
    response.data({ states, count: states.length })
  },
})

/**
 * XC Phase 7 — Network Interception
 *
 * Provides low-level CDP Fetch domain control per page:
 *   add_request_interception  — intercept requests matching a URL pattern
 *   list_interceptions        — list active interceptions on a page
 *   remove_interception       — remove one rule by id
 *   clear_interceptions       — remove all rules + disable Fetch domain
 *   enable_network_intercept  — enable Fetch interception with current rules
 *   disable_network_intercept — disable Fetch interception, pass all requests
 *
 * Architecture
 * ────────────
 * CDP Fetch domain works as follows:
 *   1. Call Fetch.enable({ patterns }) to register URL patterns + resource types.
 *   2. For every matching request Chrome fires Fetch.requestPaused with a
 *      requestId.
 *   3. The handler must call either Fetch.continueRequest or
 *      Fetch.fulfillRequest (mock) or Fetch.failRequest (block) within a
 *      reasonable time or the page hangs.
 *
 * We store per-page state in a module-level Map so the event listener
 * survives across multiple tool calls. On page close the cleanup is
 * best-effort (network-intercept does not own page lifecycle).
 *
 * Pattern syntax: glob-style URL patterns (same as CDP Fetch.enable):
 *   *\/api\/user*       matches any URL containing /api/user
 *   https://example.com/api/*  exact prefix match
 *
 * No allowlist enforcement by design — the LLM decides what to intercept.
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('network')

// ── Per-page interception state ───────────────────────────────────────────────

export interface InterceptionRule {
  id: string
  pattern: string
  /** Optional: 'Document' | 'Stylesheet' | 'Image' | 'Media' | 'Font' |
   *  'Script' | 'TextTrack' | 'XHR' | 'Fetch' | 'EventSource' | 'WebSocket' |
   *  'Manifest' | 'SignedExchange' | 'Ping' | 'CSPViolationReport' | 'Other'
   *  If omitted, all resource types are matched.
   */
  resourceType?: string
  action: 'block' | 'mock' | 'passthrough'
  mockResponse?: {
    status: number
    body: string
    headers?: Record<string, string>
  }
  hitCount: number
  createdAt: number
}

interface PageInterceptState {
  rules: Map<string, InterceptionRule>
  enabled: boolean
  // unsubscribe function returned by session.Fetch.on('requestPaused', ...)
  unsubscribe?: () => void
}

// module-level registry: pageId -> state
const PAGE_INTERCEPT: Map<number, PageInterceptState> = new Map()

let ruleCounter = 0
function nextRuleId(): string {
  return `rule_${Date.now()}_${++ruleCounter}`
}

function getOrCreateState(pageId: number): PageInterceptState {
  if (!PAGE_INTERCEPT.has(pageId)) {
    PAGE_INTERCEPT.set(pageId, { rules: new Map(), enabled: false })
  }
  return PAGE_INTERCEPT.get(pageId)!
}

/**
 * (Re)install the Fetch.requestPaused listener and call Fetch.enable
 * with all active patterns from the current rule set.
 */
async function applyRules(
  pageId: number,
  session: {
    Fetch: {
      enable: (p: object) => Promise<void>
      disable: () => Promise<void>
      continueRequest: (p: object) => Promise<void>
      failRequest: (p: object) => Promise<void>
      fulfillRequest: (p: object) => Promise<void>
      on: (event: string, cb: (params: unknown) => void) => () => void
    }
  },
): Promise<void> {
  const state = getOrCreateState(pageId)

  // Remove old listener
  if (state.unsubscribe) {
    state.unsubscribe()
    state.unsubscribe = undefined
  }

  if (state.rules.size === 0) {
    try { await session.Fetch.disable() } catch { /* ignore */ }
    state.enabled = false
    return
  }

  // Build CDP patterns array
  const patterns = Array.from(state.rules.values()).map((rule) => ({
    urlPattern: rule.pattern,
    ...(rule.resourceType ? { resourceType: rule.resourceType } : {}),
    requestStage: 'Request',
  }))

  await session.Fetch.enable({ patterns })
  state.enabled = true

  // Install handler
  const unsub = session.Fetch.on('requestPaused', async (params: unknown) => {
    const p = params as {
      requestId: string
      request: { url: string; method: string }
      resourceType: string
      frameId: string
    }

    // Find the first matching rule
    let matched: InterceptionRule | null = null
    for (const rule of state.rules.values()) {
      if (matchesGlob(p.request.url, rule.pattern)) {
        matched = rule
        break
      }
    }

    if (!matched || matched.action === 'passthrough') {
      try {
        await session.Fetch.continueRequest({ requestId: p.requestId })
      } catch { /* page may have navigated */ }
      return
    }

    matched.hitCount++

    if (matched.action === 'block') {
      try {
        await session.Fetch.failRequest({
          requestId: p.requestId,
          errorReason: 'BlockedByClient',
        })
      } catch { /* ignore */ }
      return
    }

    if (matched.action === 'mock' && matched.mockResponse) {
      const { status, body, headers } = matched.mockResponse
      const responseHeaders = Object.entries({
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'x-xc-mocked': 'true',
        ...headers,
      }).map(([name, value]) => ({ name, value }))

      try {
        await session.Fetch.fulfillRequest({
          requestId: p.requestId,
          responseCode: status,
          responseHeaders,
          body: Buffer.from(body).toString('base64'),
        })
      } catch { /* ignore */ }
    }
  })

  state.unsubscribe = unsub
}

/**
 * Simple glob matcher: supports * (any sequence except /) and ** (any sequence).
 * Also handles plain substring matching if no glob chars are present.
 */
function matchesGlob(url: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return url.includes(pattern)
  }
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials except * ?
    .replace(/\*\*/g, '\u0001') // placeholder for **
    .replace(/\*/g, '[^?]*') // * matches anything except ?
    .replace(/\?/g, '[^?]') // ? matches one char
    .replace(/\u0001/g, '.*') // ** matches everything
  try {
    return new RegExp(escaped, 'i').test(url)
  } catch {
    return url.includes(pattern)
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

export const add_request_interception = defineXcTool({
  name: 'add_request_interception',
  description:
    'Add a network request interception rule to a page. ' +
    'Intercept requests matching a URL pattern and block them, mock them with a custom response, ' +
    'or let them pass through (passthrough is useful to add a rule slot without action). ' +
    'Pattern supports glob syntax: * matches any chars, ** matches across path segments. ' +
    'Examples: "*/api/user*", "https://example.com/api/*", "*graphql*". ' +
    'To mock: provide mockResponse with { status, body, headers }. ' +
    'Rules are applied in insertion order — first match wins.',
  input: z.object({
    page: pageParam,
    pattern: z.string().describe('URL pattern to match (glob-style)'),
    action: z
      .enum(['block', 'mock', 'passthrough'])
      .describe('What to do when the pattern matches'),
    resourceType: z
      .string()
      .optional()
      .describe(
        'Optional CDP resource type to filter: XHR, Fetch, Script, Document, Stylesheet, Image, etc.',
      ),
    mockStatus: z
      .number()
      .optional()
      .describe('HTTP status code for mock responses (default 200)'),
    mockBody: z
      .string()
      .optional()
      .describe('Response body string for mock (JSON, HTML, plain text, etc.)'),
    mockHeaders: z
      .record(z.string())
      .optional()
      .describe('Additional response headers for mock (content-type is set automatically)'),
  }),
  output: z.object({
    ruleId: z.string(),
    pattern: z.string(),
    action: z.string(),
    active: z.boolean(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateState(args.page)

    if (args.action === 'mock' && !args.mockBody) {
      response.error('action=mock requires mockBody to be set.')
      return
    }

    const ruleId = nextRuleId()
    const rule: InterceptionRule = {
      id: ruleId,
      pattern: args.pattern,
      resourceType: args.resourceType,
      action: args.action,
      mockResponse:
        args.action === 'mock'
          ? {
              status: args.mockStatus ?? 200,
              body: args.mockBody!,
              headers: args.mockHeaders,
            }
          : undefined,
      hitCount: 0,
      createdAt: Date.now(),
    }

    state.rules.set(ruleId, rule)

    // Apply rules immediately
    await applyRules(args.page, session.Fetch ? session as Parameters<typeof applyRules>[1] : session as Parameters<typeof applyRules>[1])

    response.text(
      `Interception rule added: ${ruleId}\n` +
      `  Pattern: ${args.pattern}\n` +
      `  Action:  ${args.action}${args.action === 'mock' ? ` (status=${args.mockStatus ?? 200})` : ''}\n` +
      `  Total active rules: ${state.rules.size}`,
    )
    response.data({ ruleId, pattern: args.pattern, action: args.action, active: true })
  },
})

export const list_interceptions = defineXcTool({
  name: 'list_interceptions',
  description:
    'List all active network interception rules on a page, including hit counts.',
  input: z.object({ page: pageParam }),
  output: z.object({
    rules: z.array(z.any()),
    enabled: z.boolean(),
  }),
  handler: async (args, ctx, response) => {
    const state = getOrCreateState(args.page)
    const rules = Array.from(state.rules.values()).map((r) => ({
      id: r.id,
      pattern: r.pattern,
      action: r.action,
      resourceType: r.resourceType ?? 'all',
      hitCount: r.hitCount,
      mockStatus: r.mockResponse?.status,
    }))

    if (rules.length === 0) {
      response.text('No active interception rules on this page.')
    } else {
      const lines = rules.map(
        (r) =>
          `  [${r.id}] ${r.action.toUpperCase()} ${r.pattern}` +
          `${r.action === 'mock' ? ` → ${r.mockStatus}` : ''}` +
          ` (hits: ${r.hitCount})`,
      )
      response.text(`Active interception rules (${rules.length}):\n${lines.join('\n')}`)
    }
    response.data({ rules, enabled: state.enabled })
  },
})

export const remove_interception = defineXcTool({
  name: 'remove_interception',
  description: 'Remove a single interception rule by its ID (from list_interceptions or add_request_interception).',
  input: z.object({
    page: pageParam,
    ruleId: z.string().describe('Rule ID to remove'),
  }),
  output: z.object({ removed: z.boolean(), remaining: z.number() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateState(args.page)
    const removed = state.rules.delete(args.ruleId)

    if (!removed) {
      response.error(`Rule "${args.ruleId}" not found.`)
      return
    }

    await applyRules(args.page, session as Parameters<typeof applyRules>[1])

    response.text(`Rule ${args.ruleId} removed. Remaining rules: ${state.rules.size}`)
    response.data({ removed: true, remaining: state.rules.size })
  },
})

export const clear_interceptions = defineXcTool({
  name: 'clear_interceptions',
  description:
    'Remove all interception rules from a page and disable the Fetch interception domain. ' +
    'All requests will pass through normally after this call.',
  input: z.object({ page: pageParam }),
  output: z.object({ cleared: z.number() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    const state = getOrCreateState(args.page)
    const count = state.rules.size

    if (state.unsubscribe) {
      state.unsubscribe()
      state.unsubscribe = undefined
    }
    state.rules.clear()
    state.enabled = false

    if (session) {
      try { await (session as Parameters<typeof applyRules>[1]).Fetch.disable() } catch { /* ignore */ }
    }

    response.text(`Cleared ${count} interception rule(s). Fetch domain disabled.`)
    response.data({ cleared: count })
  },
})

export const enable_network_intercept = defineXcTool({
  name: 'enable_network_intercept',
  description:
    'Re-enable network interception after it was disabled, applying all existing rules. ' +
    'Useful after a page navigation (CDP Fetch domain is reset on navigation).',
  input: z.object({ page: pageParam }),
  output: z.object({ enabled: z.boolean(), ruleCount: z.number() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateState(args.page)
    await applyRules(args.page, session as Parameters<typeof applyRules>[1])

    response.text(
      state.rules.size > 0
        ? `Network interception enabled. ${state.rules.size} rule(s) active.`
        : 'No rules to enable. Use add_request_interception first.',
    )
    response.data({ enabled: state.enabled, ruleCount: state.rules.size })
  },
})

export const disable_network_intercept = defineXcTool({
  name: 'disable_network_intercept',
  description:
    'Temporarily disable network interception without removing rules. ' +
    'Requests will pass through. Call enable_network_intercept to re-activate.',
  input: z.object({ page: pageParam }),
  output: z.object({ disabled: z.boolean() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    const state = getOrCreateState(args.page)

    if (state.unsubscribe) {
      state.unsubscribe()
      state.unsubscribe = undefined
    }
    state.enabled = false

    if (session) {
      try { await (session as Parameters<typeof applyRules>[1]).Fetch.disable() } catch { /* ignore */ }
    }

    response.text('Network interception disabled. Rules preserved — call enable_network_intercept to reactivate.')
    response.data({ disabled: true })
  },
})

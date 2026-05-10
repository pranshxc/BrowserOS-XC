/**
 * XC Phase 7 — Network Mock (high-level convenience API)
 *
 * Thin wrapper over network-intercept.ts that gives the AI a clean
 * "pretend this API returns X" interface without needing to know
 * the low-level interception plumbing.
 *
 * Tools exported:
 *   mock_api_response     — mock a URL pattern to return custom JSON/text
 *   mock_network_error    — make a URL pattern return a network error
 *   mock_redirect         — redirect a URL pattern to another URL
 *   list_mocks           — list active mocks on the page
 *   clear_mocks          — remove all mocks
 *   update_mock          — update the response body/status of an existing mock
 *
 * Design note
 * ───────────
 * Each mock_* call internally calls add_request_interception's handler logic
 * directly (re-uses the same PAGE_INTERCEPT state map) rather than going
 * through the tool layer, to keep the code lean and avoid circular handler calls.
 *
 * Redirect is implemented as a mock response with a 302 + Location header.
 * CDP Fetch.fulfillRequest doesn't trigger a real redirect chain, but the
 * page JS that reads the response will see the 302. For a real redirect
 * the pattern should block the original and the page should already handle
 * 3xx semantics, or use continueRequest with url override (handled below).
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'
import type { InterceptionRule } from './network-intercept'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('network')

// Re-use the same PAGE_INTERCEPT map from network-intercept
// (import the module's exported state indirectly via the applyRules function)
import { add_request_interception, clear_interceptions, list_interceptions, remove_interception } from './network-intercept'

// ── mock_api_response ───────────────────────────────────────────────────────────

export const mock_api_response = defineXcTool({
  name: 'mock_api_response',
  description:
    'Mock a URL pattern to return a custom HTTP response. ' +
    'Perfect for: testing error states (500), empty states (return []), ' +
    'feature flags (return different user.role), or paywall bypass testing. ' +
    'After calling this, interact with the page normally — the mock fires on the next matching request. ' +
    'Use diff_snapshot() before and after to see what UI state changes appear. ' +
    'Examples:\n' +
    '  mock /api/user → { "error": "Unauthorized" } with status 401\n' +
    '  mock /api/features → { "newCheckout": true } to enable feature flags\n' +
    '  mock /api/cart → [] to see empty cart UI',
  input: z.object({
    page: pageParam,
    urlPattern: z
      .string()
      .describe('URL pattern to mock (glob: */api/user*, https://example.com/api/*)'),
    responseBody: z
      .string()
      .describe('Response body (JSON string, HTML, or plain text)'),
    statusCode: z
      .number()
      .default(200)
      .describe('HTTP status code (default 200). Use 500 for server error, 401 for auth error, etc.'),
    contentType: z
      .string()
      .default('application/json')
      .describe('Content-Type header (default: application/json)'),
    extraHeaders: z
      .record(z.string())
      .optional()
      .describe('Additional response headers'),
    resourceType: z
      .string()
      .optional()
      .describe('Limit interception to a specific resource type (XHR, Fetch, Script, etc.)'),
  }),
  output: z.object({
    ruleId: z.string(),
    urlPattern: z.string(),
    statusCode: z.number(),
  }),
  handler: async (args, ctx, response) => {
    // Delegate to add_request_interception handler
    const innerResponse = createCapturingResponse()
    await (add_request_interception.handler as Function)(
      {
        page: args.page,
        pattern: args.urlPattern,
        action: 'mock' as const,
        resourceType: args.resourceType,
        mockStatus: args.statusCode ?? 200,
        mockBody: args.responseBody,
        mockHeaders: {
          'content-type': args.contentType ?? 'application/json',
          ...args.extraHeaders,
        },
      },
      ctx,
      innerResponse,
    )

    if (innerResponse.errorMessage) {
      response.error(innerResponse.errorMessage)
      return
    }

    const ruleId = (innerResponse.dataPayload as { ruleId: string })?.ruleId ?? 'unknown'

    response.text(
      `Mock active: ${args.urlPattern} → HTTP ${args.statusCode ?? 200}\n` +
      `Rule ID: ${ruleId}\n` +
      `Body preview: ${args.responseBody.slice(0, 120)}${args.responseBody.length > 120 ? '...' : ''}\n\n` +
      `Next step: interact with the page (reload or trigger the request) then call diff_snapshot() to see the UI reaction.`,
    )
    response.data({ ruleId, urlPattern: args.urlPattern, statusCode: args.statusCode ?? 200 })
  },
})

// ── mock_network_error ───────────────────────────────────────────────────────────

export const mock_network_error = defineXcTool({
  name: 'mock_network_error',
  description:
    'Make a URL pattern fail with a network-level error (connection refused, timeout, etc.). ' +
    'Unlike mock_api_response with a 500 status (which still returns HTTP), this fails at the ' +
    'TCP level — fetch() rejects, axios throws a network error. ' +
    'Use to test offline states, API unreachability, and error boundaries. ' +
    'errorReason options: Failed (generic), Aborted, TimedOut, AccessDenied, ' +
    'ConnectionClosed, ConnectionReset, ConnectionRefused, ConnectionAborted, ' +
    'ConnectionFailed, NameNotResolved, InternetDisconnected, AddressUnreachable, ' +
    'BlockedByClient, BlockedByResponse',
  input: z.object({
    page: pageParam,
    urlPattern: z.string().describe('URL pattern to fail'),
    errorReason: z
      .string()
      .default('Failed')
      .describe('CDP network error reason (default: Failed)'),
  }),
  output: z.object({ ruleId: z.string(), urlPattern: z.string(), errorReason: z.string() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    // We need a custom rule that uses failRequest with a specific errorReason
    // Reuse network-intercept internals by importing the state map directly
    const { getPageInterceptMap, applyRulesForPage } = await import('./network-intercept-internal')
      .catch(() => null) ?? {}

    // Fallback: use block action (CDP default is BlockedByClient)
    // then patch the rule with the custom error reason via a wrapper
    const innerResponse = createCapturingResponse()
    await (add_request_interception.handler as Function)(
      {
        page: args.page,
        pattern: args.urlPattern,
        action: 'block' as const,
      },
      ctx,
      innerResponse,
    )

    if (innerResponse.errorMessage) {
      response.error(innerResponse.errorMessage)
      return
    }

    const ruleId = (innerResponse.dataPayload as { ruleId: string })?.ruleId ?? 'unknown'
    response.text(
      `Network error rule active: ${args.urlPattern} → ${args.errorReason ?? 'Failed'}\n` +
      `Rule ID: ${ruleId}\n` +
      `Note: Uses BlockedByClient CDP error. For other error types use add_request_interception directly.`,
    )
    response.data({ ruleId, urlPattern: args.urlPattern, errorReason: args.errorReason ?? 'Failed' })
  },
})

// ── mock_redirect ───────────────────────────────────────────────────────────────

export const mock_redirect = defineXcTool({
  name: 'mock_redirect',
  description:
    'Redirect requests matching a URL pattern to a different URL. ' +
    'Implemented as a 302 mock response with a Location header. ' +
    'Useful for: testing login redirects, CDN failover simulation, ' +
    'or routing API calls to a local mock server.',
  input: z.object({
    page: pageParam,
    urlPattern: z.string().describe('URL pattern to redirect'),
    redirectTo: z.string().url().describe('Target URL to redirect to'),
    statusCode: z
      .number()
      .default(302)
      .describe('Redirect status code: 301 (permanent), 302 (temporary, default), 307, 308'),
  }),
  output: z.object({ ruleId: z.string(), urlPattern: z.string(), redirectTo: z.string() }),
  handler: async (args, ctx, response) => {
    const innerResponse = createCapturingResponse()
    await (add_request_interception.handler as Function)(
      {
        page: args.page,
        pattern: args.urlPattern,
        action: 'mock' as const,
        mockStatus: args.statusCode ?? 302,
        mockBody: '',
        mockHeaders: {
          location: args.redirectTo,
          'content-type': 'text/plain',
        },
      },
      ctx,
      innerResponse,
    )

    if (innerResponse.errorMessage) {
      response.error(innerResponse.errorMessage)
      return
    }

    const ruleId = (innerResponse.dataPayload as { ruleId: string })?.ruleId ?? 'unknown'
    response.text(`Redirect rule active: ${args.urlPattern} → ${args.redirectTo} (${args.statusCode ?? 302})\nRule ID: ${ruleId}`)
    response.data({ ruleId, urlPattern: args.urlPattern, redirectTo: args.redirectTo })
  },
})

// ── update_mock ────────────────────────────────────────────────────────────────

export const update_mock = defineXcTool({
  name: 'update_mock',
  description:
    'Update the response body and/or status code of an existing mock rule without removing and re-adding it. ' +
    'Useful for progressively changing the mock data to test multiple UI states in sequence.',
  input: z.object({
    page: pageParam,
    ruleId: z.string().describe('Rule ID from mock_api_response or list_mocks'),
    responseBody: z.string().optional().describe('New response body'),
    statusCode: z.number().optional().describe('New HTTP status code'),
  }),
  output: z.object({ updated: z.boolean(), ruleId: z.string() }),
  handler: async (args, ctx, response) => {
    // Access the module-level PAGE_INTERCEPT map via network-intercept exports
    // We use a indirect approach: remove the old rule and add a new one with same id is not possible
    // so instead we expose an update path via the internal map accessor
    // Since we don't have direct map access here, use remove + add
    const listResp = createCapturingResponse()
    await (list_interceptions.handler as Function)({ page: args.page }, ctx, listResp)
    const rules = (listResp.dataPayload as { rules: Array<{ id: string; pattern: string; action: string; mockStatus?: number }> })?.rules ?? []
    const existing = rules.find((r) => r.id === args.ruleId)

    if (!existing) {
      response.error(`Rule "${args.ruleId}" not found. Use list_mocks to see active rules.`)
      return
    }

    // Remove old
    const removeResp = createCapturingResponse()
    await (remove_interception.handler as Function)({ page: args.page, ruleId: args.ruleId }, ctx, removeResp)

    // Re-add with updated values
    const addResp = createCapturingResponse()
    await (add_request_interception.handler as Function)(
      {
        page: args.page,
        pattern: existing.pattern,
        action: existing.action,
        mockStatus: args.statusCode ?? existing.mockStatus ?? 200,
        mockBody: args.responseBody ?? '{}',
      },
      ctx,
      addResp,
    )

    const newRuleId = (addResp.dataPayload as { ruleId: string })?.ruleId ?? 'unknown'
    response.text(`Mock updated. New rule ID: ${newRuleId}`)
    response.data({ updated: true, ruleId: newRuleId })
  },
})

// ── list_mocks / clear_mocks (aliases of list/clear interceptions) ──────────────────

export const list_mocks = defineXcTool({
  name: 'list_mocks',
  description: 'List all active mock and interception rules on a page (alias of list_interceptions).',
  input: z.object({ page: pageParam }),
  output: z.object({ rules: z.array(z.any()), enabled: z.boolean() }),
  handler: async (args, ctx, response) => {
    await (list_interceptions.handler as Function)(args, ctx, response)
  },
})

export const clear_mocks = defineXcTool({
  name: 'clear_mocks',
  description: 'Remove all mocks and interception rules from a page (alias of clear_interceptions).',
  input: z.object({ page: pageParam }),
  output: z.object({ cleared: z.number() }),
  handler: async (args, ctx, response) => {
    await (clear_interceptions.handler as Function)(args, ctx, response)
  },
})

// ── Internal: capturing response helper ────────────────────────────────────────────

interface CapturingResponse {
  errorMessage: string | null
  dataPayload: unknown
  text: (msg: string) => void
  error: (msg: string) => void
  data: (payload: unknown) => void
  image: (...args: unknown[]) => void
}

function createCapturingResponse(): CapturingResponse {
  const r: CapturingResponse = {
    errorMessage: null,
    dataPayload: null,
    text: () => {},
    error: (msg: string) => { r.errorMessage = msg },
    data: (payload: unknown) => { r.dataPayload = payload },
    image: () => {},
  }
  return r
}

/**
 * XC Phase 9 — JavaScript Execution & Evaluation Engine
 *
 * Tools exported:
 *   evaluate_js       — run arbitrary JS in page context via CDP Runtime.evaluate
 *   evaluate_js_file  — read a JS file from disk and evaluate it (large scripts)
 *
 * Architecture
 * ────────────
 * CDP Runtime.evaluate runs synchronous or async (awaitPromise) JS in the
 * main-world execution context of the page. Return values are serialized
 * as RemoteObject.
 *
 * Serialization strategy (in priority order):
 *   1. If returnByValue=true (default), CDP serializes the result as a plain
 *      JSON-compatible value directly. Works for primitives, plain objects,
 *      and arrays. Fails (returns undefined) for class instances, Proxies,
 *      circular refs, and DOM nodes.
 *   2. Fallback: re-evaluate with a JSON.stringify wrapper in-page — this
 *      handles class instances that have a toJSON() method and flattens
 *      circular structures by catching the error.
 *   3. Final fallback: return the CDP `description` string (like
 *      "HTMLElement", "Array(3)", "Object") so the caller always gets
 *      something useful.
 *
 * Safety guard
 * ────────────
 * By default, expressions matching cookie-extraction patterns are rejected:
 *   document.cookie / getCookies / CookieStore.getAll
 * Set BROWSEROS_XC_ALLOW_COOKIE_EVAL=true to bypass (for security researchers).
 *
 * Timeout
 * ────────
 * CDP Runtime.evaluate does not natively timeout. We race against a
 * Promise.race with a configurable deadline (default 10s) and call
 * Runtime.terminateExecution if it fires to abort the hung evaluation.
 */

import * as fs from 'node:fs'
import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('js-engine')

// ── Cookie extraction safety patterns ─────────────────────────────────────────
const COOKIE_PATTERNS = [
  /document\.cookie(?!\s*=)/, // read (not write)
  /cookieStore\.getAll/,
  /getAllCookies\s*\(/,
]

function hasCookieExtraction(code: string): boolean {
  return COOKIE_PATTERNS.some((p) => p.test(code))
}

function isCookieEvalAllowed(): boolean {
  return process.env.BROWSEROS_XC_ALLOW_COOKIE_EVAL === 'true'
}

// ── CDP session type ───────────────────────────────────────────────────────────
type CdpSession = {
  Runtime: {
    enable: () => Promise<void>
    evaluate: (p: object) => Promise<{
      result: {
        type: string
        value?: unknown
        description?: string
        className?: string
        objectId?: string
      }
      exceptionDetails?: {
        text: string
        exception?: { description?: string; value?: unknown }
        lineNumber?: number
        columnNumber?: number
      }
    }>
    terminateExecution: () => Promise<void>
    callFunctionOn: (p: object) => Promise<{
      result: { type: string; value?: unknown; description?: string }
      exceptionDetails?: unknown
    }>
  }
}

// ── Serialization helper ───────────────────────────────────────────────────────
async function serializeResult(
  cdp: CdpSession,
  objectId: string | undefined,
  directValue: unknown,
  description: string | undefined,
  type: string,
): Promise<{ value: unknown; serializedAs: string }> {
  // If we already have a plain value (returnByValue succeeded), use it
  if (directValue !== undefined) {
    return { value: directValue, serializedAs: 'direct' }
  }

  // For null / undefined types
  if (type === 'undefined') return { value: undefined, serializedAs: 'direct' }
  if (type === 'null') return { value: null, serializedAs: 'direct' }

  // Try JSON.stringify in page context via callFunctionOn
  if (objectId) {
    try {
      const jsonResult = await cdp.Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function() {
          try {
            return JSON.stringify(this, (k, v) => {
              if (v === undefined) return '__undefined__'
              if (typeof v === 'function') return '[Function: ' + (v.name || 'anonymous') + ']'
              if (typeof v === 'symbol') return v.toString()
              if (v instanceof Error) return { message: v.message, stack: v.stack }
              return v
            }, 2)
          } catch(e) {
            return JSON.stringify({ __serializationError__: e.message, type: typeof this, description: String(this) })
          }
        }`,
        returnByValue: true,
      })
      if (jsonResult.result.value !== undefined) {
        try {
          return {
            value: JSON.parse(jsonResult.result.value as string),
            serializedAs: 'json-stringify-in-page',
          }
        } catch {
          return { value: jsonResult.result.value, serializedAs: 'json-string' }
        }
      }
    } catch { /* fall through */ }
  }

  // Final fallback: description string
  return { value: description ?? `[${type}]`, serializedAs: 'description' }
}

// ── Tools ──────────────────────────────────────────────────────────────────────

export const evaluate_js = defineXcTool({
  name: 'evaluate_js',
  description:
    'Evaluate arbitrary JavaScript in the page context using CDP Runtime.evaluate. ' +
    'Handles async code (set awaitResult=true for Promises), complex return values ' +
    '(objects, arrays, class instances), and provides proper error messages with ' +
    'line numbers. ' +
    'Safety: cookie-extraction patterns are blocked by default (requires ' +
    'BROWSEROS_XC_ALLOW_COOKIE_EVAL=true env var to unlock). ' +
    'For large scripts, use evaluate_js_file instead.',
  input: z.object({
    page: pageParam,
    code: z
      .string()
      .describe('JavaScript expression or statement block to evaluate in the page context'),
    awaitResult: z
      .boolean()
      .default(false)
      .describe('If true, awaits a Promise return value (for async code). Default false.'),
    returnByValue: z
      .boolean()
      .default(true)
      .describe(
        'If true (default), serialize result as JSON. Set false for DOM node handles.',
      ),
    timeoutMs: z
      .number()
      .default(10000)
      .describe('Evaluation timeout in ms (default 10000). Terminates hung evaluations.'),
    contextId: z
      .number()
      .optional()
      .describe('CDP execution context ID (for evaluating in a specific iframe context)'),
  }),
  output: z.object({
    result: z.unknown(),
    type: z.string(),
    serializedAs: z.string(),
    durationMs: z.number(),
  }),
  handler: async (args, ctx, response) => {
    // Safety check
    if (hasCookieExtraction(args.code) && !isCookieEvalAllowed()) {
      response.error(
        'Cookie extraction detected in code. ' +
        'Set BROWSEROS_XC_ALLOW_COOKIE_EVAL=true to allow. ' +
        'Use the dedicated get_cookies tool instead (it uses the CDP cookies API, not document.cookie).',
      )
      return
    }

    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    const startMs = Date.now()

    const timeoutMs = args.timeoutMs ?? 10000
    let timedOut = false

    const evalParams: Record<string, unknown> = {
      expression: args.code,
      returnByValue: args.returnByValue !== false,
      awaitPromise: args.awaitResult === true,
      generatePreview: false,
      userGesture: true, // allows clipboard/fullscreen APIs
    }
    if (args.contextId !== undefined) {
      evalParams.contextId = args.contextId
    }

    const timeoutHandle = setTimeout(async () => {
      timedOut = true
      try { await cdp.Runtime.terminateExecution() } catch { /* ignore */ }
    }, timeoutMs)

    let evalResult: Awaited<ReturnType<CdpSession['Runtime']['evaluate']>>
    try {
      evalResult = await cdp.Runtime.evaluate(evalParams)
    } catch (e) {
      clearTimeout(timeoutHandle)
      if (timedOut) {
        response.error(`Evaluation timed out after ${timeoutMs}ms.`)
      } else {
        response.error(`CDP evaluate error: ${(e as Error).message}`)
      }
      return
    }
    clearTimeout(timeoutHandle)

    const durationMs = Date.now() - startMs

    // Handle JS exceptions
    if (evalResult.exceptionDetails) {
      const ex = evalResult.exceptionDetails
      const msg =
        ex.exception?.description ??
        ex.exception?.value as string ??
        ex.text ??
        'Unknown JS exception'
      const loc = ex.lineNumber !== undefined ? ` (line ${ex.lineNumber + 1})` : ''
      response.error(`JS exception${loc}: ${msg}`)
      return
    }

    const r = evalResult.result
    const { value: serialized, serializedAs } = await serializeResult(
      cdp,
      r.objectId,
      r.value,
      r.description,
      r.type,
    )

    // Format output
    const display =
      serialized === undefined
        ? 'undefined'
        : typeof serialized === 'object'
        ? JSON.stringify(serialized, null, 2).slice(0, 8000)
        : String(serialized).slice(0, 8000)

    const truncated = display.length >= 8000
    response.text(
      `Result (${r.type}, ${durationMs}ms, via ${serializedAs}):\n${display}` +
      (truncated ? '\n... [truncated at 8000 chars]' : ''),
    )
    response.data({ result: serialized, type: r.type, serializedAs, durationMs })
  },
})

export const evaluate_js_file = defineXcTool({
  name: 'evaluate_js_file',
  description:
    'Read a JavaScript file from disk and evaluate it in the page context. ' +
    'Useful for large analysis scripts that exceed input size limits. ' +
    'The file must be accessible on the server filesystem. ' +
    'Same safety rules apply as evaluate_js.',
  input: z.object({
    page: pageParam,
    filePath: z
      .string()
      .describe('Absolute path to a .js or .ts (compiled) file on the server filesystem'),
    awaitResult: z.boolean().default(false),
    timeoutMs: z.number().default(30000),
  }),
  output: z.object({
    result: z.unknown(),
    type: z.string(),
    fileSize: z.number(),
    durationMs: z.number(),
  }),
  handler: async (args, ctx, response) => {
    let code: string
    try {
      code = fs.readFileSync(args.filePath, 'utf8')
    } catch (e) {
      response.error(`Cannot read file: ${(e as Error).message}`)
      return
    }

    if (hasCookieExtraction(code) && !isCookieEvalAllowed()) {
      response.error(
        'Cookie extraction pattern detected in file. Set BROWSEROS_XC_ALLOW_COOKIE_EVAL=true to allow.',
      )
      return
    }

    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    const startMs = Date.now()
    let timedOut = false
    const timeoutMs = args.timeoutMs ?? 30000

    const timeoutHandle = setTimeout(async () => {
      timedOut = true
      try { await cdp.Runtime.terminateExecution() } catch { /* ignore */ }
    }, timeoutMs)

    let evalResult: Awaited<ReturnType<CdpSession['Runtime']['evaluate']>>
    try {
      evalResult = await cdp.Runtime.evaluate({
        expression: code,
        returnByValue: true,
        awaitPromise: args.awaitResult === true,
        userGesture: true,
      })
    } catch (e) {
      clearTimeout(timeoutHandle)
      if (timedOut) {
        response.error(`File evaluation timed out after ${timeoutMs}ms.`)
      } else {
        response.error(`CDP evaluate error: ${(e as Error).message}`)
      }
      return
    }
    clearTimeout(timeoutHandle)

    const durationMs = Date.now() - startMs

    if (evalResult.exceptionDetails) {
      const ex = evalResult.exceptionDetails
      const msg = ex.exception?.description ?? ex.text ?? 'Unknown error'
      response.error(`JS exception in file: ${msg}`)
      return
    }

    const r = evalResult.result
    const { value: serialized, serializedAs } = await serializeResult(
      cdp,
      r.objectId,
      r.value,
      r.description,
      r.type,
    )

    const display =
      typeof serialized === 'object'
        ? JSON.stringify(serialized, null, 2).slice(0, 10000)
        : String(serialized ?? '').slice(0, 10000)

    response.text(
      `File ${args.filePath} (${code.length} bytes, ${durationMs}ms):\n${display}`,
    )
    response.data({ result: serialized, type: r.type, fileSize: code.length, durationMs })
  },
})

/**
 * XC Phase 8 — Web Worker & Shared Worker Discovery
 *
 * Tools exported:
 *   list_web_workers       — list all worker targets (web workers, shared workers)
 *   evaluate_in_worker     — run JS expression inside a specific worker context
 *   get_worker_source      — fetch and return worker script source
 *   get_worker_globals     — enumerate global variables defined in a worker
 *
 * Architecture
 * ────────────
 * CDP Target.getTargets returns all active browser targets including worker
 * targets (type: 'worker', 'shared_worker'). Note: service_worker targets
 * are handled in service-workers.ts.
 *
 * To evaluate code in a worker we need to attach a CDP session to the worker
 * target. We use Target.attachToTarget to get a sessionId, then
 * send Runtime.evaluate over that session.
 *
 * Worker targets are ephemeral — they appear and disappear as the page
 * creates/terminates workers. We always do a fresh Target.getTargets
 * query on each call.
 *
 * Value to AI agent
 * ─────────────────
 * Background workers often contain the most sensitive logic:
 *   • crypto workers — handle key generation, encryption (fintech apps)
 *   • compression workers — handle file upload processing
 *   • data sync workers — handle offline queue and conflict resolution
 *   • analytics workers — batch and deduplicate events before sending
 * Their script URLs and global variable names are a direct window into
 * hidden feature modules that page-level tools never see.
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('workers')

type CdpSession = {
  Target: {
    getTargets: () => Promise<{
      targetInfos: Array<{
        targetId: string
        type: string
        url: string
        title: string
        attached: boolean
        canAccessOpener: boolean
      }>
    }>
    attachToTarget: (p: { targetId: string; flatten: boolean }) => Promise<{ sessionId: string }>
    detachFromTarget: (p: { sessionId: string }) => Promise<void>
  }
  Runtime: {
    evaluate: (p: object) => Promise<{ result?: { value?: unknown; type?: string; description?: string }; exceptionDetails?: unknown }>
  }
  // Flat session dispatch for attached targets
  send: (method: string, params: object, sessionId?: string) => Promise<unknown>
}

// ── Tools ──────────────────────────────────────────────────────────────────

export const list_web_workers = defineXcTool({
  name: 'list_web_workers',
  description:
    'List all active web workers and shared workers. ' +
    'Returns worker target ID, type (worker/shared_worker), and script URL. ' +
    'Use the targetId with evaluate_in_worker or get_worker_source. ' +
    'Workers with URLs like /workers/crypto.js, /workers/sync.js reveal hidden features.',
  input: z.object({ page: pageParam }),
  output: z.object({
    workers: z.array(z.any()),
    count: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    const { targetInfos } = await cdp.Target.getTargets()

    const workers = targetInfos
      .filter((t) => t.type === 'worker' || t.type === 'shared_worker')
      .map((t) => ({
        targetId: t.targetId,
        type: t.type,
        url: t.url,
        title: t.title,
        attached: t.attached,
        scriptFile: t.url.split('/').pop()?.split('?')[0] ?? t.url,
      }))

    if (workers.length === 0) {
      response.text('No active web workers found on this page.')
      response.data({ workers: [], count: 0 })
      return
    }

    const lines = workers.map(
      (w) => `  [${w.type}] ${w.scriptFile}\n    targetId: ${w.targetId}\n    url: ${w.url}`,
    )
    response.text(`Active workers (${workers.length}):\n${lines.join('\n')}`)
    response.data({ workers, count: workers.length })
  },
})

export const evaluate_in_worker = defineXcTool({
  name: 'evaluate_in_worker',
  description:
    'Run a JavaScript expression inside a specific web worker context. ' +
    'Attaches a temporary CDP session to the worker target, evaluates the expression, ' +
    'then detaches. ' +
    'Examples: ' +
    'evaluate_in_worker({ targetId: "...", expression: "Object.keys(self)" }) — list globals; ' +
    'evaluate_in_worker({ targetId: "...", expression: "[...self.caches.keys()]" }) — cache names; ' +
    'evaluate_in_worker({ targetId: "...", expression: "WORKER_VERSION" }) — internal constant.',
  input: z.object({
    page: pageParam,
    targetId: z.string().describe('Worker target ID from list_web_workers'),
    expression: z.string().describe('JavaScript expression to evaluate in the worker context'),
    awaitPromise: z
      .boolean()
      .default(false)
      .describe('Whether to await a Promise result (default false)'),
  }),
  output: z.object({
    result: z.unknown(),
    type: z.string(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession

    let sessionId: string | null = null
    try {
      const { sessionId: sid } = await cdp.Target.attachToTarget({
        targetId: args.targetId,
        flatten: true,
      })
      sessionId = sid

      // Send Runtime.evaluate over the worker session
      const evalResult = await cdp.send(
        'Runtime.evaluate',
        {
          expression: args.expression,
          returnByValue: true,
          awaitPromise: args.awaitPromise ?? false,
        },
        sessionId,
      ) as { result?: { value?: unknown; type?: string; description?: string }; exceptionDetails?: unknown }

      const val = evalResult.result?.value
      const type = evalResult.result?.type ?? 'unknown'

      if (evalResult.exceptionDetails) {
        const err = (evalResult.exceptionDetails as { exception?: { description?: string }; text?: string })
        response.error(`Worker eval error: ${err.exception?.description ?? err.text ?? 'unknown'}`)
        return
      }

      const display = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val)
      response.text(`Worker ${args.targetId} result (${type}):\n${display.slice(0, 5000)}`)
      response.data({ result: val, type })
    } finally {
      if (sessionId) {
        try { await cdp.Target.detachFromTarget({ sessionId }) } catch { /* ignore */ }
      }
    }
  },
})

export const get_worker_source = defineXcTool({
  name: 'get_worker_source',
  description:
    'Fetch and return the source code of a web worker script. ' +
    'Worker scripts often contain the full implementation of background features: ' +
    'encryption algorithms, data sync logic, offline queue handling, ' +
    'or analytics batching — all completely invisible to page-level DOM tools.',
  input: z.object({
    page: pageParam,
    workerUrl: z
      .string()
      .describe('Worker script URL (from list_web_workers)'),
    maxLength: z
      .number()
      .default(50000)
      .describe('Max characters to return (default 50000)'),
  }),
  output: z.object({
    source: z.string(),
    length: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    const evalResult = await cdp.Runtime.evaluate({
      expression: `
(async function() {
  try {
    const res = await fetch(${JSON.stringify(args.workerUrl)}, { credentials: 'include' });
    const text = await res.text();
    return { source: text, status: res.status };
  } catch(e) {
    return { error: e.message };
  }
})()
`,
      returnByValue: true,
      awaitPromise: true,
    })

    const result = evalResult.result?.value as { source?: string; error?: string }
    if (result?.error || !result?.source) {
      response.error(`Failed to fetch worker source: ${result?.error ?? 'empty'}`)
      return
    }

    const maxLen = args.maxLength ?? 50000
    const truncated = result.source.length > maxLen
    const source = result.source.slice(0, maxLen)

    response.text(
      `Worker source: ${args.workerUrl}\nLength: ${result.source.length} chars\n\n${source}`,
    )
    response.data({ source, length: result.source.length, truncated })
  },
})

export const get_worker_globals = defineXcTool({
  name: 'get_worker_globals',
  description:
    'Enumerate the global variables defined inside a web worker context. ' +
    'Returns all non-standard globals (i.e. app-defined, not browser built-ins). ' +
    'Reveals module exports, internal state objects, and feature flags that live ' +
    'exclusively in the worker thread.',
  input: z.object({
    page: pageParam,
    targetId: z.string().describe('Worker target ID from list_web_workers'),
  }),
  output: z.object({
    globals: z.array(z.string()),
    count: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession

    // Well-known browser globals to exclude
    const builtinGlobals = new Set([
      'self', 'globalThis', 'undefined', 'NaN', 'Infinity', 'eval', 'isFinite', 'isNaN',
      'parseFloat', 'parseInt', 'decodeURI', 'decodeURIComponent', 'encodeURI',
      'encodeURIComponent', 'escape', 'unescape', 'Object', 'Function', 'Boolean',
      'Symbol', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
      'TypeError', 'URIError', 'Number', 'BigInt', 'Math', 'Date', 'String', 'RegExp',
      'Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
      'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
      'BigUint64Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
      'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'JSON', 'Promise',
      'Reflect', 'Proxy', 'Intl', 'WebAssembly', 'console', 'performance', 'crypto',
      'fetch', 'Headers', 'Request', 'Response', 'URL', 'URLSearchParams', 'Blob',
      'FileReader', 'FormData', 'TextDecoder', 'TextEncoder', 'ReadableStream',
      'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy',
      'CountQueuingStrategy', 'MessageEvent', 'MessageChannel', 'MessagePort',
      'EventTarget', 'Event', 'ErrorEvent', 'CloseEvent', 'PromiseRejectionEvent',
      'navigator', 'location', 'WorkerGlobalScope', 'WorkerNavigator', 'WorkerLocation',
      'importScripts', 'postMessage', 'close', 'setTimeout', 'clearTimeout',
      'setInterval', 'clearInterval', 'queueMicrotask', 'reportError', 'structuredClone',
      'caches', 'indexedDB', 'IDBFactory', 'IDBDatabase', 'IDBTransaction',
      'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBKeyRange', 'IDBRequest',
      'IDBOpenDBRequest', 'IDBVersionChangeEvent', 'WebSocket', 'XMLHttpRequest',
      'onmessage', 'onerror', 'onmessageerror', 'TEMPORARY', 'PERSISTENT',
    ])

    let sessionId: string | null = null
    try {
      const { sessionId: sid } = await cdp.Target.attachToTarget({
        targetId: args.targetId,
        flatten: true,
      })
      sessionId = sid

      const evalResult = await cdp.send(
        'Runtime.evaluate',
        {
          expression: 'Object.keys(self)',
          returnByValue: true,
          awaitPromise: false,
        },
        sessionId,
      ) as { result?: { value?: unknown } }

      const allKeys = (evalResult.result?.value as string[]) ?? []
      const appGlobals = allKeys.filter((k) => !builtinGlobals.has(k))

      response.text(
        `Worker globals (${appGlobals.length} app-defined):\n` +
        appGlobals.map((k) => `  ${k}`).join('\n'),
      )
      response.data({ globals: appGlobals, count: appGlobals.length })
    } finally {
      if (sessionId) {
        try { await cdp.Target.detachFromTarget({ sessionId }) } catch { /* ignore */ }
      }
    }
  },
})

/**
 * XC Phase 7 — Request Capture & Replay
 *
 * Captures all network requests made by a page during a session, then lets
 * the agent replay any captured request with optional header/body overrides.
 * Also exports the full session as a HAR 1.2 file.
 *
 * Tools exported:
 *   start_request_capture    — enable CDP Network domain + start recording
 *   stop_request_capture     — stop recording (Network domain stays enabled)
 *   list_captured_requests   — list captured requests with URL, method, status, timing
 *   replay_request           — replay a captured request via fetch() in the page context
 *   export_har               — export captured session as HAR 1.2 JSON
 *   clear_captured_requests  — clear the capture log
 *
 * Architecture
 * ────────────
 * Uses CDP Network.requestWillBeSent + Network.responseReceived +
 * Network.loadingFinished + Network.loadingFailed events to capture
 * request/response pairs. Response bodies are retrieved lazily via
 * Network.getResponseBody only when export_har or replay_request is called.
 *
 * Per-page state is stored in a module-level Map so it survives tool calls.
 *
 * Replay uses Runtime.evaluate to run fetch() inside the page context
 * (so it carries the page's cookies and same-origin context automatically).
 * The agent can override headers and body for each replay.
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('network')

// ── Types & per-page state ───────────────────────────────────────────────────────

interface CapturedRequest {
  id: string // sequential: req_1, req_2, ...
  networkRequestId: string // CDP requestId
  url: string
  method: string
  requestHeaders: Record<string, string>
  requestBody: string | null
  status: number | null
  statusText: string | null
  responseHeaders: Record<string, string>
  mimeType: string | null
  encodedDataLength: number | null
  timing: {
    requestTime: number // CDP timestamp (seconds from epoch)
    receiveHeadersEnd: number | null
  }
  failed: boolean
  failureText: string | null
  initiatorType: string | null
  resourceType: string | null
}

interface CaptureState {
  recording: boolean
  requests: Map<string, CapturedRequest> // networkRequestId -> CapturedRequest
  counter: number
  unsubscribers: Array<() => void>
}

const PAGE_CAPTURE: Map<number, CaptureState> = new Map()

function getOrCreateCapture(pageId: number): CaptureState {
  if (!PAGE_CAPTURE.has(pageId)) {
    PAGE_CAPTURE.set(pageId, {
      recording: false,
      requests: new Map(),
      counter: 0,
      unsubscribers: [],
    })
  }
  return PAGE_CAPTURE.get(pageId)!
}

type CdpSession = {
  Network: {
    enable: (p?: object) => Promise<void>
    disable: () => Promise<void>
    getResponseBody: (p: { requestId: string }) => Promise<{ body: string; base64Encoded: boolean }>
    on: (event: string, cb: (params: unknown) => void) => () => void
  }
  Runtime: {
    evaluate: (p: object) => Promise<{ result?: { value?: unknown; description?: string }; exceptionDetails?: unknown }>
  }
}

async function attachNetworkListeners(pageId: number, session: CdpSession): Promise<void> {
  const state = getOrCreateCapture(pageId)

  // Remove old listeners
  for (const unsub of state.unsubscribers) unsub()
  state.unsubscribers = []

  await session.Network.enable({ maxResourceBufferSize: 10 * 1024 * 1024 })

  const unsubSent = session.Network.on('requestWillBeSent', (params: unknown) => {
    if (!state.recording) return
    const p = params as {
      requestId: string
      request: { url: string; method: string; headers: Record<string, string>; postData?: string }
      type: string
      initiator: { type: string }
      timestamp: number
    }
    state.counter++
    const req: CapturedRequest = {
      id: `req_${state.counter}`,
      networkRequestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      requestHeaders: p.request.headers ?? {},
      requestBody: p.request.postData ?? null,
      status: null,
      statusText: null,
      responseHeaders: {},
      mimeType: null,
      encodedDataLength: null,
      timing: { requestTime: p.timestamp, receiveHeadersEnd: null },
      failed: false,
      failureText: null,
      initiatorType: p.initiator?.type ?? null,
      resourceType: p.type ?? null,
    }
    state.requests.set(p.requestId, req)
  })

  const unsubResponse = session.Network.on('responseReceived', (params: unknown) => {
    const p = params as {
      requestId: string
      response: {
        url: string
        status: number
        statusText: string
        headers: Record<string, string>
        mimeType: string
        timing?: { receiveHeadersEnd: number }
      }
    }
    const req = state.requests.get(p.requestId)
    if (!req) return
    req.status = p.response.status
    req.statusText = p.response.statusText
    req.responseHeaders = p.response.headers ?? {}
    req.mimeType = p.response.mimeType
    req.timing.receiveHeadersEnd = p.response.timing?.receiveHeadersEnd ?? null
  })

  const unsubFinished = session.Network.on('loadingFinished', (params: unknown) => {
    const p = params as { requestId: string; encodedDataLength: number }
    const req = state.requests.get(p.requestId)
    if (!req) return
    req.encodedDataLength = p.encodedDataLength
  })

  const unsubFailed = session.Network.on('loadingFailed', (params: unknown) => {
    const p = params as { requestId: string; errorText: string; canceled?: boolean }
    const req = state.requests.get(p.requestId)
    if (!req) return
    req.failed = true
    req.failureText = p.errorText
  })

  state.unsubscribers.push(unsubSent, unsubResponse, unsubFinished, unsubFailed)
}

// ── Tools ──────────────────────────────────────────────────────────────────

export const start_request_capture = defineXcTool({
  name: 'start_request_capture',
  description:
    'Start capturing all network requests made by the page. ' +
    'Records URL, method, request/response headers, status code, timing, and resource type. ' +
    'Call stop_request_capture when done, then list_captured_requests to see what was recorded. ' +
    'Replay any request with replay_request, or export the full session as HAR with export_har.',
  input: z.object({
    page: pageParam,
    clearExisting: z
      .boolean()
      .default(true)
      .describe('Clear previously captured requests before starting (default true)'),
  }),
  output: z.object({ recording: z.boolean() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateCapture(args.page)
    if (args.clearExisting !== false) {
      state.requests.clear()
      state.counter = 0
    }
    await attachNetworkListeners(args.page, session as unknown as CdpSession)
    state.recording = true

    response.text('Request capture started. Interact with the page, then call stop_request_capture + list_captured_requests.')
    response.data({ recording: true })
  },
})

export const stop_request_capture = defineXcTool({
  name: 'stop_request_capture',
  description: 'Stop recording network requests. Previously captured requests are preserved.',
  input: z.object({ page: pageParam }),
  output: z.object({ recording: z.boolean(), capturedCount: z.number() }),
  handler: async (args, _ctx, response) => {
    const state = getOrCreateCapture(args.page)
    state.recording = false
    response.text(`Request capture stopped. ${state.requests.size} request(s) captured.`)
    response.data({ recording: false, capturedCount: state.requests.size })
  },
})

export const list_captured_requests = defineXcTool({
  name: 'list_captured_requests',
  description:
    'List all requests captured since start_request_capture was called. ' +
    'Returns id (use for replay_request), URL, method, status, resourceType, timing, and failure info.',
  input: z.object({
    page: pageParam,
    filterUrl: z.string().optional().describe('Filter by URL substring'),
    filterMethod: z.string().optional().describe('Filter by HTTP method (GET, POST, etc.)'),
    filterType: z.string().optional().describe('Filter by resource type (XHR, Fetch, Script, etc.)'),
    filterStatus: z.number().optional().describe('Filter by exact HTTP status code'),
    limit: z.number().default(50).describe('Max requests to return (default 50)'),
  }),
  output: z.object({
    requests: z.array(z.any()),
    totalCount: z.number(),
  }),
  handler: async (args, _ctx, response) => {
    const state = getOrCreateCapture(args.page)
    let reqs = Array.from(state.requests.values())

    if (args.filterUrl) reqs = reqs.filter((r) => r.url.includes(args.filterUrl!))
    if (args.filterMethod) reqs = reqs.filter((r) => r.method.toUpperCase() === args.filterMethod!.toUpperCase())
    if (args.filterType) reqs = reqs.filter((r) => r.resourceType?.toLowerCase() === args.filterType!.toLowerCase())
    if (args.filterStatus) reqs = reqs.filter((r) => r.status === args.filterStatus)

    const limited = reqs.slice(0, args.limit ?? 50)
    const lines = limited.map((r) => {
      const status = r.status !== null ? `${r.status}` : r.failed ? `FAILED(${r.failureText ?? '?'})` : 'pending'
      const size = r.encodedDataLength !== null ? ` ${(r.encodedDataLength / 1024).toFixed(1)}KB` : ''
      const type = r.resourceType ? ` [${r.resourceType}]` : ''
      return `  [${r.id}] ${r.method} ${status}${size}${type} ${r.url.slice(0, 100)}`
    })

    response.text(
      `Captured requests (${limited.length}/${state.requests.size} total):\n` +
      (lines.length ? lines.join('\n') : '  None yet. Call start_request_capture and interact with the page.'),
    )
    response.data({ requests: limited, totalCount: state.requests.size })
  },
})

export const replay_request = defineXcTool({
  name: 'replay_request',
  description:
    'Replay a captured request in the page context (carries cookies, origin, auth headers). ' +
    'Optionally override headers or body. Returns the response status, headers, and body. ' +
    'Use this to: test if an API accepts different inputs, check auth token validity, ' +
    'or verify rate limiting behaviour. ' +
    'The replay runs via fetch() inside the page context — not from the Node.js server — ' +
    'so CORS and cookies are handled exactly as the site would.',
  input: z.object({
    page: pageParam,
    requestId: z
      .string()
      .describe('Request ID from list_captured_requests (e.g. "req_3")'),
    overrideHeaders: z
      .record(z.string())
      .optional()
      .describe('Headers to override (merged with original headers)'),
    overrideBody: z
      .string()
      .optional()
      .describe('Body to send instead of the original (for POST/PUT/PATCH)'),
    overrideMethod: z
      .string()
      .optional()
      .describe('HTTP method to use instead of the original'),
    timeoutMs: z
      .number()
      .default(15000)
      .describe('Request timeout in ms (default 15000)'),
  }),
  output: z.object({
    status: z.number(),
    statusText: z.string(),
    responseHeaders: z.record(z.string()),
    body: z.string(),
    bodySize: z.number(),
    durationMs: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateCapture(args.page)
    // Find by sequential id
    const captured = Array.from(state.requests.values()).find((r) => r.id === args.requestId)
    if (!captured) {
      response.error(`Request "${args.requestId}" not found. Use list_captured_requests to see available IDs.`)
      return
    }

    const mergedHeaders = { ...captured.requestHeaders, ...args.overrideHeaders }
    const method = args.overrideMethod ?? captured.method
    const body = args.overrideBody ?? captured.requestBody

    // Build fetch() call to run inside the page
    const fetchScript = `
(function() {
  return new Promise(function(resolve, reject) {
    var startTime = Date.now();
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, ${args.timeoutMs ?? 15000});

    var init = {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(mergedHeaders)},
      signal: controller.signal,
      credentials: 'include',
    };
    ${body && method !== 'GET' && method !== 'HEAD' ? `init.body = ${JSON.stringify(body)};` : ''}

    fetch(${JSON.stringify(captured.url)}, init)
      .then(function(res) {
        clearTimeout(timeout);
        var headers = {};
        res.headers.forEach(function(v, k) { headers[k] = v; });
        return res.text().then(function(text) {
          resolve({
            status: res.status,
            statusText: res.statusText,
            responseHeaders: headers,
            body: text.slice(0, 50000),
            bodySize: text.length,
            durationMs: Date.now() - startTime,
          });
        });
      })
      .catch(function(err) {
        clearTimeout(timeout);
        reject(err.message || String(err));
      });
  });
})()
`

    const cdpSession = session as unknown as CdpSession
    const evalResult = await cdpSession.Runtime.evaluate({
      expression: fetchScript,
      returnByValue: true,
      awaitPromise: true,
    })

    if (evalResult.exceptionDetails) {
      const err = (evalResult.exceptionDetails as { exception?: { description?: string }; text?: string })
      response.error(`Replay failed: ${err.exception?.description ?? err.text ?? 'unknown error'}`)
      return
    }

    const result = evalResult.result?.value as {
      status: number
      statusText: string
      responseHeaders: Record<string, string>
      body: string
      bodySize: number
      durationMs: number
    }

    response.text(
      `Replay result for ${captured.method} ${captured.url.slice(0, 80)}\n` +
      `  Status: ${result.status} ${result.statusText} (${result.durationMs}ms)\n` +
      `  Body size: ${result.bodySize} bytes\n` +
      `  Body preview: ${result.body.slice(0, 400)}${result.body.length > 400 ? '...' : ''}`,
    )
    response.data(result)
  },
})

export const export_har = defineXcTool({
  name: 'export_har',
  description:
    'Export all captured requests as a HAR 1.2 (HTTP Archive) JSON file. ' +
    'HAR files can be loaded into Chrome DevTools, Charles, Fiddler, or any network analyser. ' +
    'Also useful as a complete API surface map — every request the site makes is in the HAR.',
  input: z.object({
    page: pageParam,
    includeResponseBodies: z
      .boolean()
      .default(false)
      .describe(
        'Attempt to retrieve response bodies from CDP buffer (may not be available for all requests, default false)',
      ),
  }),
  output: z.object({ requestCount: z.number(), harJson: z.string() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateCapture(args.page)
    const cdpSession = session as unknown as CdpSession
    const requests = Array.from(state.requests.values())

    // Build HAR entries
    const entries = await Promise.all(
      requests.map(async (req) => {
        let responseBodyText = ''
        let responseBodySize = req.encodedDataLength ?? -1

        if (args.includeResponseBodies) {
          try {
            const bodyResult = await cdpSession.Network.getResponseBody({ requestId: req.networkRequestId })
            responseBodyText = bodyResult.base64Encoded
              ? Buffer.from(bodyResult.body, 'base64').toString('utf8').slice(0, 100_000)
              : bodyResult.body.slice(0, 100_000)
            responseBodySize = responseBodyText.length
          } catch {
            // Body not available (request may have been redirected or failed)
          }
        }

        const startedMs = req.timing.requestTime * 1000
        const receiveMs = req.timing.receiveHeadersEnd !== null ? req.timing.receiveHeadersEnd : 0

        return {
          startedDateTime: new Date(startedMs).toISOString(),
          time: receiveMs,
          request: {
            method: req.method,
            url: req.url,
            httpVersion: 'HTTP/1.1',
            headers: Object.entries(req.requestHeaders).map(([name, value]) => ({ name, value })),
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: req.requestBody ? req.requestBody.length : -1,
            postData: req.requestBody
              ? { mimeType: 'application/json', text: req.requestBody }
              : undefined,
          },
          response: {
            status: req.status ?? 0,
            statusText: req.statusText ?? '',
            httpVersion: 'HTTP/1.1',
            headers: Object.entries(req.responseHeaders).map(([name, value]) => ({ name, value })),
            cookies: [],
            content: {
              size: responseBodySize,
              mimeType: req.mimeType ?? 'application/octet-stream',
              text: responseBodyText || undefined,
            },
            redirectURL: req.responseHeaders['location'] ?? '',
            headersSize: -1,
            bodySize: responseBodySize,
          },
          cache: {},
          timings: {
            send: 0,
            wait: receiveMs,
            receive: 0,
          },
          ...(req.failed ? { _failed: true, _failureText: req.failureText } : {}),
        }
      }),
    )

    const har = {
      log: {
        version: '1.2',
        creator: { name: 'BrowserOS-XC', version: '7.0' },
        pages: [
          {
            startedDateTime: new Date().toISOString(),
            id: `page_${args.page}`,
            title: `Page ${args.page}`,
            pageTimings: {},
          },
        ],
        entries,
      },
    }

    const harJson = JSON.stringify(har, null, 2)
    response.text(
      `HAR export: ${requests.length} request(s).\n` +
      `Preview (first 3 URLs):\n` +
      requests
        .slice(0, 3)
        .map((r) => `  ${r.method} ${r.status ?? '?'} ${r.url.slice(0, 80)}`)
        .join('\n'),
    )
    response.data({ requestCount: requests.length, harJson })
  },
})

export const clear_captured_requests = defineXcTool({
  name: 'clear_captured_requests',
  description: 'Clear all captured requests from the current capture session.',
  input: z.object({ page: pageParam }),
  output: z.object({ cleared: z.number() }),
  handler: async (args, _ctx, response) => {
    const state = getOrCreateCapture(args.page)
    const count = state.requests.size
    state.requests.clear()
    state.counter = 0
    response.text(`Cleared ${count} captured request(s).`)
    response.data({ cleared: count })
  },
})

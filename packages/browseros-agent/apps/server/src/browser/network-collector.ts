/**
 * NetworkCollector — Phase 1 of BrowserOS-XC
 *
 * Mirrors the ConsoleCollector pattern exactly:
 *  - Constructor attaches CDP Network.* event listeners via cdp.onSessionEvent
 *  - attach(pageId, sessionId) / detach(pageId) wired in the same way as ConsoleCollector
 *  - Browser class calls attach/detach when a page session opens/closes
 *
 * No modifications to browser.ts are required beyond two small call-sites
 * (attach + detach), added as additive lines alongside the ConsoleCollector calls.
 */

import type { CdpBackend } from './backends/types'

// ─── Types ───────────────────────────────────────────────────────────────────

export type NetworkResourceType =
  | 'document'
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'script'
  | 'texttrack'
  | 'xhr'
  | 'fetch'
  | 'eventsource'
  | 'websocket'
  | 'manifest'
  | 'signedexchange'
  | 'ping'
  | 'cspviolationreport'
  | 'preflight'
  | 'other'

export interface NetworkRequest {
  requestId: string
  pageId: number
  url: string
  method: string
  resourceType: NetworkResourceType
  requestHeaders: Record<string, string>
  requestBody?: string
  initiator?: string
  timestamp: number
  // Populated on response
  status?: number
  statusText?: string
  responseHeaders?: Record<string, string>
  mimeType?: string
  responseSize?: number
  responseTimestamp?: number
  // Populated on finish
  duration?: number // ms
  encodedDataLength?: number
  failed?: boolean
  failureReason?: string
}

export interface GetNetworkRequestsOptions {
  resourceType?: NetworkResourceType
  method?: string
  status?: string // e.g. "200", "2xx", "4xx", "404"
  search?: string // substring match on URL
  limit?: number
  includeHeaders?: boolean
}

export interface GetNetworkRequestsResult {
  requests: NetworkRequest[]
  totalCount: number
  returnedCount: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_BUFFER = 2000 // requests per page
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

// ─── Status filter helper ────────────────────────────────────────────────────

function matchesStatus(status: number | undefined, filter: string): boolean {
  if (status === undefined) return false
  if (/^\d+$/.test(filter)) return status === Number(filter)
  if (/^[1-5]xx$/i.test(filter)) {
    const century = Number(filter[0]) * 100
    return status >= century && status < century + 100
  }
  return false
}

// ─── Collector class ─────────────────────────────────────────────────────────

export class NetworkCollector {
  /** per-page request buffers, keyed by pageId */
  private readonly buffers = new Map<number, Map<string, NetworkRequest>>()
  private readonly sessionToPage = new Map<string, number>()
  private readonly pageToSession = new Map<number, string>()

  /** HAR recording state */
  private harRecording = false
  private harStartTime = 0
  private harPageId?: number
  private harBuffer: NetworkRequest[] = []

  constructor(cdp: CdpBackend) {
    // ── Request sent ──────────────────────────────────────────────────────────
    cdp.onSessionEvent('Network.requestWillBeSent', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return

      const p = params as {
        requestId: string
        request: {
          url: string
          method: string
          headers: Record<string, string>
          postData?: string
        }
        type: string
        initiator?: { type: string }
        timestamp: number
      }

      const entry: NetworkRequest = {
        requestId: p.requestId,
        pageId,
        url: p.request.url,
        method: p.request.method.toUpperCase(),
        resourceType: (p.type?.toLowerCase() ?? 'other') as NetworkResourceType,
        requestHeaders: p.request.headers ?? {},
        requestBody: p.request.postData,
        initiator: p.initiator?.type,
        timestamp: p.timestamp * 1000, // CDP sends seconds, we store ms
      }

      this.addEntry(pageId, entry)

      if (this.harRecording && pageId === this.harPageId) {
        this.harBuffer.push(entry)
      }
    })

    // ── Response received ─────────────────────────────────────────────────────
    cdp.onSessionEvent('Network.responseReceived', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return

      const p = params as {
        requestId: string
        response: {
          status: number
          statusText: string
          headers: Record<string, string>
          mimeType: string
          encodedDataLength?: number
        }
        timestamp: number
      }

      const entry = this.getEntry(pageId, p.requestId)
      if (!entry) return

      entry.status = p.response.status
      entry.statusText = p.response.statusText
      entry.responseHeaders = p.response.headers
      entry.mimeType = p.response.mimeType
      entry.responseTimestamp = p.timestamp * 1000
    })

    // ── Loading finished ──────────────────────────────────────────────────────
    cdp.onSessionEvent('Network.loadingFinished', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return

      const p = params as {
        requestId: string
        timestamp: number
        encodedDataLength: number
      }

      const entry = this.getEntry(pageId, p.requestId)
      if (!entry) return

      entry.encodedDataLength = p.encodedDataLength
      if (entry.responseTimestamp) {
        entry.duration = p.timestamp * 1000 - entry.timestamp
      }
    })

    // ── Loading failed ────────────────────────────────────────────────────────
    cdp.onSessionEvent('Network.loadingFailed', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return

      const p = params as {
        requestId: string
        errorText: string
        canceled?: boolean
      }

      const entry = this.getEntry(pageId, p.requestId)
      if (!entry) return

      entry.failed = true
      entry.failureReason = p.canceled ? 'canceled' : p.errorText
    })

    // ── Clear on main-frame navigation (mirrors ConsoleCollector) ─────────────
    cdp.onSessionEvent('Page.frameNavigated', (params, sessionId) => {
      const pageId = this.sessionToPage.get(sessionId)
      if (pageId === undefined) return
      const frame = (params as { frame: { parentId?: string } }).frame
      if (!frame.parentId) {
        // Main frame navigation — clear buffer so stale requests don't pollute
        this.buffers.set(pageId, new Map())
        if (this.harRecording && pageId === this.harPageId) {
          this.harBuffer = []
        }
      }
    })
  }

  // ── Lifecycle (called by browser.ts alongside ConsoleCollector) ──────────────

  attach(pageId: number, sessionId: string): void {
    if (!this.buffers.has(pageId)) {
      this.buffers.set(pageId, new Map())
    }
    const oldSession = this.pageToSession.get(pageId)
    if (oldSession && oldSession !== sessionId) {
      this.sessionToPage.delete(oldSession)
    }
    this.sessionToPage.set(sessionId, pageId)
    this.pageToSession.set(pageId, sessionId)
  }

  detach(pageId: number): void {
    const sessionId = this.pageToSession.get(pageId)
    if (sessionId) this.sessionToPage.delete(sessionId)
    this.pageToSession.delete(pageId)
    this.buffers.delete(pageId)
  }

  // ── Query API ────────────────────────────────────────────────────────────────

  getRequests(
    pageId: number,
    opts: GetNetworkRequestsOptions = {},
  ): GetNetworkRequestsResult {
    const buffer = this.buffers.get(pageId)
    if (!buffer) {
      return { requests: [], totalCount: 0, returnedCount: 0 }
    }

    let entries = [...buffer.values()]

    // Filter by resource type
    if (opts.resourceType) {
      entries = entries.filter((e) => e.resourceType === opts.resourceType)
    }

    // Filter by HTTP method
    if (opts.method) {
      const m = opts.method.toUpperCase()
      entries = entries.filter((e) => e.method === m)
    }

    // Filter by status
    if (opts.status) {
      entries = entries.filter((e) => matchesStatus(e.status, opts.status!))
    }

    // Filter by URL substring
    if (opts.search) {
      const term = opts.search.toLowerCase()
      entries = entries.filter((e) => e.url.toLowerCase().includes(term))
    }

    // Strip headers from output unless requested (reduces token usage)
    if (!opts.includeHeaders) {
      entries = entries.map((e) => ({
        ...e,
        requestHeaders: {},
        responseHeaders: {},
      }))
    }

    const totalCount = entries.length
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const requests = entries.slice(-limit)

    return { requests, totalCount, returnedCount: requests.length }
  }

  // ── HAR recording API ────────────────────────────────────────────────────────

  startHar(pageId: number): void {
    this.harRecording = true
    this.harStartTime = Date.now()
    this.harPageId = pageId
    this.harBuffer = []
  }

  stopHar(): { requests: NetworkRequest[]; startTime: number; duration: number } {
    const result = {
      requests: [...this.harBuffer],
      startTime: this.harStartTime,
      duration: Date.now() - this.harStartTime,
    }
    this.harRecording = false
    this.harBuffer = []
    this.harPageId = undefined
    return result
  }

  isHarRecording(): boolean {
    return this.harRecording
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private addEntry(pageId: number, entry: NetworkRequest): void {
    const buffer = this.buffers.get(pageId)
    if (!buffer) return
    // FIFO eviction when buffer is full
    if (buffer.size >= MAX_BUFFER) {
      const firstKey = buffer.keys().next().value
      if (firstKey !== undefined) buffer.delete(firstKey)
    }
    buffer.set(entry.requestId, entry)
  }

  private getEntry(
    pageId: number,
    requestId: string,
  ): NetworkRequest | undefined {
    return this.buffers.get(pageId)?.get(requestId)
  }
}

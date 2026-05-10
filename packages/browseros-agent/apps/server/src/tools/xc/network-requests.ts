/**
 * XC Phase 1 — get_network_requests
 *
 * LLM-callable tool that queries the NetworkCollector buffer for a page.
 * The NetworkCollector is attached to ctx.browser via the same mechanism
 * as ConsoleCollector — see browser/network-collector.ts for details.
 */

import { z } from 'zod'
import type { NetworkCollector } from '../../browser/network-collector'
import { defineToolWithCategory } from '../framework'

declare module '../framework' {
  interface Browser {
    networkCollector: NetworkCollector
  }
}

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineObservationTool = defineToolWithCategory('observation')

export const get_network_requests = defineObservationTool({
  name: 'get_network_requests',
  description:
    'Get all HTTP/HTTPS network requests made by a page, including XHR, fetch, and document requests. ' +
    'Use this to discover what APIs a page calls, what CDN assets it loads, and what background ' +
    'interactions happen without user action. Essential for website intelligence mapping.',
  input: z.object({
    page: pageParam,
    resource_type: z
      .enum([
        'document',
        'stylesheet',
        'image',
        'media',
        'font',
        'script',
        'texttrack',
        'xhr',
        'fetch',
        'eventsource',
        'websocket',
        'manifest',
        'ping',
        'other',
      ])
      .optional()
      .describe(
        'Filter by resource type. Use "xhr" or "fetch" to see only API calls. Omit to see all.',
      ),
    method: z
      .string()
      .optional()
      .describe('Filter by HTTP method (GET, POST, PUT, DELETE, etc.)'),
    status: z
      .string()
      .optional()
      .describe(
        'Filter by HTTP status. Exact: "200", "404". Pattern: "2xx", "4xx", "5xx".',
      ),
    search: z
      .string()
      .optional()
      .describe('Filter requests whose URL contains this substring (case-insensitive).'),
    limit: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .describe('Max number of requests to return (default 100, max 500). Returns most recent.'),
    include_headers: z
      .boolean()
      .default(false)
      .describe(
        'Include full request/response headers. Disabled by default to reduce token usage.',
      ),
  }),
  output: z.object({
    requests: z.array(
      z.object({
        requestId: z.string(),
        url: z.string(),
        method: z.string(),
        resourceType: z.string(),
        status: z.number().optional(),
        statusText: z.string().optional(),
        mimeType: z.string().optional(),
        duration: z.number().optional(),
        encodedDataLength: z.number().optional(),
        initiator: z.string().optional(),
        failed: z.boolean().optional(),
        failureReason: z.string().optional(),
        timestamp: z.number(),
        requestHeaders: z.record(z.string()).optional(),
        responseHeaders: z.record(z.string()).optional(),
      }),
    ),
    totalCount: z.number(),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const collector: NetworkCollector | undefined = (
      ctx.browser as unknown as { networkCollector?: NetworkCollector }
    ).networkCollector

    if (!collector) {
      response.error(
        'NetworkCollector is not attached to the browser. ' +
          'Ensure browser/network-collector.ts is initialised in browser.ts (XC Phase 1 setup).',
      )
      return
    }

    const result = collector.getRequests(args.page, {
      resourceType: args.resource_type as never,
      method: args.method,
      status: args.status,
      search: args.search,
      limit: args.limit,
      includeHeaders: args.include_headers,
    })

    if (result.requests.length === 0) {
      response.text(
        result.totalCount === 0
          ? `No network requests captured for page ${args.page} yet. ` +
              'Navigate to a page first, or check that NetworkCollector is attached.'
          : `No requests match the filter (${result.totalCount} total captured).`,
      )
      response.data({ requests: [], totalCount: result.totalCount, returnedCount: 0 })
      return
    }

    const lines = result.requests.map((r) => {
      const status = r.status !== undefined ? ` → ${r.status}` : ' → pending'
      const duration = r.duration !== undefined ? ` (${Math.round(r.duration)}ms)` : ''
      const failed = r.failed ? ' [FAILED]' : ''
      return `[${r.method}] ${r.url}${status}${duration}${failed}`
    })

    const header =
      result.returnedCount < result.totalCount
        ? `Network requests for page ${args.page} (showing ${result.returnedCount} of ${result.totalCount}):`
        : `Network requests for page ${args.page} (${result.returnedCount} requests):`

    response.text(`${header}\n\n${lines.join('\n')}`)
    response.data(result)
  },
})

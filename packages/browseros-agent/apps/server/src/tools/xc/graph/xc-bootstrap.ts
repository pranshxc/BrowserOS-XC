/**
 * xc_bootstrap.ts — Initialize a mapper session.
 *
 * Replaces Phase 0 + Phase 1 of map_site_start.
 * Opens the seed URL, runs initial reconnaissance, builds the initial frontier.
 * Returns everything to the LLM — raw signals, issues, scored frontier.
 *
 * The LLM decides what to do next based on the returned issues and frontier.
 */

import { z } from 'zod'
import { defineTool } from '../../framework'
import { adaptBrowser } from './browser-adapter'
import { type BrowserInterface, extractPageSignals } from './extraction-engine'
import { type GraphStateSnapshot, scoreUrl } from './heuristic-scorer'
import { detectIssues } from './issue-detector'
import {
  addFrontierItems,
  createSession,
  getSession,
  getSessionStats,
} from './mapper-session'
import type { QueueItem } from './page-signals'
import { addNode, getOrCreateSession } from './store'
import { type CrawlSessionCtx, uroCrawlGate } from './uro-crawl-gate'

function getRootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.')
  if (parts.length <= 2) return hostname.toLowerCase()
  const lastTwo = parts.slice(-2).join('.')
  const TWO_PART_TLDS = new Set([
    'co.uk',
    'co.in',
    'co.jp',
    'co.nz',
    'co.za',
    'co.kr',
    'co.id',
    'com.au',
    'com.br',
    'com.mx',
    'com.ar',
    'com.sg',
    'com.hk',
    'org.uk',
    'net.au',
    'gov.uk',
    'ac.uk',
    'me.uk',
  ])
  if (TWO_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

function urlToSessionId(url: string): string {
  try {
    const u = new URL(url)
    const slug = (u.hostname + u.pathname)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase()
    return `map-${slug}-${Math.random().toString(36).slice(2, 6)}`
  } catch {
    return `map-${Math.random().toString(36).slice(2, 8)}`
  }
}

export interface StartMappingOptions {
  maxPages?: number
  maxDepth?: number
  sessionId?: string
}

function isAnalyticsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()
    const hostname = u.hostname.toLowerCase()
    const params = Array.from(u.searchParams.keys()).map((k) => k.toLowerCase())
    if (
      path.includes('/api/') ||
      path.includes('/graphql') ||
      path.includes('/rest/')
    )
      return false
    const isTrackingDomain =
      hostname.includes('analytics') ||
      hostname.includes('track') ||
      hostname.includes('metrics') ||
      hostname.includes('pixel') ||
      hostname.includes('beacon') ||
      hostname.includes('telemetry') ||
      hostname.includes('rum') ||
      hostname.includes('monitor') ||
      hostname.includes('cdn') ||
      hostname.includes('static') ||
      hostname.includes('assets')
    const hasTrackingPath = [
      '/collect',
      '/beacon',
      '/pixel',
      '/event',
      '/events',
      '/track',
      '/analytics',
      '/telemetry',
      '/metrics',
      '/rum',
      '/pageview',
      '/activity',
      '/ping',
    ].some((p) => path.includes(p))
    const hasTrackingQuery = [
      'dd-api-key',
      '_dd.',
      'api_key',
      'apikey',
      'token',
    ].some((k) => params.some((p) => p.startsWith(k)))
    if (hasTrackingQuery) return true
    if (isTrackingDomain) return true
    if (hasTrackingPath) return true
    return false
  } catch {
    return false
  }
}

export async function startMapping(
  url: string,
  browser: BrowserInterface,
  options: StartMappingOptions = {},
): Promise<string> {
  const rootUrl = url
  let seedHostname = ''
  try {
    seedHostname = new URL(rootUrl).hostname
  } catch {}
  const rootDomain = getRootDomain(seedHostname)
  const sessionId = options.sessionId ?? urlToSessionId(rootUrl)

  const session = createSession({
    sessionId,
    rootUrl,
    rootDomain,
    maxPages: options.maxPages ?? 50,
    maxDepth: options.maxDepth ?? 3,
  })

  await getOrCreateSession(sessionId)

  const uroCtx: CrawlSessionCtx = { session: { uroFilter: session.uroFilter } }
  uroCrawlGate.reset(uroCtx)

  const pageId = await browser.newPage(rootUrl, { background: false })
  await browser.goto(pageId, rootUrl)

  try {
    const signals = await extractPageSignals(pageId, browser, rootDomain)

    session.visited.add(rootUrl)
    session.depthMap.set(rootUrl, 0)
    session.pagesVisited++

    const graphState: GraphStateSnapshot = {
      visitedRoles: new Set(),
      nodeTypesPresent: new Set(['page']),
      pagesVisited: 1,
    }

    const pageNodeId = `page:${rootUrl
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9_:-]/g, '')
      .slice(0, 80)}`
    await addNode(
      rootUrl,
      'page',
      {
        url: rootUrl,
        depth: 0,
        statusCode: 200,
        title: signals.title,
        description: signals.metaDescription,
        h1: signals.h1,
        hasPasswordField: signals.hasPasswordField,
        framework: signals.frameworkDetected || undefined,
        apiCallsObserved: signals.apiCallsObserved,
        schemaOrgTypes: signals.schemaOrgBlocks.map((b) => b.type),
        interactiveElementCount: signals.interactiveElementCount,
        formCount: signals.formCount,
        dialogCount: signals.dialogCount,
        hasServiceWorker: signals.hasServiceWorker,
        webWorkerCount: signals.webWorkerCount,
        clientRoutesDiscovered: signals.clientRoutesDiscovered,
        clientRouteFramework: signals.clientRouteFramework,
        featureFlags:
          signals.featureFlagKeys.length > 0
            ? signals.featureFlagKeys.reduce<Record<string, boolean>>(
                (acc, k) => {
                  acc[k] = true
                  return acc
                },
                {},
              )
            : undefined,
        discoveredAt: new Date().toISOString(),
      },
      sessionId,
    )

    if (signals.frameworkDetected) {
      graphState.nodeTypesPresent.add('js_bundle')
      const _bundleNodeId = `js_bundle:${pageNodeId}:${signals.frameworkDetected}`
      await addNode(
        signals.frameworkDetected,
        'js_bundle',
        {
          parentPageId: pageNodeId,
          framework: signals.frameworkDetected,
          hasNextData: signals.hasNextData,
          discoveredAt: new Date().toISOString(),
        },
        sessionId,
      )
    }

    for (const form of signals.forms) {
      const formLabel = form.submitLabel || `Form ${form.index + 1}`
      const formNodeId = `form:${pageNodeId}:${form.index}`
      await addNode(
        formLabel,
        'form',
        {
          parentPageId: pageNodeId,
          action: form.action,
          method: form.method,
          hasEmailField: form.hasEmailField,
          hasPasswordField: form.hasPasswordField,
          hasPhoneField: form.hasPhoneField,
          hasFileUpload: form.hasFileUpload,
          hasCreditCardField: form.hasCreditCardField,
          hasSearchField: form.hasSearchField,
          fieldCount: form.fieldCount,
          submitLabel: form.submitLabel,
          discoveredAt: new Date().toISOString(),
        },
        sessionId,
      )
      for (const field of form.fields) {
        if (field.inputType === 'hidden' || field.inputType === 'submit')
          continue
        await addNode(
          field.label || field.name || field.inputType,
          'field',
          {
            parentFormId: formNodeId,
            inputType: field.inputType,
            name: field.name || undefined,
            label: field.label || undefined,
            placeholder: field.placeholder || undefined,
            required: field.required,
            autocomplete: field.autocomplete || undefined,
            discoveredAt: new Date().toISOString(),
          },
          sessionId,
        )
      }
    }

    for (const block of signals.schemaOrgBlocks) {
      const _schemaNodeId = `schema_org:${pageNodeId}:${block.type
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_:-]/g, '')
        .slice(0, 60)}`
      await addNode(
        block.type,
        'schema_org',
        {
          parentPageId: pageNodeId,
          schemaType: block.type,
          summary: block.summary,
          discoveredAt: new Date().toISOString(),
        },
        sessionId,
      )
    }

    const functionalApis = signals.apiCallsObserved.filter((u) => {
      try {
        const parsed = new URL(u)
        const path = parsed.pathname.toLowerCase()
        return (
          !isAnalyticsUrl(u) &&
          (path.includes('/api/') ||
            path.includes('/v1/') ||
            path.includes('/v2/') ||
            path.includes('/v3/') ||
            path.includes('/graphql') ||
            path.includes('/rest/') ||
            parsed.hostname.includes('api.'))
        )
      } catch {
        return false
      }
    })
    for (const apiCall of functionalApis.slice(0, 15)) {
      const compact =
        apiCall.length > 120 ? `${apiCall.slice(0, 119)}…` : apiCall
      await addNode(
        compact,
        'api_call',
        {
          parentPageId: pageNodeId,
          method: 'GET',
          endpoint: apiCall,
          triggerSource: 'page-load',
          discoveredAt: new Date().toISOString(),
        },
        sessionId,
      )
    }

    const frontierItems: QueueItem[] = []

    for (const linkWithContext of signals.sameDomainLinksWithContext) {
      if (uroCrawlGate.shouldEnqueue(linkWithContext.href, uroCtx, rootUrl)) {
        const item = scoreUrl(
          linkWithContext.href,
          signals,
          graphState,
          rootUrl,
          'route',
          linkWithContext.domPosition,
        )
        const queueItem: QueueItem = {
          ...item,
          tier: 'checkOnce',
          discoverySource: 'link',
        }
        frontierItems.push(queueItem)
      }
    }

    for (const route of signals.clientRoutesDiscovered) {
      const fullUrl = route.startsWith('http')
        ? route
        : `${rootUrl.startsWith('https') ? 'https' : 'http'}://${seedHostname}${route.startsWith('/') ? '' : '/'}${route}`
      if (!session.queue.has(fullUrl) && !session.visited.has(fullUrl)) {
        const item = scoreUrl(
          fullUrl,
          signals,
          graphState,
          rootUrl,
          'client_route',
        )
        item.reasoning += ' (hidden SPA route, not in navigation)'
        const queueItem: QueueItem = {
          ...item,
          tier: 'checkOnce',
          discoverySource: 'client_route',
        }
        frontierItems.push(queueItem)
      }
    }

    addFrontierItems(session, frontierItems)

    // Store signals on session so the xc_bootstrap handler can run detectIssues
    session._initialSignals = signals

    return sessionId
  } finally {
    if (pageId !== undefined) {
      try {
        await browser.closePage(pageId)
      } catch {}
    }
  }
}

export const xc_bootstrap = defineTool({
  name: 'xc_bootstrap',
  description: [
    'Initialize a website intelligence mapping session.',
    '',
    'Opens the seed URL, extracts raw signals (framework, routes, forms, APIs,',
    'service workers, auth signals), scores discovered links into a priority frontier,',
    'and returns issues that need your decision.',
    '',
    'This is the START of every mapping session. Call this once, then use',
    'xc_step to visit/interact with pages based on the returned frontier and issues.',
    '',
    'Returns raw signals — it never decides what a page "is".',
    'You (the LLM) decide what to do with each issue.',
    '',
    'Browser tabs are auto-closed after extraction to prevent memory leaks.',
    'Each xc_step call opens its own tab and closes it when done.',
  ].join('\n'),
  approvalCategory: 'observation',
  input: z.object({
    url: z.string().describe('Root URL to start mapping from'),
    maxPages: z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .default(50)
      .describe(
        'Max pages to visit during the entire mapping session (default 50)',
      ),
    maxDepth: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe('Max link depth from root (default 3)'),
    session_id: z
      .string()
      .optional()
      .describe('Graph session ID. Auto-generated from URL if omitted.'),
    mermaid_direction: z
      .enum(['LR', 'TD'])
      .default('LR')
      .describe('Mermaid diagram direction for graph export'),
  }),
  async handler(args, ctx, response) {
    const browser = adaptBrowser(ctx.browser)
    const sessionId = await startMapping(args.url, browser, {
      maxPages: args.maxPages,
      maxDepth: args.maxDepth,
      sessionId: args.session_id,
    })

    const session = getSession(sessionId)
    if (!session) {
      response.error(`Session ${sessionId} not found after initialization`)
      return
    }

    const signals = session._initialSignals
    const issues = signals ? detectIssues(signals) : []
    const stats = getSessionStats(session)

    response.text(
      JSON.stringify(
        {
          sessionId,
          rootDomain: session.rootDomain,
          initialSignals: signals
            ? {
                title: signals.title,
                h1: signals.h1,
                url: signals.url,
                framework: signals.frameworkDetected,
                formCount: signals.formCount,
                hasPasswordField: signals.hasPasswordField,
                interactiveElementCount: signals.interactiveElementCount,
                apiCallCount: signals.apiCallsObserved.length,
                clientRouteCount: signals.clientRoutesDiscovered.length,
                hasServiceWorker: signals.hasServiceWorker,
                dialogCount: signals.dialogCount,
                overlayTriggerCount: signals.overlayTriggers.length,
                sameDomainLinkCount: signals.sameDomainLinks.length,
                crossDomainLinkCount: signals.crossDomainLinks.length,
              }
            : undefined,
          issues,
          frontier: {
            mustVisit: session.queue.getMustVisitItems().slice(0, 50),
            checkOnce: session.queue.getCheckOnceItems().slice(0, 50),
          },
          stats,
        },
        null,
        2,
      ),
    )
  },
})

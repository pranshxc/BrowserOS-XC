/**
 * xc_step.ts — Execute ONE mapping action. The central tool of the Intelligence Mapper.
 *
 * Each call is ONE action on ONE page. Returns raw signals + issues + updated frontier.
 * The LLM agent calls this in a loop, making decisions between each step.
 *
 * Actions: visit, interact, probe_form, attempt_auth, dismiss_overlay,
 *          enqueue_routes, inspect_background, close_tab, skip, finish
 *
 * Browser tabs are auto-closed after each action to prevent memory leaks.
 */

import { z } from 'zod'
import { defineTool } from '../../framework'
import { adaptBrowser } from './browser-adapter'
import { type BrowserInterface, extractPageSignals } from './extraction-engine'
import {
  extractPaths,
  type GraphStateSnapshot,
  scoreUrl,
} from './heuristic-scorer'
import { detectIssues } from './issue-detector'
import {
  addAuthBlockedPage,
  addFrontierItems,
  getSession,
  getSessionStats,
  getStallStatus,
  markAuthenticated,
  markVisited,
  removeFrontierItem,
  removeOpenPage,
} from './mapper-session'
import type {
  CrawlTier,
  DiscoverySource,
  PageSignals,
  QueueItem,
} from './page-signals'
import {
  captureInteractionResult,
  capturePreSnapshot,
} from './post-interaction-capture'
import { CrawlLoop } from './crawl-loop'
import { fetchDiscoveryUrls } from './sitemap-fetcher'
import { addEdge, addNode, getSessionSummary, saveAllFormats } from './store'
import { type CrawlSessionCtx, uroCrawlGate } from './uro-crawl-gate'

const ACTION_VALUES = [
  'visit',
  'interact',
  'probe_form',
  'attempt_auth',
  'dismiss_overlay',
  'enqueue_routes',
  'inspect_background',
  'close_tab',
  'skip',
  'finish',
  'recover_stall',
  'auto_crawl',
] as const

type XcAction = (typeof ACTION_VALUES)[number]

export const xc_step = defineTool({
  name: 'xc_step',
  description: [
    'Execute ONE mapping action in an active mapper session.',
    '',
    'Returns raw extraction signals, issues requiring your decision,',
    'and an updated priority frontier. You decide what to do next.',
    '',
    'Actions:',
    '  visit — Navigate to a URL, extract all signals, discover links',
    '  interact — Click/fill an element on a page, capture state changes',
    '  probe_form — Fill and submit a form, discover post-submission behavior',
    '  attempt_auth — Fill credentials, submit login, save session on success',
    '  dismiss_overlay — Click dismiss/accept on a dialog/overlay',
    '  enqueue_routes — Add discovered client-side routes to the frontier',
    '  inspect_background — Extract service worker / web worker details',
    '  close_tab — Close a browser tab to free memory (provides target_url)',
    '  skip — Mark a URL as skipped with a reason',
    '  finish — End the mapping session, write final graph exports',
    '  recover_stall — Fetch sitemap.xml/robots.txt when stalled (50+ empty pages)',
    '  auto_crawl — Run automated continuous crawl loop. Drains the priority',
    '               queue (mustVisit → checkOnce) with stall detection and',
    '               automatic sitemap/robots.txt recovery. Stops when queue',
    '               is exhausted or limits are reached.',
    '',
    'Browser tabs are auto-closed after each action to prevent memory leaks.',
    'REQUIRED: session_id, action, reason.',
  ].join('\n'),
  approvalCategory: 'observation',
  input: z.object({
    session_id: z.string().describe('Mapper session ID from xc_bootstrap'),
    action: z.enum(ACTION_VALUES).describe('The mapping action to execute'),
    target_url: z.string().optional().describe('URL to visit/interact with'),
    element_selector: z
      .string()
      .optional()
      .describe('CSS selector for click/fill target'),
    form_data: z
      .record(z.string())
      .optional()
      .describe('Field name → value for form fill'),
    credentials: z
      .object({
        email: z.string(),
        password: z.string(),
      })
      .optional()
      .describe('Login credentials for attempt_auth'),
    routes: z
      .array(z.string())
      .optional()
      .describe('Client-side routes to enqueue'),
    dismiss_selector: z
      .string()
      .optional()
      .describe('Selector for dismiss button on overlay'),
    reason: z
      .string()
      .describe('Why you are taking this action — required for audit trail'),
  }),

  async handler(args, ctx, response) {
    const session = getSession(args.session_id)
    if (!session) {
      response.error(
        `Mapper session "${args.session_id}" not found. Call xc_bootstrap first.`,
      )
      return
    }

    const browser = adaptBrowser(ctx.browser)

    const uroCtx: CrawlSessionCtx = {
      session: { uroFilter: session.uroFilter },
    }

    const graphState = await buildGraphStateSnapshot(session)

    switch (args.action) {
      case 'visit':
        await handleVisit(args, session, browser, uroCtx, graphState, response)
        break
      case 'interact':
        await handleInteract(args, session, browser, graphState, response)
        break
      case 'probe_form':
        await handleProbeForm(args, session, browser, graphState, response)
        break
      case 'attempt_auth':
        await handleAttemptAuth(
          args,
          session,
          browser,
          uroCtx,
          graphState,
          response,
        )
        break
      case 'dismiss_overlay':
        await handleDismissOverlay(args, session, browser, graphState, response)
        break
      case 'enqueue_routes':
        await handleEnqueueRoutes(args, session, graphState, response)
        break
      case 'inspect_background':
        await handleInspectBackground(
          args,
          session,
          browser,
          graphState,
          response,
        )
        break
      case 'close_tab':
        await handleCloseTab(args, session, browser, response)
        break
      case 'skip':
        await handleSkip(args, session, response)
        break
      case 'finish':
        await handleFinish(args, session, response)
        break
      case 'recover_stall':
        await handleRecoverStall(args, session, browser, response)
        break
      case 'auto_crawl':
        await handleAutoCrawl(args, session, browser, response)
        break
    }
  },
})

async function buildGraphStateSnapshot(
  session: import('./mapper-session').MapperSession,
): Promise<GraphStateSnapshot> {
  const summary = await getSessionSummary(session.sessionId).catch(() => ({
    nodeTypes: {} as Record<string, number>,
  }))
  return {
    visitedRoles: new Set(),
    nodeTypesPresent: new Set(Object.keys(summary.nodeTypes)),
    pagesVisited: session.pagesVisited,
  }
}

async function handleVisit(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  browser: BrowserInterface,
  uroCtx: CrawlSessionCtx,
  graphState: GraphStateSnapshot,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const url = args.target_url
  if (!url) {
    response.error('target_url required for visit action')
    return
  }

  if (session.visited.has(url)) {
    response.text(
      JSON.stringify(
        {
          action: 'visit',
          targetUrl: url,
          status: 'already_visited',
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
    return
  }

  if (session.pagesVisited >= session.maxPages) {
    response.text(
      JSON.stringify(
        {
          action: 'visit',
          targetUrl: url,
          status: 'max_pages_reached',
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
    return
  }

  const depth = session.depthMap.get(url) ?? 0
  if (depth > session.maxDepth) {
    response.text(
      JSON.stringify(
        {
          action: 'visit',
          targetUrl: url,
          status: 'max_depth_exceeded',
          depth,
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
    return
  }

  let pageId: number | undefined
  try {
    pageId = await browser.newPage(url, { background: false })
    await browser.goto(pageId, url)

    const signals = await extractPageSignals(
      pageId,
      browser,
      session.rootDomain,
    )

    const frontierItems: QueueItem[] = []
    for (const linkWithContext of signals.sameDomainLinksWithContext) {
      if (uroCrawlGate.shouldEnqueue(linkWithContext.href, uroCtx, url)) {
        const item = scoreUrl(linkWithContext.href, signals, graphState, url, 'route', linkWithContext.domPosition)
        item.signals.sourceUrl = url
        const queueItem: QueueItem = {
          ...item,
          tier: 'checkOnce',
          discoverySource: 'link',
        }
        frontierItems.push(queueItem)
      }
    }

    for (const route of signals.clientRoutesDiscovered) {
      let fullUrl = route
      if (!route.startsWith('http')) {
        try {
          const base = new URL(session.rootUrl)
          fullUrl = `${base.protocol}//${base.hostname}${route.startsWith('/') ? '' : '/'}${route}`
        } catch {}
      }
      if (
        fullUrl &&
        !session.queue.has(fullUrl) &&
        !session.visited.has(fullUrl)
      ) {
        const item = scoreUrl(fullUrl, signals, graphState, url, 'client_route')
        const queueItem: QueueItem = {
          ...item,
          tier: 'checkOnce',
          discoverySource: 'client_route',
        }
        frontierItems.push(queueItem)
      }
    }

    const urlCount = frontierItems.length
    markVisited(session, url, depth, 'checkOnce', urlCount)

    const mainNodeId = await writePageToGraph(signals, session.sessionId, depth)

    addFrontierItems(session, frontierItems)

    for (const item of frontierItems.slice(0, 50)) {
      const targetPageId = `page:${sanitizeId(item.url)}`
      await addEdge(
        mainNodeId,
        targetPageId,
        'navigates_to',
        { discoveredVia: 'link', sourceUrl: url },
        session.sessionId,
      ).catch(() => {})
    }

    const issues = detectIssues(signals)

    if (signals.hasPasswordField && signals.interactiveElementCount <= 6) {
      addAuthBlockedPage(session, {
        url,
        detectedAt: Date.now(),
        signals: {
          hasPasswordField: true,
          interactiveElementCount: signals.interactiveElementCount,
        },
        depth,
      })
    }

    await saveAllFormats(session.sessionId, 'LR', false).catch(() => {})

    const stallStatus = getStallStatus(session)

    response.text(
      JSON.stringify(
        {
          action: 'visit',
          targetUrl: url,
          pageId,
          signals: compactSignals(signals),
          issues,
          frontierAdded: frontierItems.length,
          discoveredPaths: extractPaths(frontierItems.map((f) => f.url)),
          stallStatus,
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await addNode(
      url,
      'page',
      { url, depth, error: message, statusCode: 0 },
      session.sessionId,
    ).catch(() => {})
    response.error(`Visit failed for ${url}: ${message}`)
  } finally {
    if (pageId !== undefined) {
      try {
        await browser.closePage(pageId)
      } catch {}
    }
  }
}

async function handleInteract(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  browser: BrowserInterface,
  graphState: GraphStateSnapshot,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const url = args.target_url
  if (!url) {
    response.error('target_url required for interact action')
    return
  }

  let pageId: number | undefined
  try {
    pageId = await browser.newPage(url, { background: false })
    await browser.goto(pageId, url)

    const pre = await capturePreSnapshot(pageId, browser, session.rootDomain)

    if (args.element_selector && browser.click) {
      await browser.click(pageId, args.element_selector)
    } else if (args.form_data && browser.fill && browser.click) {
      for (const [name, value] of Object.entries(
        args.form_data as Record<string, string>,
      )) {
        try {
          await browser.fill(pageId, `[name="${name}"]`, value)
        } catch {
          try {
            await browser.fill(pageId, name, value)
          } catch {}
        }
      }
      try {
        await browser.click(pageId, '[type="submit"]')
      } catch {
        try {
          await browser.click(pageId, 'button[type="submit"]')
        } catch {
          try {
            await browser.click(pageId, 'button:not([type])')
          } catch {}
        }
      }
    }

    if (browser.waitForNavigation) {
      try {
        await browser.waitForNavigation(pageId, { timeout: 3000 })
      } catch {}
    } else {
      await new Promise((r) => setTimeout(r, 2000))
    }

    const result = await captureInteractionResult(
      pageId,
      browser,
      session.rootDomain,
      pre,
      args.action,
      args.element_selector || 'form_fill',
    )

    session.interactionsExecuted++

    await addNode(
      `${args.action}: ${args.reason}`,
      'action',
      {
        parentPageId: `page:${sanitizeId(url)}`,
        interactionType: args.action,
        reason: args.reason,
        elementSelector: args.element_selector,
        urlChanged: result.urlChanged,
        newUrl: result.newUrl,
        authStateChange: result.authStateChange,
        executedAt: new Date().toISOString(),
      },
      session.sessionId,
    )

    if (result.urlChanged && result.newUrl) {
      const newUrl = result.newUrl
      if (!session.visited.has(newUrl) && !session.queue.has(newUrl)) {
        const item = scoreUrl(
          newUrl,
          result.postInteractionSignals ?? ({} as PageSignals),
          graphState,
          url,
          'route',
        )
        item.suggestedScore = Math.max(item.suggestedScore, 80)
        item.reasoning = `Discovered via interaction: ${args.reason}. ${item.reasoning}`
        const queueItem: QueueItem = {
          ...item,
          tier: 'checkOnce',
          discoverySource: 'link',
        }
        addFrontierItems(session, [queueItem])
      }
      await addEdge(
        `page:${sanitizeId(url)}`,
        `page:${sanitizeId(newUrl)}`,
        'reveals',
        { action: args.action, reason: args.reason },
        session.sessionId,
      )
    }

    for (const apiCall of result.networkCallsTriggered.slice(0, 10)) {
      const compact =
        apiCall.length > 120 ? `${apiCall.slice(0, 119)}…` : apiCall
      await addNode(
        compact,
        'api_call',
        {
          parentPageId: `page:${sanitizeId(url)}`,
          method: 'POST',
          endpoint: apiCall,
          triggerSource: args.action,
          discoveredAt: new Date().toISOString(),
        },
        session.sessionId,
      )
    }

    const issues = result.postInteractionSignals
      ? detectIssues(result.postInteractionSignals)
      : []

    response.text(
      JSON.stringify(
        {
          action: 'interact',
          targetUrl: url,
          interactionResult: result,
          issues,
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    response.error(
      `Interact failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    if (pageId !== undefined) {
      try {
        await browser.closePage(pageId)
      } catch {}
    }
  }
}

async function handleProbeForm(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  browser: BrowserInterface,
  graphState: GraphStateSnapshot,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const url = args.target_url
  if (!url) {
    response.error('target_url required for probe_form action')
    return
  }

  let pageId: number | undefined
  try {
    pageId = await browser.newPage(url, { background: false })
    await browser.goto(pageId, url)

    const pre = await capturePreSnapshot(pageId, browser, session.rootDomain)

    const formData = args.form_data ?? generateSampleFormData(pageId, browser)
    if (browser.fill) {
      for (const [name, value] of Object.entries(
        formData as Record<string, string>,
      )) {
        try {
          await browser.fill(pageId, `[name="${name}"]`, value)
        } catch {
          try {
            await browser.fill(pageId, name, value)
          } catch {}
        }
      }
    }

    if (browser.click) {
      try {
        await browser.click(pageId, '[type="submit"]')
      } catch {
        try {
          await browser.click(pageId, 'button[type="submit"]')
        } catch {
          try {
            await browser.click(pageId, 'button:not([type])')
          } catch {}
        }
      }
    }

    if (browser.waitForNavigation) {
      try {
        await browser.waitForNavigation(pageId, { timeout: 5000 })
      } catch {}
    } else {
      await new Promise((r) => setTimeout(r, 3000))
    }

    const result = await captureInteractionResult(
      pageId,
      browser,
      session.rootDomain,
      pre,
      'probe_form',
      url,
    )
    session.interactionsExecuted++

    await addNode(
      `probe_form: ${args.reason}`,
      'action',
      {
        parentPageId: `page:${sanitizeId(url)}`,
        interactionType: 'probe_form',
        reason: args.reason,
        formData: Object.keys(formData),
        urlChanged: result.urlChanged,
        newUrl: result.newUrl,
        executedAt: new Date().toISOString(),
      },
      session.sessionId,
    )

    if (
      result.urlChanged &&
      result.newUrl &&
      !session.visited.has(result.newUrl) &&
      !session.queue.has(result.newUrl)
    ) {
      const item = scoreUrl(
        result.newUrl,
        result.postInteractionSignals ?? ({} as PageSignals),
        graphState,
        url,
        'route',
      )
      item.suggestedScore = Math.max(item.suggestedScore, 85)
      item.reasoning = `Discovered via form submission. ${item.reasoning}`
      const queueItem: QueueItem = {
        ...item,
        tier: 'mustVisit',
        discoverySource: 'link',
      }
      addFrontierItems(session, [queueItem])
      await addEdge(
        `page:${sanitizeId(url)}`,
        `page:${sanitizeId(result.newUrl)}`,
        'reveals',
        { via: 'form_submission' },
        session.sessionId,
      )
    }

    for (const apiCall of result.networkCallsTriggered.slice(0, 10)) {
      const compact =
        apiCall.length > 120 ? `${apiCall.slice(0, 119)}…` : apiCall
      await addNode(
        compact,
        'api_call',
        {
          parentPageId: `page:${sanitizeId(url)}`,
          method: 'POST',
          endpoint: apiCall,
          triggerSource: 'form_submission',
          discoveredAt: new Date().toISOString(),
        },
        session.sessionId,
      )
    }

    const issues = result.postInteractionSignals
      ? detectIssues(result.postInteractionSignals)
      : []

    response.text(
      JSON.stringify(
        {
          action: 'probe_form',
          targetUrl: url,
          formDataUsed: Object.keys(formData),
          interactionResult: result,
          issues,
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    response.error(
      `Probe form failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    if (pageId !== undefined) {
      try {
        await browser.closePage(pageId)
      } catch {}
    }
  }
}

async function handleAttemptAuth(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  browser: BrowserInterface,
  _uroCtx: CrawlSessionCtx,
  graphState: GraphStateSnapshot,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const url = args.target_url
  if (!url) {
    response.error('target_url required for attempt_auth action')
    return
  }
  if (!args.credentials) {
    response.error('credentials required for attempt_auth action')
    return
  }

  let pageId: number | undefined
  try {
    pageId = await browser.newPage(url, { background: false })
    await browser.goto(pageId, url)

    const pre = await capturePreSnapshot(pageId, browser, session.rootDomain)

    if (browser.fill) {
      const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[name="username"]',
        'input[autocomplete="email"]',
        'input[autocomplete="username"]',
        'input[type="text"]:first-of-type',
      ]
      for (const sel of emailSelectors) {
        try {
          await browser.fill(pageId, sel, args.credentials.email)
          break
        } catch {}
      }
      await browser.fill(
        pageId,
        'input[type="password"]',
        args.credentials.password,
      )
    }

    if (browser.click) {
      const submitSelectors = [
        '[type="submit"]',
        'button[type="submit"]',
        'button:not([type])',
      ]
      for (const sel of submitSelectors) {
        try {
          await browser.click(pageId, sel)
          break
        } catch {}
      }
    }

    if (browser.waitForNavigation) {
      try {
        await browser.waitForNavigation(pageId, { timeout: 8000 })
      } catch {}
    } else {
      await new Promise((r) => setTimeout(r, 5000))
    }

    const result = await captureInteractionResult(
      pageId,
      browser,
      session.rootDomain,
      pre,
      'attempt_auth',
      url,
    )
    session.interactionsExecuted++

    const authSucceeded =
      result.authStateChange === 'authenticated' ||
      result.authStateChange === 'unknown'

    if (authSucceeded) {
      const authStateName = `xc-auth-${session.sessionId}`
      const blockedPages = markAuthenticated(session, authStateName)

      for (const blocked of blockedPages) {
        const item = scoreUrl(
          blocked.url,
          {} as PageSignals,
          graphState,
          blocked.url,
          'route',
        )
        item.suggestedScore = 95
        item.reasoning = `Re-visit after auth: previously blocked (${Object.keys(blocked.signals).join(', ')})`
        item.assumptions = [
          'Auth session may have expired by the time we revisit',
        ]
        const queueItem: QueueItem = {
          ...item,
          tier: 'mustVisit' as CrawlTier,
          discoverySource: 'auth_unblock' as DiscoverySource,
        }
        addFrontierItems(session, [queueItem])
      }

      await addNode(
        'Auth success',
        'auth_gate',
        {
          url,
          authStateChange: result.authStateChange,
          unblockedPages: blockedPages.length,
          discoveredAt: new Date().toISOString(),
        },
        session.sessionId,
      )
    } else {
      await addNode(
        'Auth failed',
        'auth_gate',
        {
          url,
          authStateChange: 'failed',
          reason: args.reason,
          discoveredAt: new Date().toISOString(),
        },
        session.sessionId,
      )
    }

    const issues = result.postInteractionSignals
      ? detectIssues(result.postInteractionSignals)
      : []

    response.text(
      JSON.stringify(
        {
          action: 'attempt_auth',
          targetUrl: url,
          authSucceeded,
          authStateChange: result.authStateChange,
          unblockedPages: authSucceeded ? session.authBlockedPages.length : 0,
          interactionResult: result,
          issues,
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    response.error(
      `Attempt auth failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    if (pageId !== undefined) {
      removeOpenPage(session, url)
      try {
        await browser.closePage(pageId)
      } catch {}
    }
  }
}

async function handleDismissOverlay(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  browser: BrowserInterface,
  graphState: GraphStateSnapshot,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const url = args.target_url
  if (!url) {
    response.error('target_url required for dismiss_overlay action')
    return
  }

  let pageId: number | undefined
  try {
    pageId = await browser.newPage(url, { background: false })
    await browser.goto(pageId, url)

    const pre = await capturePreSnapshot(pageId, browser, session.rootDomain)

    const dismissSelectors = args.dismiss_selector
      ? [args.dismiss_selector]
      : [
          '[data-testid*="accept" i]',
          '[data-testid*="close" i]',
          '[data-testid*="dismiss" i]',
          'button:has-text("Accept")',
          'button:has-text("Close")',
          'button:has-text("Dismiss")',
          '.modal button',
          '.dialog button',
          '[role="dialog"] button',
          'button[aria-label*="close" i]',
          'button[aria-label*="accept" i]',
        ]

    if (browser.click) {
      for (const sel of dismissSelectors) {
        try {
          await browser.click(pageId, sel)
          break
        } catch {}
      }
    }

    await new Promise((r) => setTimeout(r, 1000))

    const signals = await extractPageSignals(
      pageId,
      browser,
      session.rootDomain,
    )
    const _result = await captureInteractionResult(
      pageId,
      browser,
      session.rootDomain,
      pre,
      'dismiss_overlay',
      args.dismiss_selector || 'auto',
    )

    const issues = detectIssues(signals)
    const frontierItems: QueueItem[] = []
    for (const link of signals.sameDomainLinks) {
      if (!pre.links.includes(link)) {
        const item = scoreUrl(link, signals, graphState, url, 'route')
        const queueItem: QueueItem = {
          ...item,
          tier: 'checkOnce',
          discoverySource: 'link',
        }
        frontierItems.push(queueItem)
      }
    }
    addFrontierItems(session, frontierItems)

    response.text(
      JSON.stringify(
        {
          action: 'dismiss_overlay',
          targetUrl: url,
          signals: compactSignals(signals),
          issues,
          newLinksAfterDismiss: frontierItems.length,
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    response.error(
      `Dismiss overlay failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    if (pageId !== undefined) {
      removeOpenPage(session, url)
      try {
        await browser.closePage(pageId)
      } catch {}
    }
  }
}

async function handleEnqueueRoutes(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  graphState: GraphStateSnapshot,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const routes = args.routes ?? []
  if (routes.length === 0) {
    response.error('No routes provided. Pass routes array.')
    return
  }

  const frontierItems: QueueItem[] = routes.map((route: string) => {
    let fullUrl = route
    if (!route.startsWith('http')) {
      try {
        const base = new URL(session.rootUrl)
        fullUrl = `${base.protocol}//${base.hostname}${route.startsWith('/') ? '' : '/'}${route}`
      } catch {}
    }
    const item = scoreUrl(
      fullUrl,
      {} as PageSignals,
      graphState,
      session.rootUrl,
      'client_route',
    )
    return {
      ...item,
      tier: 'checkOnce' as CrawlTier,
      discoverySource: 'client_route' as DiscoverySource,
    }
  })

  const added = addFrontierItems(session, frontierItems)

  response.text(
    JSON.stringify(
      {
        action: 'enqueue_routes',
        routesProvided: routes.length,
        addedToQueue: added,
        stats: getSessionStats(session),
      },
      null,
      2,
    ),
  )
}

async function handleInspectBackground(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  browser: BrowserInterface,
  graphState: GraphStateSnapshot,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const url = args.target_url
  if (!url) {
    response.error('target_url required for inspect_background action')
    return
  }

  let pageId: number | undefined
  try {
    pageId = await browser.newPage(url, { background: false })
    await browser.goto(pageId, url)

    const signals = await extractPageSignals(
      pageId,
      browser,
      session.rootDomain,
    )

    if (signals.hasServiceWorker) {
      await addNode(
        `SW: ${signals.serviceWorkerScriptUrl || 'active'}`,
        'js_bundle',
        {
          parentPageId: `page:${sanitizeId(url)}`,
          framework: 'service-worker',
          serviceWorkerScope: signals.serviceWorkerScope,
          serviceWorkerScriptUrl: signals.serviceWorkerScriptUrl,
          cacheNames: signals.serviceWorkerCacheNames,
          cacheUrlCount: signals.serviceWorkerCacheUrls.length,
          discoveredAt: new Date().toISOString(),
        },
        session.sessionId,
      )

      const cacheItems: QueueItem[] = signals.serviceWorkerCacheUrls
        .filter((cacheUrl) => cacheUrl.includes(session.rootDomain))
        .map((cacheUrl) => {
          const item = scoreUrl(cacheUrl, signals, graphState, url, 'route')
          return {
            ...item,
            tier: 'checkOnce' as CrawlTier,
            discoverySource: 'link' as DiscoverySource,
          }
        })
      addFrontierItems(session, cacheItems)
    }

    if (signals.webWorkerCount > 0) {
      for (const workerUrl of signals.webWorkerScriptUrls) {
        await addNode(
          `WW: ${workerUrl}`,
          'js_bundle',
          {
            parentPageId: `page:${sanitizeId(url)}`,
            framework: 'web-worker',
            scriptUrl: workerUrl,
            discoveredAt: new Date().toISOString(),
          },
          session.sessionId,
        )
      }
    }

    const issues = detectIssues(signals)

    response.text(
      JSON.stringify(
        {
          action: 'inspect_background',
          targetUrl: url,
          hasServiceWorker: signals.hasServiceWorker,
          serviceWorkerScope: signals.serviceWorkerScope,
          serviceWorkerCacheCount: signals.serviceWorkerCacheUrls.length,
          webWorkerCount: signals.webWorkerCount,
          webWorkerUrls: signals.webWorkerScriptUrls,
          cacheUrlsAddedToQueue: signals.serviceWorkerCacheUrls.filter((u) =>
            u.includes(session.rootDomain),
          ).length,
          issues,
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    response.error(
      `Inspect background failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    if (pageId !== undefined) {
      removeOpenPage(session, url)
      try {
        await browser.closePage(pageId)
      } catch {}
    }
  }
}

async function handleSkip(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const url = args.target_url
  if (!url) {
    response.error('target_url required for skip action')
    return
  }

  removeFrontierItem(session, url)
  session.visited.add(url)
  session.pagesVisited++

  await addNode(
    url,
    'page',
    {
      url,
      status: 'skipped',
      skipReason: args.reason,
      discoveredAt: new Date().toISOString(),
    },
    session.sessionId,
  )

  response.text(
    JSON.stringify(
      {
        action: 'skip',
        targetUrl: url,
        reason: args.reason,
        stats: getSessionStats(session),
      },
      null,
      2,
    ),
  )
}

async function handleCloseTab(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  _browser: BrowserInterface,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const url = args.target_url
  if (!url) {
    response.error('target_url required for close_tab action')
    return
  }

  response.text(
    JSON.stringify(
      {
        action: 'close_tab',
        targetUrl: url,
        status: 'auto_closed',
        message:
          'Tabs are auto-closed after each action. close_tab is no longer needed.',
        stats: getSessionStats(session),
      },
      null,
      2,
    ),
  )
}

async function handleFinish(
  args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const result = await saveAllFormats(session.sessionId, 'LR', true)

  response.text(
    JSON.stringify(
      {
        action: 'finish',
        reason: args.reason,
        sessionId: session.sessionId,
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        outputs: {
          ndjson: result.homeNdjsonPath,
          json: result.homeJsonPath,
          mermaid: result.homeMMDPath,
        },
        stats: getSessionStats(session),
        message: 'Session finalized. Graph exports written to disk.',
      },
      null,
      2,
    ),
  )
}

async function handleAutoCrawl(
  _args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  browser: BrowserInterface,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  const loop = new CrawlLoop()

  const result = await loop.run(session, browser, async (url, browser, session) => {
    let pageId: number | undefined
    try {
      pageId = await browser.newPage(url, { background: false })
      await browser.goto(pageId, url)

      const signals = await extractPageSignals(
        pageId,
        browser,
        session.rootDomain,
      )

      const graphState = await buildGraphStateSnapshot(session)

      const frontierItems: QueueItem[] = []
      for (const linkWithContext of signals.sameDomainLinksWithContext) {
        const uroCtx: CrawlSessionCtx = {
          session: { uroFilter: session.uroFilter },
        }
        if (uroCrawlGate.shouldEnqueue(linkWithContext.href, uroCtx, url)) {
          const item = scoreUrl(
            linkWithContext.href,
            signals,
            graphState,
            url,
            'route',
            linkWithContext.domPosition,
          )
          item.signals.sourceUrl = url
          const queueItem: QueueItem = {
            ...item,
            tier: 'checkOnce',
            discoverySource: 'link',
          }
          frontierItems.push(queueItem)
        }
      }

      for (const route of signals.clientRoutesDiscovered) {
        let fullUrl = route
        if (!route.startsWith('http')) {
          try {
            const base = new URL(session.rootUrl)
            fullUrl = `${base.protocol}//${base.hostname}${route.startsWith('/') ? '' : '/'}${route}`
          } catch {}
        }
        if (
          fullUrl &&
          !session.queue.has(fullUrl) &&
          !session.visited.has(fullUrl)
        ) {
          const item = scoreUrl(fullUrl, signals, graphState, url, 'client_route')
          const queueItem: QueueItem = {
            ...item,
            tier: 'checkOnce',
            discoverySource: 'client_route',
          }
          frontierItems.push(queueItem)
        }
      }

      const urlCount = frontierItems.length
      const depth = session.depthMap.get(url) ?? 0

      const mainNodeId = await writePageToGraph(signals, session.sessionId, depth)
      addFrontierItems(session, frontierItems)

      for (const item of frontierItems.slice(0, 50)) {
        const targetPageId = `page:${sanitizeId(item.url)}`
        await addEdge(
          mainNodeId,
          targetPageId,
          'navigates_to',
          { discoveredVia: 'link', sourceUrl: url },
          session.sessionId,
        ).catch(() => {})
      }

      if (signals.hasPasswordField && signals.interactiveElementCount <= 6) {
        addAuthBlockedPage(session, {
          url,
          detectedAt: Date.now(),
          signals: {
            hasPasswordField: true,
            interactiveElementCount: signals.interactiveElementCount,
          },
          depth,
        })
      }

      return { urlCount, depth }
    } finally {
      if (pageId !== undefined) {
        try {
          await browser.closePage(pageId)
        } catch {}
      }
    }
  })

  await saveAllFormats(session.sessionId, 'LR', false).catch(() => {})

  response.text(
    JSON.stringify(
      {
        action: 'auto_crawl',
        sessionId: session.sessionId,
        result,
        stats: getSessionStats(session),
        note: 'Automated crawl complete. Use xc_frontier to review remaining items.',
      },
      null,
      2,
    ),
  )
}

async function handleRecoverStall(
  _args: z.infer<(typeof xc_step)['input']>,
  session: import('./mapper-session').MapperSession,
  browser: BrowserInterface,
  response: { text: (s: string) => void; error: (s: string) => void },
) {
  try {
    const result = await fetchDiscoveryUrls(session.rootUrl, browser)

    const allUrls = [...result.sitemapUrls, ...result.robotsUrls]
    const uniqueUrls = [...new Set(allUrls)]

    const discoveredItems: QueueItem[] = uniqueUrls.map((url) => ({
      url,
      suggestedScore: 60,
      reasoning: 'Discovered from sitemap/robots.txt during stall recovery',
      assumptions: ['URL may already be visited or in queue'],
      signals: { source: 'stall_recovery' },
      discoveredAt: Date.now(),
      sourceUrl: session.rootUrl,
      type: 'route' as const,
      tier: 'checkOnce' as CrawlTier,
      discoverySource: 'sitemap' as DiscoverySource,
    }))

    const added = addFrontierItems(session, discoveredItems)

    response.text(
      JSON.stringify(
        {
          action: 'recover_stall',
          sessionId: session.sessionId,
          sitemapUrlsFound: result.sitemapUrls.length,
          robotsUrlsFound: result.robotsUrls.length,
          totalDiscovered: uniqueUrls.length,
          addedToQueue: added,
          sitemapError: result.sitemapError,
          robotsError: result.robotsError,
          urls: uniqueUrls.slice(0, 100),
          note: 'LLM must categorize URLs into mustVisit/checkOnce tiers via xc_frontier',
          stats: getSessionStats(session),
        },
        null,
        2,
      ),
    )
  } catch (err) {
    response.error(
      `Recover stall failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function sanitizeId(s: string): string {
  return s
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_:-]/g, '')
    .slice(0, 80)
}

const ANALYTICS_PATTERNS = [
  '/collect',
  '/beacon',
  '/pixel',
  '/impression',
  '/event',
  '/events',
  '/track',
  '/analytics',
  '/telemetry',
  '/metrics',
  '/rum',
  '/pageview',
  '/activity',
  '/visit',
  '/ping',
  '/monitor',
  '/logs',
]

const ANALYTICS_QUERY_KEYS = [
  'dd-api-key',
  '_dd.',
  'dd-evp',
  'api_key',
  'apikey',
  'token',
]

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

    const hasTrackingPath = ANALYTICS_PATTERNS.some((p) => path.includes(p))
    const hasTrackingQuery = ANALYTICS_QUERY_KEYS.some((k) =>
      params.some((p) => p.startsWith(k)),
    )
    const isFirstParty =
      hostname === u.hostname ||
      path.startsWith('/_next') ||
      path.startsWith('/__next')

    if (hasTrackingQuery) return true
    if (isTrackingDomain && !isFirstParty) return true
    if (hasTrackingPath && !isFirstParty) return true

    return false
  } catch {
    return false
  }
}

function isFunctionalApi(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()
    return (
      path.includes('/api/') ||
      path.includes('/v1/') ||
      path.includes('/v2/') ||
      path.includes('/v3/') ||
      path.includes('/graphql') ||
      path.includes('/rest/') ||
      path.includes('/rpc/') ||
      path.includes('/_rsc') ||
      u.hostname.includes('api.') ||
      u.hostname.includes('api-')
    )
  } catch {
    return false
  }
}

async function writePageToGraph(
  signals: PageSignals,
  sessionId: string,
  depth: number,
): Promise<string> {
  const pageId = `page:${sanitizeId(signals.url)}`

  await addNode(
    signals.url,
    'page',
    {
      url: signals.url,
      depth,
      statusCode: 200,
      title: signals.title,
      description: signals.metaDescription,
      h1: signals.h1,
      hasPasswordField: signals.hasPasswordField,
      passwordFieldCount: signals.passwordFieldCount,
      interactiveElementCount: signals.interactiveElementCount,
      framework: signals.frameworkDetected || undefined,
      apiCallsObserved: signals.apiCallsObserved.filter(isFunctionalApi),
      schemaOrgTypes: signals.schemaOrgBlocks.map((b) => b.type),
      formCount: signals.formCount,
      dialogCount: signals.dialogCount,
      overlayTriggerCount: signals.overlayTriggers.length,
      hasServiceWorker: signals.hasServiceWorker,
      webWorkerCount: signals.webWorkerCount,
      clientRouteCount: signals.clientRoutesDiscovered.length,
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
      hiddenFromNav: signals.clientRoutesDiscovered.length > 0,
      discoveredAt: new Date().toISOString(),
    },
    sessionId,
  )

  for (const form of signals.forms) {
    const formLabel = form.action || `form-${form.index}`
    const formNodeId = `form:${sanitizeId(signals.url)}:${form.index}`
    await addNode(
      formLabel,
      'form',
      {
        parentPageId: pageId,
        action: form.action,
        method: form.method,
        fieldCount: form.fieldCount,
        submitLabel: form.submitLabel,
        hasEmailField: form.hasEmailField,
        hasPasswordField: form.hasPasswordField,
        hasPhoneField: form.hasPhoneField,
        hasFileUpload: form.hasFileUpload,
        hasCreditCardField: form.hasCreditCardField,
        requiredFieldCount: form.requiredFieldCount,
        hiddenFieldCount: form.hiddenFieldCount,
      },
      sessionId,
    )
    await addEdge(
      pageId,
      formNodeId,
      'contains',
      { formIndex: form.index },
      sessionId,
    )

    for (const field of form.fields) {
      const fieldLabel =
        field.name ||
        field.label ||
        field.placeholder ||
        `${field.inputType}-field`
      const fieldNodeId = `field:${formNodeId}:${field.name || field.inputType}`
      await addNode(
        fieldLabel,
        'field',
        {
          parentFormId: formNodeId,
          inputType: field.inputType,
          name: field.name,
          label: field.label,
          placeholder: field.placeholder,
          required: field.required,
          autocomplete: field.autocomplete,
          options: field.options.slice(0, 10),
        },
        sessionId,
      )
      await addEdge(
        formNodeId,
        fieldNodeId,
        'contains',
        { fieldType: field.inputType },
        sessionId,
      )
    }
  }

  if (signals.frameworkDetected) {
    const bundleNodeId = `js_bundle:${sanitizeId(signals.url)}:${signals.frameworkDetected}`
    await addNode(
      signals.frameworkDetected,
      'js_bundle',
      {
        parentPageId: pageId,
        framework: signals.frameworkDetected,
        hasNextData: signals.hasNextData,
        clientRouteFramework: signals.clientRouteFramework,
        discoveredAt: new Date().toISOString(),
      },
      sessionId,
    )
    await addEdge(
      pageId,
      bundleNodeId,
      'contains',
      { framework: signals.frameworkDetected },
      sessionId,
    )
  }

  for (const block of signals.schemaOrgBlocks) {
    const schemaNodeId = `schema_org:${sanitizeId(signals.url)}:${sanitizeId(block.type)}`
    await addNode(
      block.type,
      'schema_org',
      {
        parentPageId: pageId,
        schemaType: block.type,
        summary: block.summary,
        discoveredAt: new Date().toISOString(),
      },
      sessionId,
    )
    await addEdge(
      pageId,
      schemaNodeId,
      'contains',
      { schemaType: block.type },
      sessionId,
    )
  }

  const functionalApis = signals.apiCallsObserved.filter(
    (u) => isFunctionalApi(u) && !isAnalyticsUrl(u),
  )
  for (const apiCall of functionalApis.slice(0, 15)) {
    const compact = apiCall.length > 120 ? `${apiCall.slice(0, 119)}…` : apiCall
    await addNode(
      compact,
      'api_call',
      {
        parentPageId: pageId,
        endpoint: apiCall,
        discoveredAt: new Date().toISOString(),
      },
      sessionId,
    )
  }

  const analyticsCount = signals.apiCallsObserved.filter(isAnalyticsUrl).length
  if (analyticsCount > 0) {
    await addNode(
      `analytics-surface:${analyticsCount}`,
      'api_call',
      {
        parentPageId: pageId,
        endpoint: `analytics-telemetry`,
        analyticsCallCount: analyticsCount,
        note: 'Analytics/tracking calls filtered; count only',
        discoveredAt: new Date().toISOString(),
      },
      sessionId,
    )
  }

  return pageId
}

function compactSignals(signals: PageSignals): Record<string, unknown> {
  return {
    url: signals.url,
    title: signals.title,
    h1: signals.h1,
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
    featureFlagCount: signals.featureFlagKeys.length,
    webWorkerCount: signals.webWorkerCount,
  }
}

async function generateSampleFormData(
  pageId: number,
  browser: BrowserInterface,
): Promise<Record<string, string>> {
  try {
    const res = await browser.evaluate(
      pageId,
      `(() => {
      const form = document.querySelector('form')
      if (!form) return {}
      const fields = {}
      for (const el of form.elements) {
        if (['INPUT','SELECT','TEXTAREA'].includes(el.tagName) && el.type !== 'hidden' && el.type !== 'submit') {
          const name = el.name || el.id || el.placeholder
          if (!name) continue
          if (el.type === 'email' || /email/i.test(name)) fields[name] = 'test@example.com'
          else if (el.type === 'password') fields[name] = 'TestP@ss123'
          else if (el.type === 'tel' || /phone|tel/i.test(name)) fields[name] = '+1234567890'
          else if (el.type === 'url') fields[name] = 'https://example.com'
          else if (el.type === 'number') fields[name] = '1'
          else fields[name] = 'test_value'
        }
      }
      return fields
    })()`,
    )
    return (res.value as Record<string, string>) ?? {}
  } catch {
    return {}
  }
}

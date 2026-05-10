/**
 * XC Phase 8 — Service Worker Introspection
 *
 * Tools exported:
 *   list_service_workers       — list all SWs registered for the page's origin
 *   get_service_worker_routes  — fetch SW script, extract fetch handler URL patterns
 *   get_service_worker_script  — fetch and return raw SW script source
 *   unregister_service_worker  — unregister a SW by scope (for clean-slate testing)
 *   get_sw_cache_contents      — inspect Cache API contents from inside the SW
 *
 * Architecture
 * ────────────
 * CDP ServiceWorker domain provides push events for SW state changes.
 * For listing, we prefer CDP ServiceWorker.workerRegistrationUpdated events;
 * falling back to Runtime.evaluate of navigator.serviceWorker.getRegistrations()
 * for broader compatibility.
 *
 * Route extraction is static analysis: we look for fetch event handler patterns
 * using regex heuristics that match Workbox, sw-precache, and hand-written SWs.
 * This is "good enough" for feature discovery without requiring a full JS parser.
 *
 * SW value to AI agent
 * ───────────────────
 * Service worker scripts are like a second sitemap. They contain:
 *   • precache manifests (every static asset URL the app ships)
 *   • runtime route patterns (registerRoute calls)
 *   • push notification handlers (reveals push feature)
 *   • background sync registrations (reveals offline features)
 *   • navigation fallback patterns (the SPA shell URL)
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('workers')

type CdpSession = {
  ServiceWorker: {
    enable: () => Promise<void>
    disable: () => Promise<void>
    unregister: (p: { scopeURL: string }) => Promise<void>
    on: (event: string, cb: (params: unknown) => void) => () => void
  }
  Runtime: {
    evaluate: (p: object) => Promise<{ result?: { value?: unknown; description?: string }; exceptionDetails?: unknown }>
  }
  Network: {
    enable: (p?: object) => Promise<void>
    loadResource: (p: { frameId: string; url: string }) => Promise<{ content: string; mimeType: string; status: number }>
  }
  Target: {
    getTargets: () => Promise<{ targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> }>
  }
  Page: {
    getFrameTree: () => Promise<{ frameTree: { frame: { id: string; url: string }; childFrames?: unknown[] } }>
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

export const list_service_workers = defineXcTool({
  name: 'list_service_workers',
  description:
    'List all service workers registered for the current page origin. ' +
    'Returns scope, script URL, state (installing/waiting/active), ' +
    'version ID, and whether push notifications and background sync are used. ' +
    'Service workers reveal the full offline feature set of a PWA.',
  input: z.object({ page: pageParam }),
  output: z.object({
    workers: z.array(z.any()),
    count: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession

    // Primary: Runtime.evaluate to query navigator.serviceWorker
    const evalResult = await cdp.Runtime.evaluate({
      expression: `
(async function() {
  if (!navigator.serviceWorker) return { error: 'ServiceWorker API not available' };
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.map(reg => ({
      scope: reg.scope,
      scriptURL: (reg.active || reg.waiting || reg.installing)?.scriptURL || null,
      state: reg.active ? 'active' : reg.waiting ? 'waiting' : reg.installing ? 'installing' : 'none',
      updateViaCache: reg.updateViaCache,
      active: reg.active ? { scriptURL: reg.active.scriptURL, state: reg.active.state } : null,
      waiting: reg.waiting ? { scriptURL: reg.waiting.scriptURL, state: reg.waiting.state } : null,
      installing: reg.installing ? { scriptURL: reg.installing.scriptURL, state: reg.installing.state } : null,
    }));
  } catch(e) {
    return { error: e.message };
  }
})()
`,
      returnByValue: true,
      awaitPromise: true,
    })

    const workers = (evalResult.result?.value as Array<Record<string, unknown>>) ?? []

    if (!Array.isArray(workers)) {
      const errMsg = (workers as unknown as { error?: string })?.error
      response.error(`Failed to list service workers: ${errMsg ?? 'unknown error'}`)
      return
    }

    if (workers.length === 0) {
      response.text('No service workers registered for this page.')
      response.data({ workers: [], count: 0 })
      return
    }

    const lines = workers.map((w) =>
      `  • [${w.state}] ${w.scriptURL ?? 'unknown'}\n    scope: ${w.scope}`,
    )
    response.text(`Service workers (${workers.length}):\n${lines.join('\n')}`)
    response.data({ workers, count: workers.length })
  },
})

export const get_service_worker_script = defineXcTool({
  name: 'get_service_worker_script',
  description:
    'Fetch and return the full source of a service worker script URL. ' +
    'The script contains the complete offline logic: precache manifests, ' +
    'route patterns, push handlers, background sync, and API contracts.',
  input: z.object({
    page: pageParam,
    scriptUrl: z
      .string()
      .describe('Service worker script URL (from list_service_workers)'),
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
    // Fetch via page context to carry cookies/origin
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession

    const evalResult = await cdp.Runtime.evaluate({
      expression: `
(async function() {
  try {
    const res = await fetch(${JSON.stringify(args.scriptUrl)}, { credentials: 'include' });
    const text = await res.text();
    return { source: text, status: res.status, ok: res.ok };
  } catch(e) {
    return { error: e.message };
  }
})()
`,
      returnByValue: true,
      awaitPromise: true,
    })

    const result = evalResult.result?.value as { source?: string; error?: string; status?: number }

    if (result?.error || !result?.source) {
      response.error(`Failed to fetch SW script: ${result?.error ?? 'empty response'}`)
      return
    }

    const maxLen = args.maxLength ?? 50000
    const truncated = result.source.length > maxLen
    const source = result.source.slice(0, maxLen)

    response.text(
      `Service worker script: ${args.scriptUrl}\n` +
      `Length: ${result.source.length} chars${truncated ? ` (truncated to ${maxLen})` : ''}\n\n` +
      source,
    )
    response.data({ source, length: result.source.length, truncated })
  },
})

export const get_service_worker_routes = defineXcTool({
  name: 'get_service_worker_routes',
  description:
    'Fetch the service worker script and statically extract all URL route patterns. ' +
    'Detects Workbox registerRoute, precacheAndRoute, NetworkFirst/CacheFirst strategies, ' +
    'and hand-written fetch event addEventListener patterns. ' +
    'Returns the offline route table — every URL pattern the app handles without a server.',
  input: z.object({
    page: pageParam,
    scriptUrl: z
      .string()
      .describe('Service worker script URL (from list_service_workers)'),
  }),
  output: z.object({
    routes: z.array(z.any()),
    precacheUrls: z.array(z.string()),
    strategies: z.array(z.string()),
    hasPushHandler: z.boolean(),
    hasBackgroundSync: z.boolean(),
    hasNavigationPreload: z.boolean(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession

    // Fetch SW source
    const evalResult = await cdp.Runtime.evaluate({
      expression: `
(async function() {
  try {
    const res = await fetch(${JSON.stringify(args.scriptUrl)}, { credentials: 'include' });
    return await res.text();
  } catch(e) { return ''; }
})()
`,
      returnByValue: true,
      awaitPromise: true,
    })

    const source = (evalResult.result?.value as string) ?? ''
    if (!source) {
      response.error('Could not fetch service worker source.')
      return
    }

    // ── Static analysis ──

    // Workbox registerRoute patterns
    const routePatterns: Array<{ type: string; pattern: string; strategy?: string }> = []

    // registerRoute(pattern, handler)
    const registerRouteRe = /registerRoute\s*\(\s*([^,]+),\s*new\s*(\w+)/g
    let m: RegExpExecArray | null
    while ((m = registerRouteRe.exec(source)) !== null) {
      routePatterns.push({ type: 'workbox.registerRoute', pattern: m[1].trim(), strategy: m[2] })
    }

    // addRoute / route patterns (generic)
    const genericRouteRe = /addEventListener\s*\(\s*['"]fetch['"]|on\s*fetch/g
    const hasFetchHandler = genericRouteRe.test(source)

    // URL patterns in fetch handlers: event.request.url.includes / startsWith / matches
    const urlPatternRe =
      /(?:url\.includes|url\.startsWith|url\.match|url\.pathname\s*===)\s*\(\s*['"`]([^'"` ]{2,80})['"`]/g
    while ((m = urlPatternRe.exec(source)) !== null) {
      routePatterns.push({ type: 'fetch.url.match', pattern: m[1] })
    }

    // Precache manifest: [{url: '/...', revision: '...'}]
    const precacheRe = /['"]url['"\s]*:\s*['"]([^'"]{2,200})['"](?:\s*,\s*['"]revision['"\s]*:[^}]+)?/g
    const precacheUrls: string[] = []
    while ((m = precacheRe.exec(source)) !== null) {
      const u = m[1]
      if (u.startsWith('/') || u.startsWith('http')) precacheUrls.push(u)
    }

    // Workbox strategies
    const strategyRe = /new\s+(NetworkFirst|CacheFirst|StaleWhileRevalidate|NetworkOnly|CacheOnly)\s*\(/g
    const strategies: string[] = []
    while ((m = strategyRe.exec(source)) !== null) {
      if (!strategies.includes(m[1])) strategies.push(m[1])
    }

    const hasPushHandler = source.includes("addEventListener('push'") || source.includes('"push"')
    const hasBackgroundSync =
      source.includes('sync') && (source.includes('register(') || source.includes("addEventListener('sync'"))
    const hasNavigationPreload = source.includes('navigationPreload')

    const routes = [
      ...routePatterns,
      ...(hasFetchHandler && routePatterns.length === 0
        ? [{ type: 'fetch.handler', pattern: '(all requests — fetch handler present, no explicit patterns detected)' }]
        : []),
    ]

    const lines = [
      `Service worker routes for ${args.scriptUrl}:`,
      `  Explicit routes:     ${routes.length}`,
      `  Precache entries:    ${precacheUrls.length}`,
      `  Strategies:          ${strategies.join(', ') || 'none detected'}`,
      `  Push handler:        ${hasPushHandler}`,
      `  Background sync:     ${hasBackgroundSync}`,
      `  Navigation preload:  ${hasNavigationPreload}`,
    ]
    if (routes.length > 0) {
      lines.push('  Route patterns:')
      for (const r of routes.slice(0, 20)) {
        lines.push(`    [${r.type}] ${r.pattern}${r.strategy ? ` → ${r.strategy}` : ''}`)
      }
    }
    if (precacheUrls.length > 0) {
      lines.push('  Precached URLs (first 20):')
      for (const u of precacheUrls.slice(0, 20)) lines.push(`    ${u}`)
    }

    response.text(lines.join('\n'))
    response.data({
      routes,
      precacheUrls: precacheUrls.slice(0, 200),
      strategies,
      hasPushHandler,
      hasBackgroundSync,
      hasNavigationPreload,
    })
  },
})

export const unregister_service_worker = defineXcTool({
  name: 'unregister_service_worker',
  description:
    'Unregister a service worker by scope URL. ' +
    'Useful for clean-slate testing: removes SW caching so the app hits the network directly. ' +
    'The SW will be re-registered on next page load unless the app code is changed.',
  input: z.object({
    page: pageParam,
    scope: z
      .string()
      .describe('Service worker scope URL (from list_service_workers)'),
  }),
  output: z.object({ unregistered: z.boolean(), scope: z.string() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    const evalResult = await cdp.Runtime.evaluate({
      expression: `
(async function() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    const reg = regs.find(r => r.scope === ${JSON.stringify(args.scope)});
    if (!reg) return { unregistered: false, reason: 'No SW found with this scope' };
    const result = await reg.unregister();
    return { unregistered: result };
  } catch(e) {
    return { unregistered: false, reason: e.message };
  }
})()
`,
      returnByValue: true,
      awaitPromise: true,
    })

    const result = evalResult.result?.value as { unregistered: boolean; reason?: string }
    if (!result?.unregistered) {
      response.error(`Failed to unregister SW: ${result?.reason ?? 'unknown error'}`)
      return
    }

    response.text(`Service worker unregistered: ${args.scope}`)
    response.data({ unregistered: true, scope: args.scope })
  },
})

export const get_sw_cache_contents = defineXcTool({
  name: 'get_sw_cache_contents',
  description:
    'Inspect the Cache API storage used by service workers. ' +
    'Lists all cache names and their cached URL entries. ' +
    'Reveals which assets and API responses are cached offline, ' +
    'and the exact cache key patterns the SW uses.',
  input: z.object({
    page: pageParam,
    cacheName: z
      .string()
      .optional()
      .describe('Specific cache name to inspect. If omitted, lists all caches and their entry counts.'),
    maxEntries: z
      .number()
      .default(100)
      .describe('Max cache entries to return per cache (default 100)'),
  }),
  output: z.object({ caches: z.array(z.any()) }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    const script = args.cacheName
      ? `
(async function() {
  try {
    const cache = await caches.open(${JSON.stringify(args.cacheName)});
    const keys = await cache.keys();
    return {
      cacheName: ${JSON.stringify(args.cacheName)},
      entryCount: keys.length,
      entries: keys.slice(0, ${args.maxEntries ?? 100}).map(r => ({
        url: r.url,
        method: r.method,
      }))
    };
  } catch(e) { return { error: e.message }; }
})()
`
      : `
(async function() {
  try {
    const names = await caches.keys();
    const result = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      result.push({
        cacheName: name,
        entryCount: keys.length,
        entries: keys.slice(0, ${args.maxEntries ?? 100}).map(r => ({ url: r.url, method: r.method }))
      });
    }
    return result;
  } catch(e) { return { error: e.message }; }
})()
`

    const evalResult = await cdp.Runtime.evaluate({
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    })

    const caches = evalResult.result?.value as Array<{ cacheName: string; entryCount: number; entries: Array<{ url: string }> }>

    if (!Array.isArray(caches)) {
      response.error('No Cache API access (may require SW context).')
      return
    }

    const lines = caches.map(
      (c) =>
        `  [${c.cacheName}] ${c.entryCount} entries\n` +
        c.entries.slice(0, 5).map((e) => `    - ${e.url}`).join('\n') +
        (c.entryCount > 5 ? `\n    ... and ${c.entryCount - 5} more` : ''),
    )
    response.text(`Cache API contents:\n${lines.join('\n')}`)
    response.data({ caches })
  },
})

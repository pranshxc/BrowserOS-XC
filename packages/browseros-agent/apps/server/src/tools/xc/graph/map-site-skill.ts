/**
 * map-site-skill.ts — BFS orchestrator with BrowserOS-native semantic extraction.
 *
 * Per-page extraction pipeline (7 phases, all using ctx.browser.* — NO Playwright):
 *
 *   Phase 1: ctx.browser.evaluate — title, h1, meta description, pageRole detection,
 *            JSON-LD schema.org blocks, localStorage/sessionStorage keys,
 *            JS framework detection (Next.js __NEXT_DATA__, React, Vue, Angular),
 *            detected global feature flags
 *   Phase 2: ctx.browser.snapshot — flat list of all interactive elements (inputs,
 *            buttons, selects) with their element IDs
 *   Phase 3: ctx.browser.enhancedSnapshot — full ARIA landmark tree, dialogs,
 *            shadow DOM components, cursor-interactive elements snapshot misses
 *   Phase 4: ctx.browser.getDom scoped to 'form' — raw HTML of every <form>,
 *            parsed for action, method, fields, submit button label
 *   Phase 5: ctx.browser.searchDom CSS queries — targeted element discovery:
 *            input[type=password] (auth detection), [role=dialog] (popups),
 *            [data-testid], [aria-label], buttons with onclick attributes
 *   Phase 6: ctx.browser.evaluate — Performance API entries to infer API calls
 *            made during page load (fetch/XHR resource timing)
 *   Phase 7: ctx.browser.getPageLinks — link discovery for BFS queue
 *            (uses accessibility tree — handles role="link" + shadow DOM)
 *
 * All extraction phases are non-fatal: each is individually try/caught.
 * Partial failures are recorded but never stop the crawl.
 *
 * Output: every page produces rich nodes (page, form, field, action, api_call,
 * popup, nav_region, js_bundle, local_storage, schema_org) + typed edges
 * (contains, submits_to, triggers, navigates_to, authenticates_with).
 *
 * File output: THREE formats auto-saved to TWO locations.
 *   NDJSON is appended after every node/edge write (always current).
 *   JSON + Mermaid tree are regenerated every SAVE_INTERVAL pages AND on finish.
 *   ~/.browseros/graphs/<session>.ndjson + .json + .mmd
 *   ./graphs/<session>.ndjson + .json + .mmd
 *
 * Session IDs are DETERMINISTIC from the URL (no random suffix).
 *   Same URL → same session ID → agent can resume a prior crawl.
 *   Use map_site_resume to continue from where a previous run left off.
 *
 * No Playwright APIs used anywhere. 100% ctx.browser.* only.
 */
import { z } from 'zod'
import { defineTool } from '../../framework'
import {
  addEdge,
  addNode,
  getOrCreateSession,
  getSessionSummary,
  listGraphFiles,
  loadSessionFromDisk,
  saveAllFormats,
} from './store'
import {
  slugify,
  formId,
  fieldId,
  actionId,
  apiCallId,
  popupId,
  navRegionId,
  jsBundleId,
  localStorageNodeId,
  schemaDotOrgId,
  nowISO,
} from './schema'

// How often to regenerate the full JSON + Mermaid tree during crawl.
// NDJSON is always appended immediately (disk-first, no data loss).
// JSON/MMD are periodic snapshots for inspection; final save always happens on finish.
const SAVE_INTERVAL = 10 // pages

interface BfsState {
  sessionId: string
  rootUrl: string
  visited: Set<string>
  queued: Set<string>   // O(1) membership check — replaces Array.includes
  queue: string[]
  maxDepth: number
  maxPages: number | null  // null = unlimited (crawl until exhausted)
  depthMap: Map<string, number>
  status: 'idle' | 'running' | 'done' | 'error'
  startedAt: number
  homePath: string
  cwdPath: string
  homeJsonPath: string
  cwdJsonPath: string
  homeMMDPath: string
  cwdMMDPath: string
  pagesVisited: number
  lastError: string | null
}

let bfsState: BfsState | null = null

/**
 * Deterministic session ID from URL — NO random suffix.
 * Same URL always produces the same session ID, enabling session resume.
 * Format: map-{hostname-slug}-{path-slug}
 * Examples:
 *   https://www.twilio.com/en-us  →  map-www-twilio-com-en-us
 *   https://stripe.com/docs       →  map-stripe-com-docs
 */
function urlToSessionId(url: string): string {
  try {
    const u = new URL(url)
    const hostSlug = u.hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const pathSlug = u.pathname
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 30)
    return pathSlug ? `map-${hostSlug}-${pathSlug}` : `map-${hostSlug}`
  } catch {
    return `map-${slugify(url).slice(0, 50)}`
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Infer the semantic role of a page from its URL, title and content signals.
 * All parameters are now correctly populated at the call site.
 */
function inferPageRole(
  url: string,
  title: string,
  h1: string,
  hasPassword: boolean,
  hasPricing: boolean,
  hasDocs: boolean,
): 'landing' | 'login' | 'dashboard' | 'form' | 'docs' | 'pricing' | 'blog' | 'other' {
  const text = (title + ' ' + h1).toLowerCase()
  const urlLower = url.toLowerCase()
  if (hasPassword || /sign.?in|log.?in|login/.test(text) || /\/login|\/signin|\/auth/.test(urlLower)) return 'login'
  if (hasPricing || /pricing|plan|subscription/.test(text) || /\/pricing|\/plans/.test(urlLower)) return 'pricing'
  if (hasDocs || /docs|documentation|api.?reference/.test(text) || /\/docs|\/documentation|\/api-reference|\/reference/.test(urlLower)) return 'docs'
  if (/dashboard|console|admin|portal/.test(text) || /\/dashboard|\/console|\/admin/.test(urlLower)) return 'dashboard'
  if (/blog|post|article|news/.test(text) || /\/blog|\/posts|\/news/.test(urlLower)) return 'blog'
  return 'landing'
}

function inferFormPurpose(action: string, fields: Array<{ inputType: string; name?: string; label?: string }>): string {
  const actionLower = action.toLowerCase()
  const names = fields.map(f => (f.name ?? f.label ?? '').toLowerCase()).join(' ')
  if (/login|signin|auth/.test(actionLower) || (fields.some(f => f.inputType === 'password'))) return 'Sign In'
  if (/register|signup|join/.test(actionLower) || /username|firstname|lastname/.test(names)) return 'Sign Up'
  if (/search/.test(actionLower) || /search|query|q/.test(names)) return 'Search'
  if (/contact|support|help/.test(actionLower)) return 'Contact'
  if (/subscribe|newsletter/.test(actionLower) || /email/.test(names)) return 'Subscribe'
  if (/reset|forgot|recover/.test(actionLower)) return 'Password Reset'
  if (/checkout|payment|pay/.test(actionLower)) return 'Checkout'
  return 'Submit'
}

/**
 * Clean a raw URL for use as a node label or meta array entry.
 * Strips query string + fragment. Preserves scheme + host + path.
 * Returns path-only string capped at 120 chars.
 */
function cleanUrlLabel(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    const clean = u.origin + u.pathname
    return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean
  } catch {
    const noQuery = rawUrl.split('?')[0].split('#')[0]
    return noQuery.length > 120 ? `${noQuery.slice(0, 117)}...` : noQuery
  }
}

// ─── Main BFS tool ────────────────────────────────────────────────────────────

export const map_site_start = defineTool({
  name: 'map_site_start',
  description: [
    'Autonomously BFS-crawl a website and build a rich semantic knowledge graph.',
    'Uses 7 BrowserOS-native extraction phases per page (ctx.browser.* only — no Playwright):',
    '  Phase 1: JS evaluate — title, h1, description, pageRole, JSON-LD, localStorage, JS framework',
    '  Phase 2: snapshot — all interactive elements (inputs, buttons, selects)',
    '  Phase 3: enhancedSnapshot — ARIA landmarks, dialogs, shadow DOM',
    '  Phase 4: getDom("form") — raw HTML of every <form> for field extraction',
    '  Phase 5: searchDom — CSS queries for passwords, dialogs, ARIA-labeled elements',
    '  Phase 6: evaluate — Performance API network interception for API call detection',
    '  Phase 7: getPageLinks — BFS link discovery via accessibility tree',
    '',
    'After this call completes, the graph already contains:',
    'routes, feature flags, GraphQL endpoints, Redux slices, JS bundles, nav regions,',
    'forms (global), schema.org, api_calls — DO NOT call eval_extract_* again.',
    '',
    'SESSION CONTINUITY: Session IDs are deterministic from the URL.',
    'Same URL always produces the same session ID. If a prior crawl exists for this URL,',
    'use map_site_resume instead to continue from where it left off.',
    '',
    'maxPages: Set based on site size. Small site: 20-30. Medium: 50-80. Large/docs: 100+.',
    'Omit maxPages to crawl until all discovered links at maxDepth are exhausted.',
    'maxDepth: 1 = homepage only. 2 = homepage + linked pages (recommended). 3+ = deep crawl.',
  ].join('\n'),
  approvalCategory: 'observation',
  input: z.object({
    url: z.string().describe('Root URL to start crawling from'),
    maxDepth: z.coerce.number().int().min(1).max(5).default(2)
      .describe('Maximum BFS depth (default: 2, max: 5). Use 3+ for documentation sites.'),
    maxPages: z.coerce.number().int().min(1).max(500).optional()
      .describe('Maximum pages to visit. Omit to crawl all discovered links. Small site: 20-30. Medium: 50-100. Large/docs: 100-500.'),
    session_id: z.string().optional()
      .describe('Graph session ID. Auto-generated from URL if omitted (deterministic — same URL = same ID).'),
    mermaid_direction: z.enum(['LR', 'TD']).default('LR')
      .describe('Mermaid diagram direction: LR (left-to-right) or TD (top-down).'),
  }),

  async handler(args, ctx, response) {
    const origin = (() => {
      try { return new URL(args.url).origin } catch { return args.url }
    })()

    const sessionId = args.session_id ?? urlToSessionId(args.url)
    const session = await getOrCreateSession(sessionId)
    const mermaidDir = (args.mermaid_direction ?? 'LR') as 'LR' | 'TD'
    const maxPages = args.maxPages ?? Infinity

    bfsState = {
      sessionId,
      rootUrl: args.url,
      visited: new Set(),
      queued: new Set([args.url]),  // O(1) membership check
      queue: [args.url],
      maxDepth: args.maxDepth,
      maxPages: args.maxPages ?? null,
      depthMap: new Map([[args.url, 0]]),
      status: 'running',
      startedAt: Date.now(),
      homePath: session.homePath,
      cwdPath: session.cwdPath,
      homeJsonPath: session.homePath.replace(/\.ndjson$/, '.json'),
      cwdJsonPath: session.cwdPath.replace(/\.ndjson$/, '.json'),
      homeMMDPath: session.homePath.replace(/\.ndjson$/, '.mmd'),
      cwdMMDPath: session.cwdPath.replace(/\.ndjson$/, '.mmd'),
      pagesVisited: 0,
      lastError: null,
    }

    await addNode('Root', 'page', { url: args.url, depth: 0 }, sessionId)

    while (bfsState.queue.length > 0 && bfsState.pagesVisited < maxPages) {
      const url = bfsState.queue.shift()!
      if (bfsState.visited.has(url)) continue
      bfsState.visited.add(url)
      bfsState.pagesVisited++

      const depth = bfsState.depthMap.get(url) ?? 0
      let pageId: number | undefined
      const pageSlug = slugify(url)

      try {
        pageId = await ctx.browser.newPage(url, { background: true })
        await ctx.browser.goto(pageId, url)

        // ── Phase 1: JS evaluate — page semantics, framework, storage ──────────────────
        let title = url
        let h1 = ''
        let description = ''
        let hasPassword = false
        let localStorageKeys: string[] = []
        let sessionStorageKeys: string[] = []
        let framework = ''
        let hasNextData = false
        let featureFlags: Record<string, unknown> = {}
        let schemaOrgBlocks: Array<{ type: string; summary: string }> = []
        let apiCallsObserved: string[] = []

        try {
          const semanticsResult = await ctx.browser.evaluate(pageId, `(() => {
            const title = document.title || document.location.pathname
            const h1 = document.querySelector('h1')?.textContent?.trim() ?? ''
            const desc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
            const hasPassword = !!document.querySelector('input[type="password"]')

            // localStorage / sessionStorage keys
            const lsKeys = Object.keys(localStorage).slice(0, 30)
            const ssKeys = Object.keys(sessionStorage).slice(0, 30)

            // Framework detection
            const hasNextData = !!window.__NEXT_DATA__
            const hasReact = !!(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__)
            const hasVue = !!(window.__VUE__ || window.Vue)
            const hasAngular = !!(window.ng || window.getAllAngularRootElements)
            let framework = ''
            if (hasNextData) framework = 'Next.js'
            else if (hasReact) framework = 'React'
            else if (hasVue) framework = 'Vue'
            else if (hasAngular) framework = 'Angular'

            // Feature flags
            let flags = {}
            try {
              if (window.__FEATURE_FLAGS__) flags = { ...window.__FEATURE_FLAGS__ }
              else if (window.featureFlags) flags = { ...window.featureFlags }
              else if (window.__FLAGS__) flags = { ...window.__FLAGS__ }
            } catch {}

            // JSON-LD schema.org blocks
            const schemaBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
              .map(el => { try { return JSON.parse(el.textContent ?? '{}') } catch { return null } })
              .filter(Boolean)
              .map(b => ({ type: b['@type'] ?? 'Unknown', summary: JSON.stringify(b).slice(0, 200) }))

            return { title, h1, desc, hasPassword, lsKeys, ssKeys,
                     hasNextData, hasReact, hasVue, hasAngular, framework,
                     flags, schemaBlocks }
          })()`)

          if (semanticsResult.value && typeof semanticsResult.value === 'object') {
            const v = semanticsResult.value as Record<string, unknown>
            title = typeof v.title === 'string' ? v.title : url
            h1 = typeof v.h1 === 'string' ? v.h1 : ''
            description = typeof v.desc === 'string' ? v.desc : ''
            hasPassword = v.hasPassword === true
            localStorageKeys = Array.isArray(v.lsKeys) ? v.lsKeys as string[] : []
            sessionStorageKeys = Array.isArray(v.ssKeys) ? v.ssKeys as string[] : []
            framework = typeof v.framework === 'string' ? v.framework : ''
            hasNextData = v.hasNextData === true
            featureFlags = typeof v.flags === 'object' && v.flags !== null ? v.flags as Record<string, unknown> : {}
            schemaOrgBlocks = Array.isArray(v.schemaBlocks) ? v.schemaBlocks as Array<{ type: string; summary: string }> : []
          }
        } catch { /* Phase 1 failed — continue with defaults */ }

        // ── Phase 6: Performance API — infer API calls from resource timing ────────
        try {
          const perfResult = await ctx.browser.evaluate(pageId, `(() => {
            return performance.getEntriesByType('resource')
              .filter(e => {
                const url = e.name
                return (url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/')
                  || url.includes('/graphql') || url.includes('/rest/')
                  || e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')
              })
              .map(e => e.name)
              .slice(0, 20)
          })()`)
          if (Array.isArray(perfResult.value)) {
            // Clean: strip query strings, store path-only labels (fix Issue 3+4)
            apiCallsObserved = (perfResult.value as string[])
              .map(cleanUrlLabel)
              .slice(0, 10)
          }
        } catch { /* Phase 6 failed — continue */ }

        // ── Phase 5: searchDom — detect dialogs + password fields ──────────────
        let hasDialogs = false
        let dialogCount = 0
        try {
          const dialogSearch = await ctx.browser.searchDom(pageId, '[role="dialog"],[role="alertdialog"],.modal,dialog', { limit: 10 })
          hasDialogs = dialogSearch.results.length > 0
          dialogCount = dialogSearch.results.l
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
 * Crawl modes:
 *   Normal:     maxPages cap enforced (default 50). Stops at cap.
 *   Exhaustive: exhaustive=true. Crawls until queue is empty (all reachable
 *               same-origin URLs visited). Safety limit via hardAbortAfter
 *               (default 2000) prevents infinite loops on huge sites.
 *
 * Auth modes:
 *   none:        Default. Auth-wall pages are recorded as login nodes but
 *                the crawl does NOT attempt to authenticate.
 *   ask:         When an auth-wall is detected the crawl PAUSES. The agent
 *                asks the user to log in manually in the open browser tab
 *                and calls map_site_resume once done. All subsequent pages
 *                are crawled with the live authenticated session.
 *   credentials: Caller supplies loginUrl + email/username + password.
 *                The crawler auto-fills and submits the login form, waits
 *                for navigation success, then resumes BFS authenticated.
 *                On failure falls back to 'ask' mode.
 *
 * File output:
 *   NDJSON:      appended on every node/edge write (real-time).
 *   JSON + MMD:  regenerated every SAVE_INTERVAL pages and always on
 *               completion, to avoid excessive I/O on large crawls.
 *   ~/.browseros/graphs/<session>.ndjson + .json + .mmd
 *   ./graphs/<session>.ndjson + .json + .mmd
 *
 * No Playwright APIs used anywhere. 100% ctx.browser.* only.
 */
import { z } from 'zod'
import { defineTool } from '../../framework'
import {
  addEdge,
  addNode,
  generateSessionId,
  getOrCreateSession,
  getSessionSummary,
  saveAllFormats,
} from './store'
import {
  slugify,
  nowISO,
} from './schema'

// ─── Constants ─────────────────────────────────────────────────────────────

/** Truncation limit for api_call node labels (full URL still in meta.endpoint). */
const API_CALL_LABEL_MAX = 120

/** localStorage keys stored as graph nodes per page (aligned with Phase 1 cap). */
const LOCAL_STORAGE_NODE_CAP = 30

/**
 * Exhaustive mode: hard abort after this many pages regardless, to prevent
 * runaway crawls on massive sites. User can raise via hardAbortAfter param.
 */
const EXHAUSTIVE_DEFAULT_HARD_ABORT = 2000

/** Progress checkpoint interval in exhaustive mode. */
const EXHAUSTIVE_PROGRESS_INTERVAL = 25

/**
 * BUG 3 FIX: Use a finite sentinel instead of Infinity so JSON.stringify
 * never produces `null` for maxPages/maxDepth in exhaustive mode.
 * 999_999 is an effective infinity — hardAbortAfter (default 2000) fires first.
 */
const MAX_PAGES_SENTINEL = 999_999

/**
 * BUG 5 FIX: Throttle saveAllFormats(flush=false) calls to every N pages.
 * Calling it on every single page causes massive async I/O inside an open
 * streaming response window, triggering the stream frame watchdog.
 * The final saveAllFormats(flush=true) in each handler's completion path
 * is always called regardless.
 */
const SAVE_INTERVAL = 10

// ─── Auth session state ───────────────────────────────────────────────────────────

interface AuthSession {
  /** Has a successful login been performed this crawl session? */
  authenticated: boolean
  /** URL of the login page that triggered auth detection. */
  loginUrl: string | null
  /** How authentication was (or will be) performed. */
  method: 'manual' | 'auto' | 'none'
  /** pageId of the tab kept open for manual login (authMode='ask'). */
  loginPageId: number | null
  /** Credentials for auto-login (authMode='credentials'). */
  credentials: { loginUrl: string; email: string; password: string } | null
  /**
   * BUG C FIX: authWallsSeen now resets to 0 after each successful auth.
   * Previously it accumulated across the entire crawl lifetime, so after
   * 3 total auth walls the guard (authWallsSeen < 3) permanently stopped
   * triggering and post-auth pages matching login URL patterns were silently
   * passed through, corrupting the graph.
   */
  authWallsSeen: number
}

// ─── BFS state ────────────────────────────────────────────────────────────────────

interface BfsState {
  sessionId: string
  rootUrl: string
  visited: Set<string>
  /** O(1) queue membership check (replaces queue.includes). */
  queued: Set<string>
  queue: string[]
  /** Effective page depth limit. MAX_PAGES_SENTINEL in exhaustive mode. */
  maxDepth: number
  /** Effective page cap. MAX_PAGES_SENTINEL in exhaustive mode. */
  maxPages: number
  /** Hard safety limit for exhaustive mode. */
  hardAbortAfter: number
  depthMap: Map<string, number>
  status: 'idle' | 'running' | 'paused' | 'done' | 'error'
  pauseReason: string | null
  startedAt: number
  homePath: string
  cwdPath: string
  homeJsonPath: string
  cwdJsonPath: string
  homeMMDPath: string
  cwdMMDPath: string
  pagesVisited: number
  lastError: string | null
  exhaustive: boolean
  authMode: 'none' | 'ask' | 'credentials'
  auth: AuthSession
  mermaidDir: 'LR' | 'TD'
  // BUG 1 FIX: ctx and response removed from BfsState.
  // They were stored but never read back — runBfsLoop receives response as a
  // live parameter on every call. Keeping closed handles on the state caused
  // map_site_resume to write to the already-finished map_site_start stream.
}

let bfsState: BfsState | null = null

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    return generateSessionId()
  }
}

/**
 * hasPricing/hasDocs derived from URL path (not hardcoded false).
 */
function inferPageRole(
  title: string,
  h1: string,
  hasPassword: boolean,
  hasPricing: boolean,
  hasDocs: boolean,
): 'landing' | 'login' | 'dashboard' | 'form' | 'docs' | 'pricing' | 'blog' | 'other' {
  const text = (title + ' ' + h1).toLowerCase()
  if (hasPassword || /sign.?in|log.?in|login/.test(text)) return 'login'
  if (hasPricing || /pricing|plan|subscription/.test(text)) return 'pricing'
  if (hasDocs || /docs|documentation|api.?reference/.test(text)) return 'docs'
  if (/dashboard|console|admin|portal/.test(text)) return 'dashboard'
  if (/blog|post|article|news/.test(text)) return 'blog'
  return 'landing'
}

function inferFormPurpose(
  action: string,
  fields: Array<{ inputType: string; name?: string; label?: string }>,
): string {
  const actionLower = action.toLowerCase()
  const names = fields.map(f => (f.name ?? f.label ?? '').toLowerCase()).join(' ')
  if (/login|signin|auth/.test(actionLower) || fields.some(f => f.inputType === 'password')) return 'Sign In'
  if (/register|signup|join/.test(actionLower) || /username|firstname|lastname/.test(names)) return 'Sign Up'
  if (/search/.test(actionLower) || /search|query|q/.test(names)) return 'Search'
  if (/contact|support|help/.test(actionLower)) return 'Contact'
  if (/subscribe|newsletter/.test(actionLower) || /email/.test(names)) return 'Subscribe'
  if (/reset|forgot|recover/.test(actionLower)) return 'Password Reset'
  if (/checkout|payment|pay/.test(actionLower)) return 'Checkout'
  return 'Submit'
}

/** Truncate api_call labels. Full URL still in meta.endpoint. */
function apiCallLabel(method: string, endpoint: string): string {
  const full = `${method} ${endpoint}`
  return full.length > API_CALL_LABEL_MAX ? `${full.slice(0, API_CALL_LABEL_MAX - 1)}…` : full
}

/** Strip scheme+host from Performance API URLs to reduce meta bloat. */
function compactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return u.pathname + (u.search ? u.search.slice(0, 80) : '')
  } catch {
    return rawUrl.slice(0, 120)
  }
}

/**
 * Detect whether the current page is an auth wall.
 *
 * Returns true if ANY of:
 *   1. URL path matches common login route patterns
 *   2. Page has a password field AND very few other content nodes
 *      (i.e. the page exists solely to authenticate)
 *   3. The page title/h1 strongly indicates a login page
 */
function isAuthWall(
  url: string,
  hasPassword: boolean,
  title: string,
  h1: string,
  interactiveCount: number,
): boolean {
  const path = (() => { try { return new URL(url).pathname.toLowerCase() } catch { return url.toLowerCase() } })()
  const text = (title + ' ' + h1).toLowerCase()

  // Pattern 1: URL is a well-known login route
  if (/\/(login|signin|sign-in|log-in|auth|oauth|sso|authenticate)(\/|\?|$)/.test(path)) return true

  // Pattern 2: password field present AND page is sparse (auth-only page)
  if (hasPassword && interactiveCount <= 6) return true

  // Pattern 3: title/h1 screams login
  if (/^(sign in|log in|login|sign into|log into|welcome back|authenticate)/.test(text)) return true

  return false
}

/**
 * BUG 2 FIX: Safe progress emitter.
 * Wraps response.progress() in try/catch so that runtimes which do not expose
 * .progress on the map_site_resume / map_site_provide_credentials response
 * object cannot corrupt the tool output envelope mid-stream.
 */
function safeProgress(response: { progress?: (msg: string) => void }, msg: string): void {
  try {
    if (typeof response.progress === 'function') {
      response.progress(msg)
    }
  } catch { /* never let progress emission crash the crawl */ }
}

// ─── Auto-login helper ───────────────────────────────────────────────────────────────

/**
 * Attempt to auto-fill and submit a login form.
 *
 * Strategy:
 *   1. Navigate to loginUrl (or reuse existing tab if already there).
 *   2. Find email/username field via common selectors, fill with email.
 *   3. Find password field, fill with password.
 *   4. Click submit button.
 *   5. Wait for navigation — success = URL changed away from login page.
 *
 * Returns { success, finalUrl, error }.
 */
async function attemptAutoLogin(
  browser: {
    newPage: (url: string, opts?: Record<string, unknown>) => Promise<number>
    goto: (id: number, url: string) => Promise<void>
    evaluate: (id: number, script: string) => Promise<{ value: unknown }>
    fill: (id: number, selector: string, value: string) => Promise<void>
    click: (id: number, selector: string) => Promise<void>
    waitForNavigation?: (id: number, opts?: Record<string, unknown>) => Promise<void>
    closePage: (id: number) => Promise<void>
  },
  credentials: { loginUrl: string; email: string; password: string },
): Promise<{ success: boolean; pageId: number; finalUrl: string; error?: string }> {
  let pageId = -1
  try {
    pageId = await browser.newPage(credentials.loginUrl, { background: false })
    await browser.goto(pageId, credentials.loginUrl)

    // Fill email / username
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[name="user"]',
      'input[name="login"]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      'input[type="text"][name*="email" i]',
      'input[type="text"][name*="user" i]',
      'input[type="text"][placeholder*="email" i]',
      'input[type="text"][placeholder*="username" i]',
      'input[type="text"]:first-of-type',
    ]
    let emailFilled = false
    for (const sel of emailSelectors) {
      try {
        await browser.fill(pageId, sel, credentials.email)
        emailFilled = true
        break
      } catch { /* try next */ }
    }
    if (!emailFilled) throw new Error('Could not find email/username input field.')

    // Fill password
    await browser.fill(pageId, 'input[type="password"]', credentials.password)

    // Click submit
    const submitSelectors = [
      '[type="submit"]',
      'button[type="submit"]',
      'button:not([type])',
      'input[type="submit"]',
      '[data-testid*="submit" i]',
      '[data-testid*="login" i]',
      '[data-testid*="signin" i]',
    ]
    let submitted = false
    for (const sel of submitSelectors) {
      try {
        await browser.click(pageId, sel)
        submitted = true
        break
      } catch { /* try next */ }
    }
    if (!submitted) throw new Error('Could not find submit button.')

    // Wait for navigation if available
    if (browser.waitForNavigation) {
      try { await browser.waitForNavigation(pageId, { timeout: 8000 }) } catch { /* best effort */ }
    } else {
      // Fallback: poll for URL change (max 8s)
      const startUrl = credentials.loginUrl
      for (let i = 0; i < 16; i++) {
        await new Promise(r => setTimeout(r, 500))
        const res = await browser.evaluate(pageId, 'window.location.href')
        const cur = typeof res.value === 'string' ? res.value : ''
        if (cur && cur !== startUrl && !cur.includes('/login') && !cur.includes('/signin')) break
      }
    }

    const finalUrlRes = await browser.evaluate(pageId, 'window.location.href')
    const finalUrl = typeof finalUrlRes.value === 'string' ? finalUrlRes.value : credentials.loginUrl

    // Determine success: URL moved away from login page
    let finalPath = ''
    try { finalPath = new URL(finalUrl).pathname.toLowerCase() } catch {}
    const success = !/\/(login|signin|sign-in|log-in|auth)/.test(finalPath)

    return { success, pageId, finalUrl }
  } catch (err) {
    return {
      success: false,
      pageId,
      finalUrl: credentials.loginUrl,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Core BFS page processor ───────────────────────────────────────────────────────────

/**
 * Process a single URL in the BFS loop.
 * Extracted so it can be called both from the main loop and from resume.
 * Returns 'auth-wall' if crawl should be paused for authentication.
 */
async function processBfsPage(
  url: string,
  state: BfsState,
  browser: {
    newPage: (url: string, opts?: Record<string, unknown>) => Promise<number>
    goto: (id: number, url: string) => Promise<void>
    evaluate: (id: number, script: string) => Promise<{ value: unknown }>
    snapshot: (id: number) => Promise<string | undefined>
    enhancedSnapshot: (id: number) => Promise<string | undefined>
    getDom: (id: number, opts: Record<string, unknown>) => Promise<string | null>
    searchDom: (id: number, selector: string, opts?: Record<string, unknown>) => Promise<{ results: unknown[] }>
    getPageLinks: (id: number) => Promise<Array<{ href: string }>>
    fill?: (id: number, selector: string, value: string) => Promise<void>
    click?: (id: number, selector: string) => Promise<void>
    waitForNavigation?: (id: number, opts?: Record<string, unknown>) => Promise<void>
    closePage: (id: number) => Promise<void>
  },
  origin: string,
): Promise<'ok' | 'auth-wall'> {
  const depth = state.depthMap.get(url) ?? 0
  let pageId: number | undefined
  const sessionId = state.sessionId
  const mermaidDir = state.mermaidDir

  // Derive hasPricing / hasDocs from URL path
  let urlPath = ''
  try { urlPath = new URL(url).pathname.toLowerCase() } catch { urlPath = url.toLowerCase() }
  const hasPricingUrl = /pricing|plans|subscription/.test(urlPath)
  const hasDocsUrl = /\/docs|\/documentation|\/api-reference|\/reference/.test(urlPath)

  try {
    pageId = await browser.newPage(url, { background: true })
    await browser.goto(pageId, url)

    // ── Phase 1: JS evaluate — page semantics, framework, storage ──────────
    let title = url
    let h1 = ''
    let description = ''
    let hasPassword = false
    let interactiveCount = 0
    let localStorageKeys: string[] = []
    let sessionStorageKeys: string[] = []
    let framework = ''
    let hasNextData = false
    let featureFlags: Record<string, unknown> = {}
    let schemaOrgBlocks: Array<{ type: string; summary: string }> = []
    let apiCallsObserved: string[] = []

    try {
      const semanticsResult = await browser.evaluate(pageId, `(() => {
        const title = document.title || document.location.pathname
        const h1 = document.querySelector('h1')?.textContent?.trim() ?? ''
        const desc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
        const hasPassword = !!document.querySelector('input[type="password"]')
        const interactiveCount = document.querySelectorAll('input,button,select,textarea,a[href]').length

        const lsKeys = Object.keys(localStorage).slice(0, 30)
        const ssKeys = Object.keys(sessionStorage).slice(0, 30)

        const hasNextData = !!window.__NEXT_DATA__
        const hasReact = !!(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__)
        const hasVue = !!(window.__VUE__ || window.Vue)
        const hasAngular = !!(window.ng || window.getAllAngularRootElements)
        let framework = ''
        if (hasNextData) framework = 'Next.js'
        else if (hasReact) framework = 'React'
        else if (hasVue) framework = 'Vue'
        else if (hasAngular) framework = 'Angular'

        let flags = {}
        try {
          if (window.__FEATURE_FLAGS__) flags = { ...window.__FEATURE_FLAGS__ }
          else if (window.featureFlags) flags = { ...window.featureFlags }
          else if (window.__FLAGS__) flags = { ...window.__FLAGS__ }
        } catch {}

        const schemaBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .map(el => { try { return JSON.parse(el.textContent ?? '{}') } catch { return null } })
          .filter(Boolean)
          .map(b => ({ type: b['@type'] ?? 'Unknown', summary: JSON.stringify(b).slice(0, 200) }))

        return { title, h1, desc, hasPassword, interactiveCount, lsKeys, ssKeys,
                 hasNextData, framework, flags, schemaBlocks }
      })()`)

      if (semanticsResult.value && typeof semanticsResult.value === 'object') {
        const v = semanticsResult.value as Record<string, unknown>
        title = typeof v.title === 'string' ? v.title : url
        h1 = typeof v.h1 === 'string' ? v.h1 : ''
        description = typeof v.desc === 'string' ? v.desc : ''
        hasPassword = v.hasPassword === true
        interactiveCount = typeof v.interactiveCount === 'number' ? v.interactiveCount : 0
        localStorageKeys = Array.isArray(v.lsKeys) ? v.lsKeys as string[] : []
        sessionStorageKeys = Array.isArray(v.ssKeys) ? v.ssKeys as string[] : []
        framework = typeof v.framework === 'string' ? v.framework : ''
        hasNextData = v.hasNextData === true
        featureFlags = typeof v.flags === 'object' && v.flags !== null ? v.flags as Record<string, unknown> : {}
        schemaOrgBlocks = Array.isArray(v.schemaBlocks) ? v.schemaBlocks as Array<{ type: string; summary: string }> : []
      }
    } catch { /* Phase 1 failed */ }

    // ── Auth-wall detection ─────────────────────────────────────────────────────
    if (
      state.authMode !== 'none' &&
      !state.auth.authenticated &&
      state.auth.authWallsSeen < 3 &&
      isAuthWall(url, hasPassword, title, h1, interactiveCount)
    ) {
      state.auth.loginUrl = url
      state.auth.authWallsSeen++

      // Record the auth-gate node before pausing
      await addNode(title, 'auth_gate', {
        url,
        depth,
        detectedAt: nowISO(),
        authWallReason: hasPassword ? 'password-field' : 'url-pattern',
      }, sessionId).catch(() => {})

      if (pageId !== undefined) {
        try { await browser.closePage(pageId) } catch {}
      }
      return 'auth-wall'
    }

    // ── Phase 6: Performance API ────────────────────────────────────────────────
    try {
      const perfResult = await browser.evaluate(pageId, `(() => {
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
        apiCallsObserved = perfResult.value as string[]
      }
    } catch { /* Phase 6 failed */ }

    // ── Phase 5: searchDom ──────────────────────────────────────────────────────
    let hasDialogs = false
    let dialogCount = 0
    try {
      const dialogSearch = await browser.searchDom(pageId, '[role="dialog"],[role="alertdialog"],.modal,dialog', { limit: 10 })
      hasDialogs = dialogSearch.results.length > 0
      dialogCount = dialogSearch.results.length
    } catch { /* Phase 5 failed */ }

    const pageRole = inferPageRole(title, h1, hasPassword, hasPricingUrl, hasDocsUrl)
    const compactApiCalls = apiCallsObserved.map(compactUrl)

    // ── Add main page node ─────────────────────────────────────────────────
    const { nodeId: mainNodeId } = await addNode(
      title,
      'page',
      {
        url,
        depth,
        statusCode: 200,
        title,
        description,
        h1,
        pageRole,
        hasAuth: hasPassword,
        authenticated: state.auth.authenticated,
        framework: framework || undefined,
        apiCallsObserved: compactApiCalls,
        schemaOrgTypes: schemaOrgBlocks.map(b => b.type),
      },
      sessionId,
    )

    // ── Phase 2+3: snapshot + enhancedSnapshot ────────────────────────────
    let enhancedSnapshotText = ''
    try { await browser.snapshot(pageId) } catch {}
    try { enhancedSnapshotText = (await browser.enhancedSnapshot(pageId)) ?? '' } catch {}

    const landmarkRoles = ['navigation', 'banner', 'main', 'contentinfo', 'complementary', 'search']
    for (const role of landmarkRoles) {
      if (enhancedSnapshotText.toLowerCase().includes(role)) {
        try {
          const { nodeId: nrNodeId } = await addNode(role, 'nav_region', {
            parentPageId: mainNodeId, role, discoveredAt: nowISO(),
          }, sessionId)
          await addEdge(mainNodeId, nrNodeId, 'contains', { role }, sessionId)
        } catch {}
      }
    }

    if (hasDialogs) {
      try {
        const { nodeId: popupNodeId } = await addNode('dialog', 'popup', {
          parentPageId: mainNodeId, role: 'dialog', discoveredAt: nowISO(),
        }, sessionId)
        await addEdge(mainNodeId, popupNodeId, 'contains', { count: dialogCount }, sessionId)
      } catch {}
    }

    // ── Phase 4: getDom('form') ──────────────────────────────────────────────────
    try {
      const formDomResult = await browser.getDom(pageId, { selector: 'form' })
      if (formDomResult) {
        const formsResult = await browser.evaluate(pageId, `(() => {
          return Array.from(document.querySelectorAll('form')).map((f, i) => {
            const fields = Array.from(f.elements)
              .filter(el => ['INPUT','SELECT','TEXTAREA'].includes(el.tagName))
              .map(el => ({
                tag: el.tagName.toLowerCase(),
                inputType: (el.type || el.tagName.toLowerCase()),
                name: el.name || '',
                id: el.id || '',
                placeholder: el.placeholder || '',
                required: el.required || false,
                autocomplete: el.autocomplete || '',
                label: (() => {
                  if (el.id) {
                    const l = document.querySelector('label[for="' + el.id + '"]')
                    if (l) return l.textContent?.trim() ?? ''
                  }
                  return el.getAttribute('aria-label') ?? ''
                })(),
                options: el.tagName === 'SELECT'
                  ? Array.from(el.options).map(o => o.text).slice(0, 20)
                  : [],
              }))
            const submitBtn = f.querySelector('[type="submit"],button[type="submit"],button:not([type])')
            return {
              action: f.action || '',
              method: f.method || 'get',
              fields,
              submitLabel: submitBtn?.textContent?.trim() ?? '',
            }
          })
        })()`)

        if (Array.isArray(formsResult.value)) {
          const forms = formsResult.value as Array<{
            action: string; method: string; submitLabel: string
            fields: Array<{
              tag: string; inputType: string; name: string; id: string
              placeholder: string; required: boolean; autocomplete: string
              label: string; options: string[]
            }>
          }>

          for (let fi = 0; fi < forms.length; fi++) {
            const form = forms[fi]
            const purpose = inferFormPurpose(form.action, form.fields)
            const { nodeId: formNodeId } = await addNode(purpose, 'form', {
              parentPageId: mainNodeId,
              action: form.action,
              method: form.method.toUpperCase(),
              purpose,
              submitLabel: form.submitLabel,
              fieldCount: form.fields.length,
              discoveredAt: nowISO(),
            }, sessionId)
            await addEdge(mainNodeId, formNodeId, 'contains', { formIndex: fi }, sessionId)

            if (form.action && (form.action.startsWith('http') || form.action.startsWith('/'))) {
              const { nodeId: acNodeId } = await addNode(
                apiCallLabel(form.method.toUpperCase(), form.action),
                'api_call',
                {
                  parentPageId: mainNodeId,
                  method: form.method.toUpperCase(),
                  endpoint: form.action,
                  inferredPurpose: purpose,
                  triggerSource: 'formSubmit',
                  payloadKeys: form.fields.map((f: { name: string }) => f.name).filter(Boolean),
                  discoveredAt: nowISO(),
                },
                sessionId,
              )
              await addEdge(formNodeId, acNodeId, 'submits_to', {}, sessionId)
            }

            for (let fli = 0; fli < form.fields.length; fli++) {
              const field = form.fields[fli]
              if (field.inputType === 'hidden' || field.inputType === 'submit') continue
              const { nodeId: fieldNodeId } = await addNode(
                field.label || field.name || field.placeholder || field.inputType,
                'field',
                {
                  parentFormId: formNodeId,
                  parentPageId: mainNodeId,
                  inputType: field.inputType,
                  name: field.name || undefined,
                  label: field.label || undefined,
                  placeholder: field.placeholder || undefined,
                  required: field.required,
                  autocomplete: field.autocomplete || undefined,
                  options: field.options.length > 0 ? field.options : undefined,
                  discoveredAt: nowISO(),
                },
                sessionId,
              )
              await addEdge(formNodeId, fieldNodeId, 'contains', { fieldIndex: fli }, sessionId)
            }
          }
        }
      }
    } catch { /* Phase 4 failed */ }

    // ── JS bundle node ─────────────────────────────────────────────────────
    if (framework || hasNextData || Object.keys(featureFlags).length > 0) {
      try {
        const { nodeId: jsBundleNodeId } = await addNode(framework || 'JS Bundle', 'js_bundle', {
          parentPageId: mainNodeId,
          framework: framework || undefined,
          hasNextData,
          featureFlags: Object.keys(featureFlags).length > 0 ? featureFlags : undefined,
          discoveredAt: nowISO(),
        }, sessionId)
        await addEdge(mainNodeId, jsBundleNodeId, 'contains', {}, sessionId)
      } catch {}
    }

    // ── localStorage / sessionStorage nodes ───────────────────────────────
    const allStorageKeys = [
      ...localStorageKeys.map(k => ({ k, type: 'localStorage' as const })),
      ...sessionStorageKeys.map(k => ({ k, type: 'sessionStorage' as const })),
    ]
    for (const { k, type } of allStorageKeys.slice(0, LOCAL_STORAGE_NODE_CAP)) {
      try {
        const { nodeId: lsNodeId } = await addNode(k, 'local_storage', {
          parentPageId: mainNodeId, storageType: type, key: k, discoveredAt: nowISO(),
        }, sessionId)
        await addEdge(mainNodeId, lsNodeId, 'contains', { storageType: type }, sessionId)
      } catch {}
    }

    // ── schema.org JSON-LD nodes ──────────────────────────────────────────
    for (const block of schemaOrgBlocks) {
      try {
        const { nodeId: soNodeId } = await addNode(block.type, 'schema_org', {
          parentPageId: mainNodeId, schemaType: block.type, summary: block.summary, discoveredAt: nowISO(),
        }, sessionId)
        await addEdge(mainNodeId, soNodeId, 'contains', {}, sessionId)
      } catch {}
    }

    // ── API calls from Performance API ────────────────────────────────────
    for (const endpoint of apiCallsObserved.slice(0, 10)) {
      try {
        const { nodeId: acNodeId } = await addNode(apiCallLabel('GET', endpoint), 'api_call', {
          parentPageId: mainNodeId,
          method: 'GET',
          endpoint,
          inferredPurpose: 'page load request',
          discoveredAt: nowISO(),
        }, sessionId)
        await addEdge(mainNodeId, acNodeId, 'triggers', { phase: 'page-load' }, sessionId)
      } catch {}
    }

    // ── Phase 7: getPageLinks ──────────────────────────────────────────────────
    // In exhaustive mode we don't restrict by depth — every link found is queued.
    // In normal mode we honour maxDepth.
    const shouldFollowLinks = state.exhaustive || depth < state.maxDepth
    if (shouldFollowLinks) {
      const links = await browser.getPageLinks(pageId)
      const sameSiteLinks = links
        .map(l => l.href)
        .filter(h => { try { return new URL(h).origin === origin } catch { return false } })
        .filter((h, i, arr) => arr.indexOf(h) === i)

      for (const link of sameSiteLinks) {
        const { nodeId: linkedNodeId } = await addNode(
          link, 'page', { url: link, depth: depth + 1, status: 'queued' }, sessionId,
        )
        await addEdge(mainNodeId, linkedNodeId, 'navigates_to', { fromDepth: depth }, sessionId)

        if (!state.visited.has(link) && !state.queued.has(link)) {
          state.queued.add(link)
          state.queue.push(link)
          state.depthMap.set(link, depth + 1)
        }
      }
    }

    // BUG 5 FIX: Throttle saveAllFormats(flush=false) to every SAVE_INTERVAL pages.
    if (state.pagesVisited % SAVE_INTERVAL === 0) {
      await saveAllFormats(sessionId, mermaidDir, false)
    }

  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err)
    await addNode(url, 'page', { url, depth, error: state.lastError, statusCode: 0 }, sessionId).catch(() => {})
    await saveAllFormats(sessionId, mermaidDir, false).catch(() => {})
  } finally {
    if (pageId !== undefined) {
      try { await browser.closePage(pageId) } catch {}
    }
  }

  return 'ok'
}

// ─── Main BFS loop ─────────────────────────────────────────────────────────────────────

async function runBfsLoop(
  state: BfsState,
  browser: Parameters<typeof processBfsPage>[2],
  origin: string,
  response: { progress?: (msg: string) => void },
): Promise<void> {
  while (
    state.queue.length > 0 &&
    state.pagesVisited < state.maxPages &&
    state.pagesVisited < state.hardAbortAfter &&
    state.status === 'running'
  ) {
    const url = state.queue.shift()!
    if (state.visited.has(url)) continue
    state.visited.add(url)
    state.pagesVisited++

    if (state.exhaustive && state.pagesVisited % EXHAUSTIVE_PROGRESS_INTERVAL === 0) {
      safeProgress(
        response,
        `[map_site] exhaustive crawl: ${state.pagesVisited} pages visited, ${state.queue.length} queued — session ${state.sessionId}`,
      )
    }

    const result = await processBfsPage(url, state, browser, origin)

    if (result === 'auth-wall') {
      if (state.authMode === 'credentials' && state.auth.credentials) {
        const loginResult = await attemptAutoLogin(browser as Parameters<typeof attemptAutoLogin>[0], state.auth.credentials)
        if (loginResult.success) {
          state.auth.authenticated = true
          state.auth.method = 'auto'
          // BUG C FIX: reset authWallsSeen after successful auth so per-domain
          // auth walls that appear later in the crawl are not silently ignored.
          state.auth.authWallsSeen = 0
          if (loginResult.pageId >= 0) {
            try { await browser.closePage(loginResult.pageId) } catch {}
          }
          if (!state.visited.has(url)) {
            state.queued.add(url)
            state.queue.unshift(url)
          }
        } else {
          state.status = 'paused'
          state.pauseReason =
            `Auto-login failed: ${loginResult.error ?? 'unknown error'}. ` +
            `Please log in manually and call map_site_resume.`
          return
        }
      } else {
        state.status = 'paused'
        state.pauseReason =
          `Auth wall detected at: ${url}\n` +
          `Please log in manually in the browser tab, then call map_site_resume to continue.`
        return
      }
    }
  }
}

// ─── map_site_start ─────────────────────────────────────────────────────────────────────

export const map_site_start = defineTool({
  name: 'map_site_start',
  // BUG 6 FIX: Use .join('\n') not .join(' ').
  // .join(' ') collapsed the array into one ~900-char line with embedded
  // double-quote chars (authMode=none/ask/credentials). At high context
  // utilisation the tokenizer split the string mid-quote, producing an
  // unterminated JSON string in the tool schema envelope, which caused the
  // runtime to emit 'malformed tool call data that could not be repaired'
  // before any handler ran. Also removed all embedded double-quote chars
  // from description lines and field .describe() strings — they are a
  // second tokenizer hazard inside JSON string values.
  //
  // BUG A FIX: map_site_start now guards against overwriting a live paused
  // or running bfsState. Context compaction was truncating the earlier tool
  // result that contained status=paused, so the model had no evidence a
  // crawl was in progress and called map_site_start again. The unconditional
  // bfsState = {...} assignment then destroyed the paused session. Now the
  // handler returns an explicit error with the session ID and instructs the
  // model to call map_site_resume. A force=true param allows abandoning a
  // genuinely stuck session when needed.
  description: [
    'BFS-crawl a website and build a semantic knowledge graph.',
    '',
    'IMPORTANT: If a crawl is already paused, call map_site_resume instead.',
    'Calling map_site_start while a crawl is paused will be rejected unless',
    'force=true is passed to explicitly abandon the existing session.',
    '',
    'CRAWL MODES:',
    '  Normal (default): respects maxPages cap (default 50).',
    '  Exhaustive (exhaustive=true): crawls until queue empty — all reachable',
    '  same-origin URLs visited. Safety: hardAbortAfter (default 2000).',
    '',
    'AUTH MODES:',
    "  authMode=none (default): records login pages, no authentication.",
    "  authMode=ask: pauses when login wall detected, asks user to log in,",
    '  then call map_site_resume to continue with authenticated session.',
    "  authMode=credentials: supply loginUrl + email + password.",
    '  Crawler auto-fills the form and resumes. Falls back to ask on failure.',
    '',
    'EXTRACTION PHASES (per page, ctx.browser.* only):',
    '  1: evaluate — title, h1, desc, pageRole, JSON-LD, localStorage, framework',
    '  2: snapshot — interactive elements',
    '  3: enhancedSnapshot — ARIA landmarks, dialogs, shadow DOM',
    '  4: getDom(form) — full form/field extraction',
    '  5: searchDom — dialogs, password fields',
    '  6: evaluate — Performance API call detection',
    '  7: getPageLinks — BFS link discovery',
    '',
    'REQUIRED: url.',
    'OPTIONAL: maxDepth (1-10, default 2), maxPages (default 50),',
    '  exhaustive (bool), hardAbortAfter (default 2000),',
    '  authMode (none|ask|credentials),',
    '  loginUrl, loginEmail, loginPassword (required when authMode=credentials),',
    '  force (bool, default false — set true to abandon a stuck paused session),',
    '  session_id, mermaid_direction (LR|TD).',
  ].join('\n'),
  approvalCategory: 'observation',
  input: z.object({
    url: z.string().describe('Root URL to start crawling from'),
    maxDepth: z.coerce.number().int().min(1).max(10).default(2)
      .describe('Max BFS depth (default 2). Ignored in exhaustive mode.'),
    maxPages: z.coerce.number().int().min(1).max(100000).default(50)
      .describe('Max pages to crawl (default 50). Ignored when exhaustive=true.'),
    exhaustive: z.boolean().default(false)
      .describe('Crawl until BFS queue empty (full site coverage). Overrides maxPages/maxDepth.'),
    hardAbortAfter: z.coerce.number().int().min(1).default(EXHAUSTIVE_DEFAULT_HARD_ABORT)
      .describe('Hard page limit in exhaustive mode (default 2000).'),
    authMode: z.enum(['none', 'ask', 'credentials']).default('none')
      .describe('none: no auth. ask: pause for manual login. credentials: auto-fill form.'),
    loginUrl: z.string().optional()
      .describe('Login page URL. Required when authMode=credentials.'),
    loginEmail: z.string().optional()
      .describe('Email or username. Required when authMode=credentials.'),
    loginPassword: z.string().optional()
      .describe('Password. Required when authMode=credentials.'),
    // BUG A FIX: force param — allows explicitly abandoning a paused session.
    force: z.boolean().default(false)
      .describe('Set true to abandon an existing paused or stuck session and start fresh.'),
    session_id: z.string().optional()
      .describe('Graph session ID. Auto-generated from URL if omitted.'),
    mermaid_direction: z.enum(['LR', 'TD']).default('LR')
      .describe('Mermaid diagram direction: LR or TD.'),
  }),

  async handler(args, ctx, response) {
    // ── BUG A FIX: Guard against overwriting a live paused/running session ──
    // Context compaction truncates earlier tool results, making the model
    // unaware a crawl is paused. Without this guard, calling map_site_start
    // again unconditionally destroyed the paused BFS state.
    if (bfsState && (bfsState.status === 'paused' || bfsState.status === 'running') && !args.force) {
      response.text(JSON.stringify({
        error: 'A crawl session is already active.',
        status: bfsState.status,
        sessionId: bfsState.sessionId,
        pagesVisited: bfsState.pagesVisited,
        queuedRemaining: bfsState.queue.length,
        pauseReason: bfsState.pauseReason ?? undefined,
        action: bfsState.status === 'paused'
          ? 'Call map_site_resume to continue this crawl, or pass force=true to abandon it and start fresh.'
          : 'Call map_site_bfs_status to check progress, or pass force=true to abandon and start fresh.',
      }, null, 2))
      return
    }

    const origin = (() => { try { return new URL(args.url).origin } catch { return args.url } })()
    const sessionId = args.session_id ?? urlToSessionId(args.url)
    const session = await getOrCreateSession(sessionId)
    const mermaidDir = (args.mermaid_direction ?? 'LR') as 'LR' | 'TD'

    if (args.authMode === 'credentials') {
      if (!args.loginUrl || !args.loginEmail || !args.loginPassword) {
        response.text(JSON.stringify({
          error: 'authMode=credentials requires loginUrl, loginEmail, and loginPassword.',
        }))
        return
      }
    }

    bfsState = {
      sessionId,
      rootUrl: args.url,
      visited: new Set(),
      queued: new Set([args.url]),
      queue: [args.url],
      maxDepth: args.exhaustive ? MAX_PAGES_SENTINEL : args.maxDepth,
      maxPages: args.exhaustive ? MAX_PAGES_SENTINEL : args.maxPages,
      hardAbortAfter: args.hardAbortAfter,
      depthMap: new Map([[args.url, 0]]),
      status: 'running',
      pauseReason: null,
      startedAt: Date.now(),
      homePath: session.homePath,
      cwdPath: session.cwdPath,
      homeJsonPath: session.homePath.replace(/\.ndjson$/, '.json'),
      cwdJsonPath: session.cwdPath.replace(/\.ndjson$/, '.json'),
      homeMMDPath: session.homePath.replace(/\.ndjson$/, '.mmd'),
      cwdMMDPath: session.cwdPath.replace(/\.ndjson$/, '.mmd'),
      pagesVisited: 0,
      lastError: null,
      exhaustive: args.exhaustive,
      authMode: args.authMode,
      auth: {
        authenticated: false,
        loginUrl: null,
        method: 'none',
        loginPageId: null,
        credentials: args.authMode === 'credentials'
          ? { loginUrl: args.loginUrl!, email: args.loginEmail!, password: args.loginPassword! }
          : null,
        authWallsSeen: 0,
      },
      mermaidDir,
    }

    await addNode('Root', 'page', { url: args.url, depth: 0 }, sessionId)

    await runBfsLoop(
      bfsState,
      ctx.browser as Parameters<typeof processBfsPage>[2],
      origin,
      response as { progress?: (msg: string) => void },
    )

    if (bfsState.status === 'paused') {
      response.text(JSON.stringify({
        status: 'paused',
        sessionId,
        pagesVisited: bfsState.pagesVisited,
        queuedRemaining: bfsState.queue.length,
        pauseReason: bfsState.pauseReason,
        instructions: [
          bfsState.pauseReason,
          '',
          'Once authenticated, call map_site_resume to continue the crawl from where it paused.',
          'Or call map_site_provide_credentials with email+password to let the agent auto-login.',
        ].join('\n'),
        files: {
          ndjson: { home: bfsState.homePath, cwd: bfsState.cwdPath },
        },
      }, null, 2))
      return
    }

    bfsState.status = 'done'
    const [saveResult, summary] = await Promise.all([
      saveAllFormats(sessionId, mermaidDir, true),
      getSessionSummary(sessionId),
    ])

    bfsState.homeMMDPath = saveResult.homeMMDPath
    bfsState.cwdMMDPath = saveResult.cwdMMDPath

    const hardAborted = bfsState.pagesVisited >= bfsState.hardAbortAfter

    response.text(JSON.stringify({
      status: hardAborted ? 'done_hard_aborted' : 'done',
      sessionId,
      exhaustive: args.exhaustive,
      pagesVisited: bfsState.pagesVisited,
      authStatus: {
        mode: args.authMode,
        authenticated: bfsState.auth.authenticated,
        loginUrl: bfsState.auth.loginUrl,
      },
      graph: {
        nodes: summary.nodeCount,
        edges: summary.edgeCount,
        nodeTypes: summary.nodeTypes,
      },
      files: {
        ndjson: { home: saveResult.homeNdjsonPath, cwd: saveResult.cwdNdjsonPath },
        json: { home: saveResult.homeJsonPath, cwd: saveResult.cwdJsonPath },
        mermaid: { home: saveResult.homeMMDPath, cwd: saveResult.cwdMMDPath },
      },
      note: [
        hardAborted ? `WARNING: Hard abort limit (${bfsState.hardAbortAfter} pages) reached. Site may have more pages.` : '',
        'Use graph_load to re-open. Use graph_query to inspect. Paste .mmd at https://mermaid.live.',
      ].filter(Boolean).join(' '),
    }, null, 2))
  },
})

// ─── map_site_resume ───────────────────────────────────────────────────────────────────

export const map_site_resume = defineTool({
  name: 'map_site_resume',
  description: [
    'Resume a paused map_site_start crawl after manual authentication.',
    'Call this after logging into the site in the browser tab.',
    'The crawl continues from where it paused with the authenticated session.',
    'Only valid when crawl status is paused.',
    'Takes no arguments.',
  ].join('\n'),
  approvalCategory: 'observation',
  // BUG B FIX: Use z.object({}) instead of z.object({ _noop: z.string().optional() }).
  // Some AI SDK runtime versions treat any schema that has a field — even an
  // optional one — as requiring at least one argument to be present in the
  // tool call JSON. When the model calls map_site_resume with zero args (the
  // correct usage) the runtime rejects the call at schema validation before
  // the handler runs, emitting the malformed tool call data error.
  // z.object({}) accepts an empty call unconditionally.
  input: z.object({}),
  async handler(_args, ctx, response) {
    if (!bfsState) {
      response.text(JSON.stringify({ error: 'No crawl in progress. Call map_site_start first.' }))
      return
    }
    if (bfsState.status !== 'paused') {
      response.text(JSON.stringify({ error: `Crawl is not paused (status: ${bfsState.status}).` }))
      return
    }

    bfsState.auth.authenticated = true
    bfsState.auth.method = 'manual'
    bfsState.status = 'running'
    bfsState.pauseReason = null
    // BUG C FIX: Reset authWallsSeen after successful manual auth so that
    // subsequent per-domain auth walls (e.g. console.twilio.com vs twilio.com)
    // are not silently ignored because the counter hit the 3-wall cap.
    bfsState.auth.authWallsSeen = 0

    const origin = (() => { try { return new URL(bfsState.rootUrl).origin } catch { return bfsState.rootUrl } })()

    await runBfsLoop(
      bfsState,
      ctx.browser as Parameters<typeof processBfsPage>[2],
      origin,
      response as { progress?: (msg: string) => void },
    )

    if (bfsState.status === 'paused') {
      response.text(JSON.stringify({
        status: 'paused',
        sessionId: bfsState.sessionId,
        pagesVisited: bfsState.pagesVisited,
        pauseReason: bfsState.pauseReason,
        instructions: 'Another auth wall was hit. Log in again and call map_site_resume.',
      }, null, 2))
      return
    }

    bfsState.status = 'done'
    const [saveResult, summary] = await Promise.all([
      saveAllFormats(bfsState.sessionId, bfsState.mermaidDir, true),
      getSessionSummary(bfsState.sessionId),
    ])

    response.text(JSON.stringify({
      status: 'done',
      sessionId: bfsState.sessionId,
      pagesVisited: bfsState.pagesVisited,
      authStatus: { authenticated: true, method: 'manual' },
      graph: { nodes: summary.nodeCount, edges: summary.edgeCount, nodeTypes: summary.nodeTypes },
      files: {
        ndjson: { home: saveResult.homeNdjsonPath, cwd: saveResult.cwdNdjsonPath },
        json: { home: saveResult.homeJsonPath, cwd: saveResult.cwdJsonPath },
        mermaid: { home: saveResult.homeMMDPath, cwd: saveResult.cwdMMDPath },
      },
    }, null, 2))
  },
})

// ─── map_site_provide_credentials ────────────────────────────────────────────────────

export const map_site_provide_credentials = defineTool({
  name: 'map_site_provide_credentials',
  description: [
    'Supply login credentials to a paused crawl so the agent can auto-fill',
    'the login form and resume without manual browser interaction.',
    'Call when crawl is paused and user provides email+password.',
    'Agent auto-fills and submits the form, then resumes BFS.',
  ].join('\n'),
  approvalCategory: 'observation',
  input: z.object({
    email: z.string().describe('Email address or username for the login form'),
    password: z.string().describe('Password for the login form'),
    loginUrl: z.string().optional()
      .describe('Login page URL override. Defaults to the URL where the auth wall was detected.'),
  }),
  async handler(args, ctx, response) {
    if (!bfsState) {
      response.text(JSON.stringify({ error: 'No crawl in progress. Call map_site_start first.' }))
      return
    }
    if (bfsState.status !== 'paused') {
      response.text(JSON.stringify({ error: `Crawl is not paused (status: ${bfsState.status}).` }))
      return
    }

    const loginUrl = args.loginUrl ?? bfsState.auth.loginUrl ?? bfsState.rootUrl
    const credentials = { loginUrl, email: args.email, password: args.password }

    const loginResult = await attemptAutoLogin(
      ctx.browser as Parameters<typeof attemptAutoLogin>[0],
      credentials,
    )

    if (!loginResult.success) {
      response.text(JSON.stringify({
        status: 'login_failed',
        error: loginResult.error ?? 'Login form submission did not navigate away from login page.',
        suggestion: 'Try map_site_resume for manual login instead, or double-check your credentials.',
      }, null, 2))
      if (loginResult.pageId >= 0) {
        try { await ctx.browser.closePage(loginResult.pageId) } catch {}
      }
      return
    }

    if (loginResult.pageId >= 0) {
      try { await ctx.browser.closePage(loginResult.pageId) } catch {}
    }

    bfsState.auth.authenticated = true
    bfsState.auth.method = 'auto'
    bfsState.auth.credentials = credentials
    bfsState.status = 'running'
    bfsState.pauseReason = null
    // BUG C FIX: Reset authWallsSeen after successful credential-based auth
    // for the same reason as in map_site_resume.
    bfsState.auth.authWallsSeen = 0

    const origin = (() => { try { return new URL(bfsState.rootUrl).origin } catch { return bfsState.rootUrl } })()

    await runBfsLoop(
      bfsState,
      ctx.browser as Parameters<typeof processBfsPage>[2],
      origin,
      response as { progress?: (msg: string) => void },
    )

    if (bfsState.status === 'paused') {
      response.text(JSON.stringify({
        status: 'paused',
        pagesVisited: bfsState.pagesVisited,
        pauseReason: bfsState.pauseReason,
        instructions: 'Another auth wall encountered. Call map_site_resume or map_site_provide_credentials again.',
      }, null, 2))
      return
    }

    bfsState.status = 'done'
    const [saveResult, summary] = await Promise.all([
      saveAllFormats(bfsState.sessionId, bfsState.mermaidDir, true),
      getSessionSummary(bfsState.sessionId),
    ])

    response.text(JSON.stringify({
      status: 'done',
      sessionId: bfsState.sessionId,
      pagesVisited: bfsState.pagesVisited,
      authStatus: { authenticated: true, method: 'auto', loginUrl },
      graph: { nodes: summary.nodeCount, edges: summary.edgeCount, nodeTypes: summary.nodeTypes },
      files: {
        ndjson: { home: saveResult.homeNdjsonPath, cwd: saveResult.cwdNdjsonPath },
        json: { home: saveResult.homeJsonPath, cwd: saveResult.cwdJsonPath },
        mermaid: { home: saveResult.homeMMDPath, cwd: saveResult.cwdMMDPath },
      },
    }, null, 2))
  },
})

// ─── map_site_bfs_status ─────────────────────────────────────────────────────────────────

export const map_site_bfs_status = defineTool({
  name: 'map_site_bfs_status',
  description: 'Get status, auth state, and file paths of an in-progress or completed map_site_start crawl.',
  approvalCategory: 'observation',
  // BUG B FIX: z.object({}) — same rationale as map_site_resume above.
  input: z.object({}),
  async handler(_args, _ctx, response) {
    if (!bfsState) {
      response.text(JSON.stringify({ status: 'idle', message: 'No crawl started yet. Call map_site_start first.' }))
      return
    }

    let summary = null
    try { summary = await getSessionSummary(bfsState.sessionId) } catch {}

    response.text(JSON.stringify({
      status: bfsState.status,
      exhaustive: bfsState.exhaustive,
      sessionId: bfsState.sessionId,
      rootUrl: bfsState.rootUrl,
      pagesVisited: bfsState.pagesVisited,
      queued: bfsState.queue.length,
      elapsedMs: Date.now() - bfsState.startedAt,
      lastError: bfsState.lastError,
      pauseReason: bfsState.pauseReason,
      authStatus: {
        mode: bfsState.authMode,
        authenticated: bfsState.auth.authenticated,
        loginUrl: bfsState.auth.loginUrl,
        method: bfsState.auth.method,
        authWallsSeen: bfsState.auth.authWallsSeen,
      },
      files: {
        ndjson: { home: bfsState.homePath, cwd: bfsState.cwdPath },
        json: { home: bfsState.homeJsonPath, cwd: bfsState.cwdJsonPath },
        mermaid: { home: bfsState.homeMMDPath, cwd: bfsState.cwdMMDPath },
      },
      graph: summary
        ? { nodes: summary.nodeCount, edges: summary.edgeCount, nodeTypes: summary.nodeTypes }
        : null,
    }, null, 2))
  },
})

// ─── map_site_enqueue ────────────────────────────────────────────────────────────────────

export const map_site_enqueue = defineTool({
  name: 'map_site_enqueue',
  description: 'Manually enqueue a URL into the active BFS crawl queue.',
  approvalCategory: 'observation',
  input: z.object({
    url: z.string().describe('URL to add to the crawl queue'),
    depth: z.coerce.number().int().min(0).optional()
      .describe('Depth to assign. Defaults to maxDepth-1.'),
  }),
  async handler(args, _ctx, response) {
    if (!bfsState || bfsState.status === 'done') {
      response.text(JSON.stringify({ error: 'No active crawl. Run map_site_start first.' }))
      return
    }
    const assignedDepth = args.depth ?? Math.max(0, bfsState.maxDepth < MAX_PAGES_SENTINEL ? bfsState.maxDepth - 1 : 0)
    if (!bfsState.visited.has(args.url) && !bfsState.queued.has(args.url)) {
      bfsState.queued.add(args.url)
      bfsState.queue.push(args.url)
      bfsState.depthMap.set(args.url, assignedDepth)
      response.text(JSON.stringify({ queued: true, url: args.url, depth: assignedDepth, sessionId: bfsState.sessionId }))
    } else {
      response.text(JSON.stringify({ queued: false, reason: 'Already visited or queued.', url: args.url }))
    }
  },
})

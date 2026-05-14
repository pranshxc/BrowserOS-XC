/**
 * uro-filter.ts
 *
 * Full TypeScript port of s0md3v/uro (https://github.com/s0md3v/uro)
 * URL deduplication logic for high-volume web crawling.
 *
 * Purpose: Skip redundant URLs during depth crawl to avoid hammering
 * static/pagination pages like /blog/1, /blog/2, /blog/xxxse2 etc.
 * while ensuring every UNIQUE feature/form/endpoint is still captured.
 *
 * Security-first design:
 * - URLs containing known-injectable params (VULN_PARAMS) are ALWAYS kept
 *   regardless of any dedup rule — we never discard a potential attack surface.
 * - Vuln-param URLs are flagged in output so the LLM can prioritise them.
 *
 * Dedup rules applied (in order):
 *  1. Security override — vuln-param URLs always pass (checked before everything)
 *  2. Static asset extension blacklist (css, png, jpg, woff2, mp4 …)
 *  3. Locale normalisation — /en-us/X, /en-gb/X, /ja-jp/X → canonical /X for dedup
 *  4. Content/blog pagination filter — skips /blog/1, slugs-with-many-hyphens
 *  5. Integer-segment pattern dedup — first /user/42 kept, /user/99 skipped
 *  6. Query-param dedup — same path+same param keys = skip; new param key = keep
 *
 * Exported helpers:
 *  - UroFilter class  — instantiate once per crawl session
 *  - getSessionUroFilter(ctx) — lazy-init helper for shared session instance
 *  - VULN_PARAMS set  — injectable param names from s0md3v/uro
 */

// ─── Static asset extension blacklist ────────────────────────────────────────
const DEFAULT_BLACKLIST_EXTS = new Set([
  'css', 'png', 'jpg', 'jpeg', 'svg', 'ico', 'webp', 'scss',
  'tif', 'tiff', 'ttf', 'otf', 'woff', 'woff2', 'gif',
  'pdf', 'bmp', 'eot', 'mp3', 'mp4', 'avi',
])

// ─── Vulnerability-relevant query parameter names ────────────────────────────
// Source: s0md3v/uro vuln_params set — covers LFI, RCE, SSRF, SQLi, IDOR, Open Redirect
export const VULN_PARAMS = new Set([
  'file','document','folder','root','path','pg','style','pdf','template',
  'php_path','doc','page','name','cat','dir','action','board','date','detail',
  'download','prefix','include','inc','locate','show','site','type','view',
  'content','layout','mod','conf','daemon','upload','log','ip','cli','cmd',
  'exec','command','execute','ping','query','jump','code','reg','do','func',
  'arg','option','load','process','step','read','function','req','feature',
  'exe','module','payload','run','print','callback','checkout','checkout_url',
  'continue','data','dest','destination','domain','feed','file_name','file_url',
  'folder_url','forward','from_url','go','goto','host','html','image_url',
  'img_url','load_file','load_url','login_url','logout','navigation','next',
  'next_page','Open','out','page_url','port','redir','redirect','redirect_to',
  'redirect_uri','redirect_url','reference','return','return_path','return_to',
  'returnTo','return_url','rt','rurl','target','to','uri','url','val','validate',
  'window','q','s','search','lang','keyword','keywords','year','email','p',
  'jsonp','api_key','api','password','emailto','token','username','csrf_token',
  'unsubscribe_token','id','item','page_id','month','immagine','list_type',
  'terms','categoryid','key','l','begindate','enddate','select','report','role',
  'update','user','sort','where','params','row','table','from','sel','results',
  'sleep','fetch','order','column','field','delete','string','number','filter',
  'access','admin','dbg','debug','edit','grant','test','alter','clone','create',
  'disable','enable','make','modify','rename','reset','shell','toggle','adm',
  'cfg','open','img','filename','preview','activity',
])

// ─── Locale segment regex ─────────────────────────────────────────────────────
// Matches IETF BCP 47 style: /en-us/, /en-gb/, /ja-jp/, /pt-br/, /zh-cn/ etc.
// Also matches ISO 639-1 single-segment: /en/, /fr/, /de/, /es/ etc.
// Must be at the START of the pathname.
const RE_LOCALE_PREFIX = /^\/([a-z]{2}(-[a-z]{2})?)(\/?$|\/)/i

// ─── Content patterns (blog/pagination paths to skip) ────────────────────────
// Matches: /blog/, /posts/, /docs/, /support/, /2024/01/, /pages/3/ etc.
const RE_CONTENT = /(post|blog)s?|docs|support\/|\/(\d{4}|pages?\/\d+\/)/i

// Matches any path segment that is purely numeric: /user/42, /item/7/details
const RE_INT_SEGMENT = /\/\d+([?/]|$)/

// ─── Per-host URL state ───────────────────────────────────────────────────────
interface UrlState {
  /** path → array of param-key Sets seen for that path */
  paths: Map<string, Array<Set<string>>>
  /** compiled regex patterns for integer-segment dedup */
  patterns: Array<RegExp>
  /** path prefixes already identified as content/blog areas */
  contentPrefixes: Array<string>
}

// ─── UroFilter class ─────────────────────────────────────────────────────────

/**
 * UroFilter — stateful, session-scoped URL deduplication filter.
 *
 * Instantiate ONCE per crawl session so dedup state accumulates correctly
 * across all pages visited. Store on ctx.session.uroFilter.
 *
 * Usage:
 *   const filter = new UroFilter()
 *   if (filter.shouldCrawl(url)) { enqueueForCrawl(url) }
 */
export class UroFilter {
  private hostMap: Map<string, UrlState> = new Map()

  /**
   * Main entry point.
   * Returns true  → URL is novel, should be crawled.
   * Returns false → URL is redundant, skip it.
   *
   * Pipeline (in strict order):
   *  0. Malformed URL → false immediately
   *  1. Vuln-param security override → always true (before all other filters)
   *  2. Static asset blacklist → false
   *  3. Locale normalisation for dedup state (original URL still crawled)
   *  4. Content/blog pagination filter → false
   *  5. Integer-segment + param-key dedup
   */
  shouldCrawl(rawUrl: string, keepTrailingSlash = false): boolean {
    const cleanUrl = keepTrailingSlash
      ? rawUrl.trim()
      : rawUrl.trim().replace(/\/$/, '')

    let parsed: URL
    try {
      parsed = new URL(cleanUrl)
    } catch {
      return false // malformed / relative URL — skip
    }

    const path = parsed.pathname
    const params = this._parseParams(parsed.search)

    // ── 1. Security override: always crawl vuln-param URLs ───────────────────
    // This runs BEFORE locale normalization and ALL other filters.
    // We must never silently drop a potential attack surface.
    if ([...params.keys()].some(k => VULN_PARAMS.has(k))) return true

    // ── 2. Static asset extension blacklist ──────────────────────────────────
    if (this._isBlacklisted(path)) return false

    // ── 3. Locale normalisation ───────────────────────────────────────────────
    // Compute a canonical URL for dedup purposes. The real URL is still what
    // gets crawled — normalisation only affects the dedup state key so that
    // /en-us/pricing and /en-gb/pricing are treated as the same page.
    const normalizedOrigin = parsed.origin
    const normalizedPath = this._stripLocale(path)

    // ── 4. Content/blog pagination filter ────────────────────────────────────
    if (!this._passesContentFilter(normalizedOrigin, normalizedPath)) return false

    // ── 5 & 6. Path + param-key deduplication (on normalised path) ───────────
    return this._isNovelUrl(normalizedOrigin, normalizedPath, params)
  }

  // ─── Locale helpers ─────────────────────────────────────────────────────────

  /**
   * Strip the leading locale segment from a pathname.
   *
   * Examples:
   *   /en-us/pricing   → /pricing
   *   /ja-jp/docs/api  → /docs/api
   *   /en/about        → /about
   *   /pricing         → /pricing  (no locale prefix — unchanged)
   *   /en-us           → /         (locale-only path → root)
   */
  private _stripLocale(pathname: string): string {
    const m = RE_LOCALE_PREFIX.exec(pathname)
    if (!m) return pathname
    // m[0] is the full matched prefix, e.g. '/en-us/' or '/en/'
    const remainder = pathname.slice(m[0].length)
    return remainder ? '/' + remainder : '/'
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private _parseParams(search: string): Map<string, string> {
    const map = new Map<string, string>()
    if (!search || search === '?') return map
    const qs = search.startsWith('?') ? search.slice(1) : search
    for (const pair of qs.split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq === -1) {
        map.set(pair, '')
      } else {
        map.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
    }
    return map
  }

  private _isBlacklisted(path: string): boolean {
    const lastSegment = path.split('/').pop() ?? ''
    const dot = lastSegment.lastIndexOf('.')
    if (dot === -1) return false
    const ext = lastSegment.slice(dot + 1).toLowerCase()
    return DEFAULT_BLACKLIST_EXTS.has(ext)
  }

  private _getOrCreateHost(origin: string): UrlState {
    if (!this.hostMap.has(origin)) {
      this.hostMap.set(origin, {
        paths: new Map(),
        patterns: [],
        contentPrefixes: [],
      })
    }
    return this.hostMap.get(origin)!
  }

  /**
   * Content filter (mirrors URO remove_content filter).
   * Skips paths that look like blog posts or paginated content.
   * Learns content-area prefixes dynamically so subsequent checks are O(1).
   */
  private _passesContentFilter(origin: string, path: string): boolean {
    const state = this._getOrCreateHost(origin)

    // Check already-identified content prefixes (fast path)
    for (const prefix of state.contentPrefixes) {
      if (path.startsWith(prefix)) return false
    }

    // Slug heuristic: path segments with >3 hyphens are blog post slugs
    for (const segment of path.split('/')) {
      if ((segment.match(/-/g) ?? []).length > 3) return false
    }

    // Regex content pattern check
    const match = RE_CONTENT.exec(path)
    if (match) {
      // Remember prefix so future checks skip the regex entirely
      const prefix = path.slice(0, match.index + match[0].length)
      state.contentPrefixes.push(prefix)
      return false
    }

    return true
  }

  /**
   * Core dedup logic (mirrors URO process_url):
   *  - New path, no integers  → register & keep
   *  - New path, has integers → check if pattern already seen; skip if so
   *  - Known path             → keep only if params introduce a NEW param key
   */
  private _isNovelUrl(
    origin: string,
    path: string,
    params: Map<string, string>,
  ): boolean {
    const state = this._getOrCreateHost(origin)
    const isNewPath = !state.paths.has(path)

    if (isNewPath) {
      // Integer-segment dedup: /blog/1 and /blog/2 collapse to one pattern
      if (RE_INT_SEGMENT.test(path)) {
        const pattern = this._createIntPattern(path)
        if (state.patterns.some(p => p.source === pattern.source)) {
          return false
        }
        state.patterns.push(pattern)
      }

      // Register path with its initial param-key set
      const paramSet = params.size > 0 ? [new Set(params.keys())] : []
      state.paths.set(path, paramSet)
      return true
    }

    // Path already seen ─────────────────────────────────────────────────────
    if (params.size === 0) return false

    const seenParamSets = state.paths.get(path)!
    // Collect all param keys we have ever seen for this path
    const allSeenKeys = new Set<string>()
    for (const s of seenParamSets) s.forEach(k => allSeenKeys.add(k))

    const newKeys = [...params.keys()].filter(k => !allSeenKeys.has(k))
    if (newKeys.length === 0) return false

    // New param keys found — record them and keep this URL
    seenParamSets.push(new Set(newKeys))
    return true
  }

  /**
   * Builds a regex matching paths with integer segments up to and
   * including the last integer segment.
   * /blog/2024/post/42/comments → /blog\/\d+\/post\/\d+
   */
  private _createIntPattern(path: string): RegExp {
    const parts = path.split('/')
    const escaped: string[] = []
    let lastIntIdx = -1

    for (let i = 0; i < parts.length; i++) {
      if (/^\d+$/.test(parts[i])) {
        lastIntIdx = i
        escaped.push('\\d+')
      } else {
        escaped.push(parts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      }
    }

    return new RegExp(escaped.slice(0, lastIntIdx + 1).join('/'))
  }

  // ─── Serialization (for worker-to-worker state sharing) ──────────────────

  serialize(): string {
    const obj: Record<string, unknown> = {}
    for (const [origin, state] of this.hostMap.entries()) {
      obj[origin] = {
        paths: Object.fromEntries(
          [...state.paths.entries()].map(([p, sets]) => [
            p,
            sets.map(s => [...s]),
          ]),
        ),
        patterns: state.patterns.map(r => r.source),
        contentPrefixes: state.contentPrefixes,
      }
    }
    return JSON.stringify(obj)
  }

  static deserialize(data: string): UroFilter {
    const f = new UroFilter()
    const obj = JSON.parse(data) as Record<string, any>
    for (const [origin, raw] of Object.entries(obj)) {
      f.hostMap.set(origin, {
        paths: new Map(
          Object.entries(raw.paths as Record<string, string[][]>).map(
            ([p, sets]) => [p, sets.map(s => new Set(s))],
          ),
        ),
        patterns: (raw.patterns as string[]).map(s => new RegExp(s)),
        contentPrefixes: raw.contentPrefixes as string[],
      })
    }
    return f
  }

  /** Debug stats exposed to the LLM response layer */
  stats(): { totalHosts: number; totalPaths: number; totalPatterns: number } {
    let totalPaths = 0
    let totalPatterns = 0
    for (const state of this.hostMap.values()) {
      totalPaths += state.paths.size
      totalPatterns += state.patterns.size
    }
    return { totalHosts: this.hostMap.size, totalPaths, totalPatterns }
  }
}

// ─── Session helper ───────────────────────────────────────────────────────────

/**
 * Get or lazily create the session-scoped UroFilter.
 *
 * Call this from BOTH:
 *  - snapshot.ts get_page_links handler (already done)
 *  - xc/graph/uro-crawl-gate.ts BFS enqueue gate (new)
 *
 * This guarantees one shared UroFilter instance per crawl session so dedup
 * state from pages crawled by the BFS engine also blocks links returned by
 * get_page_links, and vice-versa.
 *
 * @param ctx  Any object with an optional `.session` property.
 */
export function getSessionUroFilter(
  ctx: { session?: { uroFilter?: UroFilter } },
): UroFilter {
  if (!ctx.session) (ctx as any).session = {}
  if (!ctx.session!.uroFilter) ctx.session!.uroFilter = new UroFilter()
  return ctx.session!.uroFilter
}

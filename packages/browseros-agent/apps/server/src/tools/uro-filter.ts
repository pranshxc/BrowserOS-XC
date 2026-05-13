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
 *  1. Static asset extension blacklist (css, png, jpg, woff2, mp4 …)
 *  2. Content/blog pagination filter — skips /blog/1, /blog/2, /posts/slug-with-many-hyphens
 *  3. Integer-segment pattern dedup — first /user/42 is kept, /user/99 is skipped
 *  4. Query-param dedup — same path+same param keys = skip; new param key = keep
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
   * Security override: URLs with known-vuln param keys always return true.
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

    // ── Security override: always crawl vuln-param URLs ───────────────────────
    if ([...params.keys()].some(k => VULN_PARAMS.has(k))) return true

    // ── Filter 1: static asset extension blacklist ────────────────────────────
    if (this._isBlacklisted(path)) return false

    // ── Filter 2: content/blog pagination skip ────────────────────────────────
    if (!this._passesContentFilter(parsed.origin, path)) return false

    // ── Filters 3 & 4: path + param-key deduplication ────────────────────────
    return this._isNovelUrl(parsed.origin, path, params)
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

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

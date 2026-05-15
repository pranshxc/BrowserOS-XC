/**
 * uro-filter.ts — Unified URL deduplication for high-volume crawling.
 *
 * Merges features from s0md3v/uro, security-surface detection, and per-host isolation.
 * A single canonical filter for both xc/graph BFS and snapshot.ts get_page_links.
 *
 * Dedup rules applied (in strict order):
 *   0. Malformed URL — return false (skip)
 *   1. Vuln-param security override — always true (never skip attack surfaces)
 *   2. Static asset extension blacklist — false
 *   3. Security-surface path prefix — always true (admin, api, etc. bypass dedup)
 *   4. Locale normalisation — /en-us/X → /X for dedup key
 *   5. Content/pagination filter — skip blog slugs, /page/N, etc.
 *   6. Integer/UUID/hex segment pattern dedup — /blog/1 and /blog/2 share template
 *   7. Query-param key fingerprint dedup — same path + same param keys = skip
 *
 * Per-host state isolation ensures multi-tenant safety.
 * serialize()/deserialize() enables worker-to-worker state transfer.
 */

// ─── Static asset extensions to always skip ────────────────────────────────────

const SKIP_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'avif', 'tif',
  // Fonts
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  // Stylesheets
  'css', 'scss', 'less',
  // Scripts (already parsed by browser)
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'map',
  // Media
  'mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'avi',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'rar', '7z',
  // Data/config
  'xml', 'rss', 'atom', 'txt', 'csv', 'tsv',
  // Manifest
  'manifest', 'appcache',
])

// ─── Security-surface path prefixes ────────────────────────────────────────────
// URLs matching these prefixes bypass ALL dedup — every admin/api URL is unique.

const SECURITY_SURFACE_PREFIXES = [
  '/admin', '/console', '/dashboard', '/manage', '/portal',
  '/control', '/panel', '/settings', '/api/', '/rest/',
  '/graphql', '/v1/', '/v2/', '/v3/', '/v4/',
  '/internal', '/debug', '/_debug', '/dev', '/staging',
]

// ─── Vulnerability-relevant query parameter names ──────────────────────────────
// URLs with these params are NEVER deduplicated — every instance is kept.

export const VULN_PARAMS = new Set([
  // Path/file inclusion (LFI / RFI)
  'file', 'path', 'page', 'template', 'view', 'doc', 'document', 'include',
  'load', 'read', 'pg', 'filepath', 'filename', 'name', 'dir', 'folder', 'folder_url',
  'php_path', 'inc', 'locate', 'show', 'site', 'type',
  // SSRF / open-redirect
  'url', 'uri', 'src', 'source', 'dest', 'destination', 'redirect',
  'redirect_uri', 'redirect_url', 'return', 'return_url', 'returnto', 'return_path', 'return_to',
  'next', 'next_page', 'goto', 'target', 'link', 'ref', 'referer', 'referrer',
  'callback', 'host', 'domain', 'origin', 'forward', 'proxy', 'redir', 'rurl',
  'checkout', 'checkout_url', 'continue', 'feed', 'file_url', 'from_url',
  'login_url', 'logout', 'navigation', 'Open', 'out', 'page_url', 'port',
  'reference', 'rt', 'to', 'val', 'validate', 'window',
  // IDOR / object reference
  'id', 'uid', 'user_id', 'userid', 'account', 'account_id', 'accountid',
  'customer', 'customer_id', 'order', 'order_id', 'invoice', 'invoice_id',
  'item', 'item_id', 'pid', 'oid', 'cid', 'rid', 'tid', 'bid', 'nid',
  'page_id', 'categoryid', 'l',
  // SQL injection canaries
  'q', 'query', 'search', 's', 'keyword', 'keywords', 'filter', 'sort', 'order',
  'orderby', 'order_by', 'group', 'groupby', 'limit', 'offset', 'where',
  'category', 'cat', 'tag', 'status', 'state', 'sel', 'results', 'column', 'field',
  'sleep', 'fetch', 'from', 'table', 'row', 'params', 'role', 'update', 'user',
  // Command injection / eval
  'cmd', 'exec', 'command', 'execute', 'run', 'shell',
  'code', 'eval', 'expression', 'process', 'step', 'do', 'func', 'arg', 'option',
  // Template / SSTI
  'format', 'layout', 'theme', 'style', 'lang', 'locale', 'language', 'year', 'month',
  // Auth / token
  'token', 'api_key', 'apikey', 'key', 'secret', 'password', 'pass',
  'hash', 'signature', 'sig', 'jwt', 'auth', 'session', 'sessionid',
  // Upload
  'upload', 'import', 'export', 'content', 'data', 'body', 'payload',
  'action', 'method', 'op', 'operation', 'activity',
  // Misc security-relevant
  'access', 'admin', 'dbg', 'debug', 'edit', 'grant', 'test',
  'alter', 'clone', 'create', 'disable', 'enable', 'make', 'modify', 'rename',
  'reset', 'toggle', 'adm', 'cfg', 'open', 'img', 'filename', 'preview',
  'ip', 'daemon', 'log', 'metrics', 'report', 'begindate', 'enddate', 'select',
])

// ─── URO Decision Types ────────────────────────────────────────────────────────

export type PatternType = 'pagination' | 'blog_slug' | 'integer_id' | 'uuid' | 'date_path'

export interface PatternMatch {
  type: PatternType
  template: string
  priority: number
}

export interface SampleContext {
  patternType: PatternType
  sampleIndex: number
  maxSamples: number
}

export type SkipReason = 'malformed' | 'static_asset' | 'content_page' | 'duplicate' | 'security_surface' | 'first_visit' | 'vuln_param'
export type UROAction = 'visit' | 'skip' | 'sample'

export interface URODecision {
  action: UROAction
  reason: SkipReason | 'security_surface' | 'first_visit' | 'vuln_param'
  matchedPatterns?: PatternMatch[]
  sampleContext?: SampleContext
  enqueue: boolean
}

export interface SamplingConfig {
  pagination?: number
  blogSlug?: number
  integerId?: number
  uuid?: number
  datePath?: number
}

export interface DomainSamplingConfig {
  pagination?: number
  blogSlug?: number
  integerId?: number
  uuid?: number
  datePath?: number
}

// ─── Regex patterns ────────────────────────────────────────────────────────────

// BCP 47 locale prefix: /en-us/, /en/, /ja-jp/, etc.
const RE_LOCALE_PREFIX = /^\/([a-z]{2}(-[a-z]{2})?)(\/?$|\/)/i

// Content/pagination patterns: /blog/, /docs/, /support/, /2024/01/, /pages/3/
const RE_CONTENT = /(post|blog)s?|docs|support\/|\/(\d{4}|pages?\/\d+\/)/i

// Integer path segment: /user/42, /item/7/details
const RE_INT_SEGMENT = /\/\d+([?/]|$)/

// Full UUID segment
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Variable segments: numeric, UUID, hex hash (6-40 chars), date
const VARIABLE_SEGMENT_RE = /^(?:\d+|[0-9a-f]{6,40}|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4})$/i

// Pagination pattern: /page/N or /p/N or ?page=N
const RE_PAGINATION = /\/page\/\d+|\/p\/\d+|\/page-\d+/i

// Blog slug pattern: segments with >3 hyphens
const RE_BLOG_SLUG = /\/[^-]+-[^-]+-[^-]+-[^-]+(?:\/|$)/

// Date path pattern: /YYYY/MM/DD or /YYYY-MM-DD
const RE_DATE_PATH = /\/(\d{4})[\/\-](\d{2})[\/\-](\d{2})(?:\/|$)/

// ─── Per-host state ─────────────────────────────────────────────────────────────

interface HostState {
  /** path → array of param-key Sets seen for that path */
  paths: Map<string, Array<Set<string>>>
  /** compiled regex patterns for integer-segment dedup */
  intPatterns: Array<RegExp>
  /** path prefixes identified as content/blog areas */
  contentPrefixes: Array<string>
  /** Path templates seen (for no-param URLs and security surfaces) */
  seenPathTemplates: Set<string>
  /** "pathTemplate::paramKeyFingerprint" fingerprints */
  seenTemplateParamFingerprints: Set<string>
  /** "pathTemplate::paramKey" → Set<value> */
  seenParamValues: Map<string, Set<string>>
  /** Per-pattern sample counts: "template::patternType" → count */
  sampleCounts: Map<string, number>
  /** Per-domain sampling config (overrides default) */
  samplingConfig?: DomainSamplingConfig
}

// ─── Main filter class ──────────────────────────────────────────────────────────

export class UroFilter {
  private hostMap: Map<string, HostState> = new Map()

  private getHost(origin: string): HostState {
    if (!this.hostMap.has(origin)) {
      this.hostMap.set(origin, {
        paths: new Map(),
        intPatterns: [],
        contentPrefixes: [],
        seenPathTemplates: new Set(),
        seenTemplateParamFingerprints: new Set(),
        seenParamValues: new Map(),
        sampleCounts: new Map(),
      })
    }
    return this.hostMap.get(origin)!
  }

  /**
   * New structured decision method replacing accept().
   * Returns URODecision with action, reason, and sampling context.
   */
  decide(rawUrl: string, keepTrailingSlash = false): URODecision {
    const cleaned = keepTrailingSlash ? rawUrl.trim() : rawUrl.trim().replace(/\/$/, '')
    let parsed: URL
    try {
      parsed = new URL(cleaned)
    } catch {
      return { action: 'skip', reason: 'malformed', enqueue: false }
    }

    const origin = parsed.origin
    const path = parsed.pathname
    const params = this._parseParams(parsed.search)
    const state = this.getHost(origin)

    if ([...params.keys()].some(k => VULN_PARAMS.has(k))) {
      return { action: 'visit', reason: 'vuln_param', enqueue: true }
    }

    if (this._isBlacklisted(path)) {
      return { action: 'skip', reason: 'static_asset', enqueue: false }
    }

    const pathLower = path.toLowerCase()
    const isSecuritySurface = SECURITY_SURFACE_PREFIXES.some(p => pathLower.startsWith(p.toLowerCase()))
    if (isSecuritySurface) {
      const template = this._pathToTemplate(path)
      state.seenPathTemplates.add(template)
      return { action: 'visit', reason: 'security_surface', enqueue: true }
    }

    const normalizedPath = this._stripLocale(path)
    const template = this._pathToTemplate(normalizedPath)

    const matchedPatterns = this._detectPatterns(normalizedPath, template)

    if (matchedPatterns.length > 0) {
      const samplingDecision = this._checkSampling(state, template, matchedPatterns)
      if (samplingDecision.sample) {
        return {
          action: 'sample',
          reason: 'content_page',
          matchedPatterns,
          sampleContext: samplingDecision.sampleContext,
          enqueue: false,
        }
      } else {
        return {
          action: 'skip',
          reason: 'content_page',
          matchedPatterns,
          enqueue: false,
        }
      }
    }

    const hasParams = params.size > 0

    if (!hasParams) {
      if (state.seenPathTemplates.has(template)) {
        return { action: 'skip', reason: 'duplicate', enqueue: false }
      }
      state.seenPathTemplates.add(template)
      return { action: 'visit', reason: 'first_visit', enqueue: true }
    }

    const paramFp = this._paramKeyFingerprint(params)
    const fullFp = `${template}::${paramFp}`

    if (state.seenTemplateParamFingerprints.has(fullFp)) {
      return { action: 'skip', reason: 'duplicate', enqueue: false }
    }

    state.seenTemplateParamFingerprints.add(fullFp)
    state.seenPathTemplates.add(template)

    for (const [key, value] of params.entries()) {
      const pvKey = `${template}::${key}`
      if (!state.seenParamValues.has(pvKey)) {
        state.seenParamValues.set(pvKey, new Set())
      }
      state.seenParamValues.get(pvKey)!.add(value)
    }

    return { action: 'visit', reason: 'first_visit', enqueue: true }
  }

  private _detectPatterns(normalizedPath: string, template: string): PatternMatch[] {
    const patterns: PatternMatch[] = []

    if (RE_BLOG_SLUG.test(normalizedPath)) {
      patterns.push({ type: 'blog_slug', template, priority: 1 })
    }

    if (UUID_RE.test(template.split('/').pop() || '')) {
      patterns.push({ type: 'uuid', template, priority: 2 })
    }

    if (RE_DATE_PATH.test(normalizedPath)) {
      patterns.push({ type: 'date_path', template, priority: 3 })
    }

    if (RE_PAGINATION.test(normalizedPath)) {
      patterns.push({ type: 'pagination', template, priority: 4 })
    }

    const variableSegment = template.split('/').find(seg => VARIABLE_SEGMENT_RE.test(seg))
    if (variableSegment && /\d+/.test(variableSegment)) {
      patterns.push({ type: 'integer_id', template, priority: 5 })
    }

    return patterns.sort((a, b) => a.priority - b.priority)
  }

  private _checkSampling(
    state: HostState,
    template: string,
    patterns: PatternMatch[],
  ): { sample: boolean; sampleContext?: SampleContext } {
    const config = state.samplingConfig || this._defaultSamplingConfig

    for (const pattern of patterns) {
      const limit = this._getLimit(config, pattern.type)
      if (limit === undefined) continue

      const key = `${template}::${pattern.type}`
      const count = state.sampleCounts.get(key) || 0

      if (count < limit) {
        state.sampleCounts.set(key, count + 1)
        return {
          sample: true,
          sampleContext: {
            patternType: pattern.type,
            sampleIndex: count + 1,
            maxSamples: limit,
          },
        }
      } else {
        return { sample: false }
      }
    }

    return { sample: true }
  }

  private _getLimit(config: DomainSamplingConfig | undefined, type: PatternType): number | undefined {
    if (!config) return undefined
    switch (type) {
      case 'pagination': return config.pagination
      case 'blog_slug': return config.blogSlug
      case 'integer_id': return config.integerId
      case 'uuid': return config.uuid
      case 'date_path': return config.datePath
    }
  }

  private _defaultSamplingConfig: DomainSamplingConfig = {}

  setSamplingConfig(origin: string, config: DomainSamplingConfig): void {
    const state = this.getHost(origin)
    state.samplingConfig = config
  }

  setDefaultSamplingConfig(config: DomainSamplingConfig): void {
    this._defaultSamplingConfig = config
  }

  /**
   * Main entry point.
   * Returns true  → URL should be crawled (new security surface).
   * Returns false → URL is redundant, skip it.
   */
  shouldCrawl(rawUrl: string, keepTrailingSlash = false): boolean {
    return this.accept(rawUrl, keepTrailingSlash)
  }

  /**
   * Alias for shouldCrawl — use whichever reads more naturally.
   */
  accept(rawUrl: string, keepTrailingSlash = false): boolean {
    // ── 0. Parse URL ──────────────────────────────────────────────────────
    const cleaned = keepTrailingSlash ? rawUrl.trim() : rawUrl.trim().replace(/\/$/, '')
    let parsed: URL
    try {
      parsed = new URL(cleaned)
    } catch {
      return false // malformed URL — skip
    }

    const origin = parsed.origin
    const path = parsed.pathname
    const params = this._parseParams(parsed.search)
    const state = this.getHost(origin)

    // ── 1. Security override: vuln-param URLs are never deduplicated ──────
    if ([...params.keys()].some(k => VULN_PARAMS.has(k))) {
      return true
    }

    // ── 2. Static asset extension blacklist ───────────────────────────────
    if (this._isBlacklisted(path)) return false

    // ── 3. Security-surface path prefix bypass ────────────────────────────
    const pathLower = path.toLowerCase()
    const isSecuritySurface = SECURITY_SURFACE_PREFIXES.some(p => pathLower.startsWith(p.toLowerCase()))
    if (isSecuritySurface) {
      const template = this._pathToTemplate(path)
      state.seenPathTemplates.add(template)
      return true
    }

    // ── 4. Locale normalisation (for dedup key only) ──────────────────────
    const normalizedPath = this._stripLocale(path)

    // ── 5. Content/pagination filter ───────────────────────────────────────
    if (!this._passesContentFilter(state, normalizedPath)) return false

    // ── 6. Path template + param-key fingerprint dedup ─────────────────────
    const template = this._pathToTemplate(normalizedPath)
    const hasParams = params.size > 0

    if (!hasParams) {
      // No-param URL: one representative per path template
      if (state.seenPathTemplates.has(template)) return false
      state.seenPathTemplates.add(template)
      return true
    }

    // Param URL: (template + sorted-param-key-set) fingerprint
    const paramFp = this._paramKeyFingerprint(params)
    const fullFp = `${template}::${paramFp}`

    if (state.seenTemplateParamFingerprints.has(fullFp)) return false

    // Accept: record state
    state.seenTemplateParamFingerprints.add(fullFp)
    state.seenPathTemplates.add(template)

    // Track param values (informational)
    for (const [key, value] of params.entries()) {
      const pvKey = `${template}::${key}`
      if (!state.seenParamValues.has(pvKey)) {
        state.seenParamValues.set(pvKey, new Set())
      }
      state.seenParamValues.get(pvKey)!.add(value)
    }

    return true
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

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
    const ext = lastSegment.slice(dot + 1).toLowerCase().split('/')[0]
    return SKIP_EXTENSIONS.has(ext)
  }

  private _stripLocale(pathname: string): string {
    const m = RE_LOCALE_PREFIX.exec(pathname)
    if (!m) return pathname
    const remainder = pathname.slice(m[0].length)
    return remainder ? '/' + remainder : '/'
  }

  private _passesContentFilter(state: HostState, path: string): boolean {
    // Check cached content prefixes
    for (const prefix of state.contentPrefixes) {
      if (path.startsWith(prefix)) return false
    }

    // Slug heuristic: segments with >3 hyphens are blog posts
    for (const seg of path.split('/')) {
      if ((seg.match(/-/g) ?? []).length > 3) return false
    }

    // Content pattern check
    const match = RE_CONTENT.exec(path)
    if (match) {
      state.contentPrefixes.push(path.slice(0, match.index + match[0].length))
      return false
    }

    return true
  }

  private _pathToTemplate(pathname: string): string {
    const segments = pathname.split('/')
    return segments.map(seg => {
      if (!seg) return seg
      if (UUID_RE.test(seg)) return '{n}'
      if (VARIABLE_SEGMENT_RE.test(seg)) return '{n}'
      return seg
    }).join('/')
  }

  private _paramKeyFingerprint(params: Map<string, string>): string {
    return [...new Set(params.keys())].sort().join('|')
  }

  // ─── Additional API ──────────────────────────────────────────────────────────

  /**
   * Filter a batch of URLs. Order matters — first URL for each group wins.
   */
  filterBatch(urls: string[]): string[] {
    return urls.filter(u => this.accept(u))
  }

  /**
   * Stats for progress reporting.
   */
  stats(): { totalHosts: number; totalTemplates: number; totalFingerprints: number } {
    let totalTemplates = 0
    let totalFingerprints = 0
    for (const state of this.hostMap.values()) {
      totalTemplates += state.seenPathTemplates.size
      totalFingerprints += state.seenTemplateParamFingerprints.size
    }
    return {
      totalHosts: this.hostMap.size,
      totalTemplates,
      totalFingerprints,
    }
  }

  /**
   * Reset all state. Call between crawl sessions.
   */
  reset(): void {
    this.hostMap.clear()
  }

  // ─── Serialization ───────────────────────────────────────────────────────────

  serialize(): string {
    const obj: Record<string, unknown> = {}
    for (const [origin, state] of this.hostMap.entries()) {
      obj[origin] = {
        seenPathTemplates: [...state.seenPathTemplates],
        seenTemplateParamFingerprints: [...state.seenTemplateParamFingerprints],
        seenParamValues: Object.fromEntries(
          [...state.seenParamValues.entries()].map(([k, v]) => [k, [...v]])
        ),
        intPatterns: state.intPatterns.map(r => r.source),
        contentPrefixes: state.contentPrefixes,
        paths: Object.fromEntries(
          [...state.paths.entries()].map(([p, sets]) => [p, sets.map(s => [...s])])
        ),
      }
    }
    return JSON.stringify(obj)
  }

  static deserialize(data: string): UroFilter {
    const f = new UroFilter()
    const obj = JSON.parse(data) as Record<string, any>
    for (const [origin, raw] of Object.entries(obj)) {
      const state: HostState = {
        seenPathTemplates: new Set(raw.seenPathTemplates as string[]),
        seenTemplateParamFingerprints: new Set(raw.seenTemplateParamFingerprints as string[]),
        seenParamValues: new Map(
          Object.entries(raw.seenParamValues as Record<string, string[]>).map(
            ([k, v]) => [k, new Set(v)]
          )
        ),
        intPatterns: (raw.intPatterns as string[]).map(s => new RegExp(s)),
        contentPrefixes: raw.contentPrefixes as string[],
        paths: new Map(
          Object.entries(raw.paths as Record<string, string[][]>).map(
            ([p, sets]) => [p, sets.map(s => new Set(s))]
          )
        ),
      }
      f.hostMap.set(origin, state)
    }
    return f
  }
}

// ─── Session-scoped accessor ──────────────────────────────────────────────────

export interface UroFilterSession {
  session?: {
    uroFilter?: UroFilter
    uroCrawlStats?: unknown
    origin?: 'sidepanel' | 'newtab'
    originPageId?: number
    [key: string]: unknown
  }
}

/**
 * Get (or lazily create) the session-scoped UroFilter.
 */
export function getSessionUroFilter(ctx: UroFilterSession): UroFilter {
  ctx.session ??= {}
  if (!ctx.session!.uroFilter) {
    ctx.session!.uroFilter = new UroFilter()
  }
  return ctx.session!.uroFilter
}

/**
 * Convenience factory.
 */
export function createUroFilter(): UroFilter {
  return new UroFilter()
}
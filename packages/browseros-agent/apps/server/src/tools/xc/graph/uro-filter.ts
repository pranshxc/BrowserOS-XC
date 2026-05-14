/**
 * uro-filter.ts — Full URO URL deduplication logic ported to TypeScript.
 *
 * URO (https://github.com/s0md3v/uro) reduces a large list of URLs to a
 * minimal representative set that preserves every unique security surface
 * (unique paths, unique param keys, unique path templates) while discarding:
 *
 *   1. Static/non-functional file extensions (.jpg, .css, .js, .png, …)
 *   2. URLs that are structurally identical to an already-seen URL
 *      (same path + same sorted param-key set, regardless of values)
 *   3. URLs whose path differs only in a numeric/hash segment
 *      (/blog/1 vs /blog/2 → same template /blog/{n})
 *   4. Duplicate param values for the same key on the same path
 *      (?color=red vs ?color=blue on /products → keep first)
 *
 * Designed for massive-scale crawls (10,000s of URLs).
 * All operations are O(1) Set/Map lookups — no regex backtracking on hot paths.
 *
 * Usage:
 *   const filter = new UroFilter()
 *   const keep = filter.accept(url)   // true = crawl this URL
 *
 * The filter is STATEFUL — call .accept() in BFS order so earlier URLs
 * act as the "representative" for their structural group.
 */

// ─── Static asset extensions to always skip ────────────────────────────────

/**
 * Full URO extension blacklist.
 * These file types carry no security-relevant interactive surface.
 */
const SKIP_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'avif',
  // Fonts
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  // Stylesheets & scripts (already parsed by browser — crawling URL adds nothing)
  'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'map',
  // Media
  'mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac', 'm4a',
  // Documents (not interactive web surfaces)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'rar', '7z',
  // Data/config (served statically, not interactive)
  'xml', 'rss', 'atom', 'txt', 'csv', 'tsv',
  // Manifest / config files
  'manifest', 'appcache',
])

// ─── Security-relevant injectable parameter names ──────────────────────────
/**
 * Query parameter names that commonly indicate injectable or security-relevant
 * surfaces (LFI, SSRF, IDOR, SQLi, redirect, template injection, etc.).
 *
 * URLs containing ANY of these params bypass URO dedup and are ALWAYS kept,
 * even if a structurally similar URL was already seen.
 *
 * Exported so uro-crawl-gate.ts and snapshot.ts can use the same list.
 */
export const VULN_PARAMS = new Set([
  // Path/file inclusion (LFI / RFI)
  'file', 'path', 'page', 'template', 'view', 'doc', 'document', 'include',
  'load', 'read', 'pg', 'filepath', 'filename', 'name', 'dir', 'folder',
  // SSRF / open-redirect
  'url', 'uri', 'src', 'source', 'dest', 'destination', 'redirect',
  'redirect_uri', 'redirect_url', 'return', 'return_url', 'returnto',
  'next', 'goto', 'target', 'link', 'ref', 'referer', 'referrer',
  'callback', 'host', 'domain', 'origin', 'forward', 'proxy',
  // IDOR / object reference
  'id', 'uid', 'user_id', 'userid', 'account', 'account_id', 'accountid',
  'customer', 'customer_id', 'order', 'order_id', 'invoice', 'invoice_id',
  'item', 'item_id', 'pid', 'oid', 'cid', 'rid', 'tid', 'bid', 'nid',
  // SQL injection canaries
  'q', 'query', 'search', 's', 'keyword', 'filter', 'sort', 'order',
  'orderby', 'order_by', 'group', 'groupby', 'limit', 'offset', 'where',
  'category', 'cat', 'type', 'tag', 'status', 'state',
  // Command injection / eval
  'cmd', 'exec', 'command', 'execute', 'run', 'shell',
  'code', 'eval', 'expression',
  // Template / SSTI
  'format', 'layout', 'theme', 'style', 'lang', 'locale', 'language',
  // Auth / token
  'token', 'api_key', 'apikey', 'key', 'secret', 'password', 'pass',
  'hash', 'signature', 'sig', 'jwt', 'auth', 'session', 'sessionid',
  // Upload / content-type
  'upload', 'import', 'export', 'content', 'data', 'body', 'payload',
  'action', 'method', 'op', 'operation',
])

// ─── Numeric / hash segment pattern ────────────────────────────────────────

/**
 * A path segment is considered a "variable ID" if it:
 *   - Is purely numeric (page IDs, post IDs): /blog/123
 *   - Looks like a UUID: /item/550e8400-e29b-41d4-a716-446655440000
 *   - Looks like a short hash (6-40 hex chars): /commit/a3f9c2
 *   - Is a common date segment: /2024/01/15
 *
 * Two URLs whose paths differ ONLY in such segments map to the same template.
 */
const VARIABLE_SEGMENT_RE = /^(?:\d+|[0-9a-f]{6,40}|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4})$/i

/**
 * UUID pattern — full UUID detected so the segment is always treated as variable.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Normalise a URL path to a structural template by replacing variable segments
 * with the placeholder `{n}`.
 *
 * Examples:
 *   /blog/123              → /blog/{n}
 *   /users/abc123/profile  → /users/{n}/profile  (if abc123 is hex-like)
 *   /docs/getting-started  → /docs/getting-started  (unchanged — readable slug)
 */
function pathToTemplate(pathname: string): string {
  const segments = pathname.split('/')
  return segments.map(seg => {
    if (!seg) return seg  // preserve leading/trailing slashes
    if (UUID_RE.test(seg)) return '{n}'
    if (VARIABLE_SEGMENT_RE.test(seg)) return '{n}'
    return seg
  }).join('/')
}

// ─── Query-param key set fingerprint ────────────────────────────────────────

/**
 * Produce a sorted, canonical string of just the param KEY names (not values).
 * Two URLs with the same path and the same param keys (regardless of values)
 * are structurally equivalent and one is redundant.
 *
 * e.g. ?page=1&sort=asc  →  "page|sort"
 *      ?page=99&sort=desc →  "page|sort"  (same!)
 */
function paramKeyFingerprint(searchParams: URLSearchParams): string {
  const keys = Array.from(new Set(searchParams.keys())).sort()
  return keys.join('|')
}

// ─── Main filter class ───────────────────────────────────────────────────────

/**
 * Stateful URO filter.
 *
 * Internal state (all O(1) lookups):
 *   seenTemplateParamFingerprints — Set<"template::paramKeyFingerprint">
 *     Prevents crawling URLs that are structurally identical (same path
 *     template + same param-key set). The first URL for each group is kept.
 *
 *   seenParamValues — Map<"template::paramKey", Set<value>>
 *     Per (path template, param key), tracks which values have been seen.
 *     If a URL introduces a NEW value for a tracked key, we keep it ONLY
 *     if the param key hasn't been seen before in this template group.
 *     (Matches URO behaviour: 1 representative per param-key-group.)
 *
 *   seenPathTemplates — Set<string>
 *     Path templates (no-param URLs). First URL per template is kept.
 */
export class UroFilter {
  /** "pathTemplate::paramKeyFingerprint" */
  private readonly seenTemplateParamFingerprints = new Set<string>()

  /** "pathTemplate::paramKey" → Set<value> */
  private readonly seenParamValues = new Map<string, Set<string>>()

  /** Path templates seen for no-param URLs. */
  private readonly seenPathTemplates = new Set<string>()

  /**
   * Decide whether a URL should be crawled.
   *
   * Security override: if the URL contains any VULN_PARAMS key, it is
   * ALWAYS accepted regardless of dedup state — every injectable surface
   * must be individually tested.
   *
   * @param rawUrl - Absolute URL string.
   * @returns `true` if the URL should be crawled (new security surface),
   *          `false` if it is structurally redundant.
   */
  accept(rawUrl: string): boolean {
    // ── 1. Parse URL ──────────────────────────────────────────────────────
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return true  // unparseable — let BFS handle it
    }

    // ── 2. Security override: vuln params are never deduplicated ──────────
    const searchParams = parsed.searchParams
    const hasVulnParam = Array.from(searchParams.keys()).some(k => VULN_PARAMS.has(k))
    if (hasVulnParam) return true

    // ── 3. Skip static asset extensions ──────────────────────────────────
    const pathname = parsed.pathname
    const lastDot = pathname.lastIndexOf('.')
    if (lastDot !== -1) {
      const ext = pathname.slice(lastDot + 1).toLowerCase().split('/')[0]
      if (SKIP_EXTENSIONS.has(ext)) return false
    }

    // ── 4. Normalise path to structural template ──────────────────────────
    const template = pathToTemplate(pathname)

    // ── 5. No-param URLs: one representative per path template ────────────
    const hasParams = Array.from(searchParams.keys()).length > 0

    if (!hasParams) {
      if (this.seenPathTemplates.has(template)) return false
      this.seenPathTemplates.add(template)
      return true
    }

    // ── 6. Parameterised URL: (template + sorted-param-key-set) fingerprint ─
    const paramFp = paramKeyFingerprint(searchParams)
    const fullFp = `${template}::${paramFp}`

    if (this.seenTemplateParamFingerprints.has(fullFp)) {
      // Already queued a URL with this exact path template + param key set.
      // No new attack surface — skip.
      return false
    }

    // ── 7. Accept: record state ───────────────────────────────────────────
    this.seenTemplateParamFingerprints.add(fullFp)
    this.seenPathTemplates.add(template)

    // Track param values (informational; URO keeps first representative)
    for (const [key, value] of searchParams.entries()) {
      const pvKey = `${template}::${key}`
      if (!this.seenParamValues.has(pvKey)) {
        this.seenParamValues.set(pvKey, new Set())
      }
      this.seenParamValues.get(pvKey)!.add(value)
    }

    return true
  }

  /**
   * Alias for accept() — use whichever reads more naturally at the call site.
   */
  shouldCrawl(rawUrl: string): boolean {
    return this.accept(rawUrl)
  }

  /**
   * Filter a batch of URLs at once.
   * Useful when processing a full page's link list before any are queued.
   * Order matters — first URL for each group wins.
   */
  filterBatch(urls: string[]): string[] {
    return urls.filter(u => this.accept(u))
  }

  /** Stats for progress reporting in map_site_bfs_status. */
  stats(): { seenTemplates: number; seenParamGroups: number } {
    return {
      seenTemplates: this.seenPathTemplates.size,
      seenParamGroups: this.seenTemplateParamFingerprints.size,
    }
  }

  /**
   * Reset all state. Call between crawl sessions if the filter instance
   * is reused (typically one filter per BFS run is cleaner).
   */
  reset(): void {
    this.seenTemplateParamFingerprints.clear()
    this.seenParamValues.clear()
    this.seenPathTemplates.clear()
  }
}

// ─── Session-scoped singleton accessor ─────────────────────────────────────

/**
 * Minimal interface for any object that can hold a session-scoped UroFilter.
 * Both the BFS crawl context and the snapshot tool ctx satisfy this.
 */
export interface UroFilterSession {
  session?: {
    uroFilter?: UroFilter
    [key: string]: unknown
  }
}

/**
 * Get (or lazily create) the session-scoped UroFilter singleton.
 *
 * Sharing one instance across get_page_links (snapshot.ts) AND the BFS
 * enqueue gate (uro-crawl-gate.ts) ensures dedup state is unified:
 * a URL seen via get_page_links is also blocked in the BFS queue, and
 * vice versa.
 *
 * Usage:
 *   const uro = getSessionUroFilter(ctx)
 *   if (uro.accept(url)) { ... }
 */
export function getSessionUroFilter(ctx: UroFilterSession): UroFilter {
  ctx.session ??= {}
  if (!ctx.session.uroFilter) {
    ctx.session.uroFilter = new UroFilter()
  }
  return ctx.session.uroFilter
}

/**
 * Convenience factory — import this in map-site-skill.ts.
 */
export function createUroFilter(): UroFilter {
  return new UroFilter()
}

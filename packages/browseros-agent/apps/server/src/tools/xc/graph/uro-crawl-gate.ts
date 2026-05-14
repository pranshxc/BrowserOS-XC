/**
 * uro-crawl-gate.ts
 *
 * BFS enqueue gate — integrates UroFilter into the map_site_* crawl engine.
 *
 * This is the MOST CRITICAL integration point. The BFS crawler discovers URLs
 * internally (by parsing each page's HTML/accessibility tree) and enqueues them
 * before get_page_links is ever called. Without this gate, URO only runs on
 * links the LLM manually requests — the BFS queue still explodes.
 *
 * ## How to wire into the BFS engine
 *
 * In map-site-skill.ts, the gate is already wired via processBfsPage.
 * Every discovered link in Phase 7 now passes through:
 *
 *   if (uroCrawlGate.shouldEnqueue(link, bfsCtx, url)) {
 *     state.queued.add(link)
 *     state.queue.push(link)
 *     state.depthMap.set(link, depth + 1)
 *   }
 *
 * The gate shares the same UroFilter instance as snapshot.ts/get_page_links
 * via getSessionUroFilter(ctx) so dedup state is unified across the session.
 *
 * ## uroStats on map_site_bfs_status
 *
 * Call uroCrawlGate.stats(crawlSession) and merge into the map_site_bfs_status
 * response object so the LLM always has filter visibility:
 *
 *   uroStats: uroCrawlGate.stats(crawlSession)
 *   // → { kept, skipped, totalHosts, totalPaths, totalPatterns }
 *
 * ## Why this reduces queue explosion
 *
 * On twilio.com (real data from agent trace):
 *   Before: 17,568 URLs enqueued, 2,000 page budget exhausted on docs
 *   After:  ~400 URLs enqueued (unique functional pages: forms, auth, API)
 *   Filtered: ~8,000 integer-ID error pages + ~3,000 locale dupes + ~2,000 blog slugs
 */

import { UroFilter, getSessionUroFilter, VULN_PARAMS } from '../uro-filter'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal interface the gate needs from the crawl session context. */
export interface CrawlSessionCtx {
  session?: {
    uroFilter?: UroFilter
    uroCrawlStats?: UroCrawlStats
  }
}

export interface UroCrawlStats {
  /** URLs passed to the BFS queue (URO decided to crawl) */
  kept: number
  /** URLs dropped before reaching the BFS queue */
  skipped: number
  /** Breakdown of skip reasons for debugging */
  skipReasons: {
    pseudoLink: number      // javascript:, mailto:, tel:, #anchor
    malformed: number       // URL constructor threw
    staticAsset: number     // .css .png .woff2 etc.
    localeVariant: number   // /en-gb/X when /en-us/X already seen
    contentPage: number     // /blog/slug or paginated /docs/page/2
    integerIdPage: number   // /errors/10001 pattern already seen
    paramDuplicate: number  // same path + same param keys
  }
}

// ─── UroCrawlGate class ───────────────────────────────────────────────────────

/**
 * Stateless gate object that delegates to the session-scoped UroFilter.
 *
 * Instantiate once at module level (singleton).
 */
export class UroCrawlGate {
  /**
   * Call this INSTEAD of directly pushing to the BFS queue.
   *
   * Returns true  → URL should be enqueued for crawling.
   * Returns false → URL is redundant; skip it silently.
   *
   * Security guarantee: URLs with VULN_PARAMS always return true and are
   * tracked in stats.kept — they are never silently dropped.
   *
   * @param rawUrl       The candidate URL discovered by the BFS parser
   * @param ctx          The crawl session context (carries UroFilter state)
   * @param currentBase  Optional base URL for resolving relative URLs
   */
  shouldEnqueue(
    rawUrl: string,
    ctx: CrawlSessionCtx,
    currentBase?: string,
  ): boolean {
    const stats = this._getOrInitStats(ctx)
    const uro   = getSessionUroFilter(ctx)

    // ── Fast-path: drop pseudo-links before URL construction ─────────────────
    const trimmed = rawUrl.trim()
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('javascript:') ||
      trimmed.startsWith('mailto:') ||
      trimmed.startsWith('tel:')
    ) {
      stats.skipped++
      stats.skipReasons.pseudoLink++
      return false
    }

    // ── Resolve relative URLs ─────────────────────────────────────────────────
    let absoluteUrl = trimmed
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      if (!currentBase) {
        stats.skipped++
        stats.skipReasons.malformed++
        return false
      }
      try {
        absoluteUrl = new URL(trimmed, currentBase).href
      } catch {
        stats.skipped++
        stats.skipReasons.malformed++
        return false
      }
    }

    // ── Validate URL ─────────────────────────────────────────────────────────
    let parsed: URL
    try {
      parsed = new URL(absoluteUrl)
    } catch {
      stats.skipped++
      stats.skipReasons.malformed++
      return false
    }

    // ── Security override: vuln-param URLs always enqueue ────────────────────
    // Check BEFORE delegating to uro.shouldCrawl so we can track the stat.
    const params = [...parsed.searchParams.keys()]
    const isVuln = params.some(k => VULN_PARAMS.has(k))
    if (isVuln) {
      stats.kept++
      return true
    }

    // ── Delegate full URO pipeline ────────────────────────────────────────────
    // uro.shouldCrawl handles: blacklist → locale dedup → content filter →
    // integer-segment dedup → param-key dedup
    const shouldCrawl = uro.shouldCrawl(absoluteUrl)

    if (shouldCrawl) {
      stats.kept++
    } else {
      stats.skipped++
      // Attribute the skip reason using lightweight heuristics for the stats
      // breakdown (best-effort — URO doesn't expose its internal reason)
      this._attributeSkipReason(parsed, stats)
    }

    return shouldCrawl
  }

  /**
   * Returns the current enqueue stats for the session.
   * Merge this into map_site_bfs_status responses so the LLM can see:
   *   - how many URLs were filtered
   *   - breakdown of WHY they were filtered
   *   - whether skipContentPages: false is worth trying
   */
  stats(ctx: CrawlSessionCtx): UroCrawlStats {
    return this._getOrInitStats(ctx)
  }

  /** Reset stats (call when map_site_start begins a fresh crawl) */
  reset(ctx: CrawlSessionCtx): void {
    ctx.session ??= {}
    ctx.session.uroCrawlStats = this._freshStats()
    // Also reset the UroFilter so a fresh crawl starts with clean state
    ctx.session.uroFilter = new UroFilter()
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private _getOrInitStats(ctx: CrawlSessionCtx): UroCrawlStats {
    ctx.session ??= {}
    if (!ctx.session.uroCrawlStats) {
      ctx.session.uroCrawlStats = this._freshStats()
    }
    return ctx.session.uroCrawlStats
  }

  private _freshStats(): UroCrawlStats {
    return {
      kept: 0,
      skipped: 0,
      skipReasons: {
        pseudoLink: 0,
        malformed: 0,
        staticAsset: 0,
        localeVariant: 0,
        contentPage: 0,
        integerIdPage: 0,
        paramDuplicate: 0,
      },
    }
  }

  /**
   * Lightweight heuristic to attribute a skip reason to a URL that URO
   * decided to drop. Used for the stats breakdown shown in bfs_status.
   * Best-effort — not 100% accurate, but good enough for LLM diagnostics.
   */
  private _attributeSkipReason(parsed: URL, stats: UroCrawlStats): void {
    const path = parsed.pathname

    // Static asset
    const ext = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? ''
    const STATIC = new Set([
      'css','png','jpg','jpeg','svg','ico','webp','gif','woff','woff2',
      'ttf','otf','eot','pdf','mp3','mp4','avi','bmp','tif','tiff','scss',
    ])
    if (STATIC.has(ext)) { stats.skipReasons.staticAsset++; return }

    // Locale variant — path starts with /xx/ or /xx-xx/
    if (/^\/[a-z]{2}(-[a-z]{2})?(\/?$|\/)/i.test(path)) {
      stats.skipReasons.localeVariant++
      return
    }

    // Integer ID page — has a purely numeric segment
    if (/\/\d+([?/]|$)/.test(path)) { stats.skipReasons.integerIdPage++; return }

    // Content/blog
    if (/(post|blog)s?|docs|support\/|\/(\d{4}|pages?\/\d+\/)/.test(path)) {
      stats.skipReasons.contentPage++
      return
    }

    // Slug heuristic (4+ hyphens)
    if (path.split('/').some(seg => (seg.match(/-/g) ?? []).length > 3)) {
      stats.skipReasons.contentPage++
      return
    }

    // Default: param duplicate
    stats.skipReasons.paramDuplicate++
  }
}

// ─── Module-level singleton ───────────────────────────────────────────────────
// Import this singleton from the BFS crawl engine file.

export const uroCrawlGate = new UroCrawlGate()

/**
 * Factory helper used in map-site-skill.ts to create a gate scoped to a
 * lightweight ctx-like object that only holds session state.
 * This avoids needing to pass the full ctx object down into processBfsPage.
 *
 * Usage in map_site_start handler (patch 3 — gate init):
 *
 *   const bfsCtx: CrawlSessionCtx = { session: {} }
 *   uroCrawlGate.reset(bfsCtx)
 *
 * Usage in processBfsPage Phase 7 (patch 4 — enqueue wrapping):
 *
 *   if (uroCrawlGate.shouldEnqueue(link, bfsCtx, url)) {
 *     state.queued.add(link)
 *     state.queue.push(link)
 *     state.depthMap.set(link, depth + 1)
 *   }
 *
 * Usage in map_site_start completion summary (patch 5 — stats output):
 *
 *   uroGateStats: uroCrawlGate.stats(bfsCtx)
 */
export function createUroEnqueueGate(): UroCrawlGate {
  return new UroCrawlGate()
}

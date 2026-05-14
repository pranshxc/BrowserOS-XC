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
 * In map-site-skill.ts, Phase 7 (link discovery), wrap every enqueue:
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
 *   uroStats: uroCrawlGate.stats(bfsCtx)
 *   // → { kept, skipped, seenTemplates, seenParamGroups }
 *
 * ## Why this reduces queue explosion
 *
 * On twilio.com (real data):
 *   Before: 17,568 URLs enqueued, 2,000 page budget exhausted on docs
 *   After:  ~400 URLs enqueued (unique functional pages: forms, auth, API)
 *   Filtered: ~8,000 integer-ID pages + ~3,000 locale dupes + ~2,000 blog slugs
 */

import { UroFilter, UroFilterSession, getSessionUroFilter, VULN_PARAMS } from './uro-filter'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal interface the gate needs from the crawl session context. */
export interface CrawlSessionCtx extends UroFilterSession {
  session?: {
    uroFilter?: UroFilter
    uroCrawlStats?: UroCrawlStats
    [key: string]: unknown
  }
}

export interface UroCrawlStats {
  /** URLs passed to the BFS queue (URO decided to crawl) */
  kept: number
  /** URLs dropped before reaching the BFS queue */
  skipped: number
  /** Breakdown of skip reasons for debugging */
  skipReasons: {
    pseudoLink: number       // javascript:, mailto:, tel:, #anchor
    malformed: number        // URL constructor threw
    staticAsset: number      // .css .png .woff2 etc.
    localeVariant: number    // /en-gb/X when /en-us/X already seen
    contentPage: number      // /blog/slug or paginated /docs/page/2
    integerIdPage: number    // /errors/10001 pattern already seen
    paramDuplicate: number   // same path + same param keys
  }
}

// ─── UroCrawlGate class ───────────────────────────────────────────────────────

/**
 * Stateless gate object that delegates to the session-scoped UroFilter.
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

    // ── Fast-path: drop pseudo-links before URL construction ──────────────
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

    // ── Resolve relative URLs ──────────────────────────────────────────────
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

    // ── Validate URL ──────────────────────────────────────────────────────
    let parsed: URL
    try {
      parsed = new URL(absoluteUrl)
    } catch {
      stats.skipped++
      stats.skipReasons.malformed++
      return false
    }

    // ── Security override: vuln-param URLs always enqueue ─────────────────
    // UroFilter.accept() already handles this, but we check here first so we
    // can correctly attribute the kept stat before delegating.
    const paramKeys = [...parsed.searchParams.keys()]
    const isVuln = paramKeys.some(k => VULN_PARAMS.has(k))
    if (isVuln) {
      stats.kept++
      // Still call accept() to register state for non-vuln param tracking
      getSessionUroFilter(ctx).accept(absoluteUrl)
      return true
    }

    // ── Delegate full URO pipeline ─────────────────────────────────────────
    // accept() handles: static ext → path template dedup → param-key dedup
    const shouldCrawl = getSessionUroFilter(ctx).accept(absoluteUrl)

    if (shouldCrawl) {
      stats.kept++
    } else {
      stats.skipped++
      this._attributeSkipReason(parsed, stats)
    }

    return shouldCrawl
  }

  /**
   * Returns the current enqueue stats for the session.
   * Merge into map_site_bfs_status responses for LLM visibility.
   */
  stats(ctx: CrawlSessionCtx): UroCrawlStats & { seenTemplates: number; seenParamGroups: number } {
    const crawlStats = this._getOrInitStats(ctx)
    const uroStats = getSessionUroFilter(ctx).stats()
    return { ...crawlStats, ...uroStats }
  }

  /** Reset stats AND UroFilter — call when map_site_start begins a fresh crawl. */
  reset(ctx: CrawlSessionCtx): void {
    ctx.session ??= {}
    ctx.session.uroCrawlStats = this._freshStats()
    ctx.session.uroFilter = new UroFilter()
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _getOrInitStats(ctx: CrawlSessionCtx): UroCrawlStats {
    ctx.session ??= {}
    if (!ctx.session.uroCrawlStats) {
      ctx.session.uroCrawlStats = this._freshStats()
    }
    return ctx.session.uroCrawlStats as UroCrawlStats
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
   * Best-effort attribution of WHY a URL was skipped.
   * Used for the stats breakdown shown in bfs_status diagnostics.
   */
  private _attributeSkipReason(parsed: URL, stats: UroCrawlStats): void {
    const path = parsed.pathname

    // Static asset
    const ext = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? ''
    const STATIC_EXTS = new Set([
      'css','png','jpg','jpeg','svg','ico','webp','gif','woff','woff2',
      'ttf','otf','eot','pdf','mp3','mp4','avi','bmp','tiff','scss','js','map',
    ])
    if (STATIC_EXTS.has(ext)) { stats.skipReasons.staticAsset++; return }

    // Locale variant — path starts with /xx/ or /xx-xx/
    if (/^\/[a-z]{2}(-[a-z]{2})?(\/?$|\/)/i.test(path)) {
      stats.skipReasons.localeVariant++
      return
    }

    // Integer ID page — has a purely numeric segment
    if (/\/\d+([?/]|$)/.test(path)) { stats.skipReasons.integerIdPage++; return }

    // Content/blog slug
    if (/(post|blog)s?|docs|support\/|\/(\d{4}|pages?\/\d+\/)/.test(path)) {
      stats.skipReasons.contentPage++
      return
    }

    // Slug heuristic (4+ hyphens in a segment)
    if (path.split('/').some(seg => (seg.match(/-/g) ?? []).length > 3)) {
      stats.skipReasons.contentPage++
      return
    }

    // Default: param duplicate
    stats.skipReasons.paramDuplicate++
  }
}

// ─── Module-level singleton ────────────────────────────────────────────────
// Import this singleton from map-site-skill.ts.

export const uroCrawlGate = new UroCrawlGate()

/**
 * Factory helper — creates a gate scoped to a lightweight ctx object.
 * Use when you don't want to pass the full server ctx into the BFS engine.
 *
 * Usage in map_site_start:
 *   const bfsCtx: CrawlSessionCtx = { session: {} }
 *   uroCrawlGate.reset(bfsCtx)
 *
 * Usage in processBfsPage Phase 7:
 *   if (uroCrawlGate.shouldEnqueue(link, bfsCtx, url)) {
 *     state.queued.add(link)
 *     state.queue.push(link)
 *     state.depthMap.set(link, depth + 1)
 *   }
 *
 * Usage in map_site_start completion summary:
 *   uroGateStats: uroCrawlGate.stats(bfsCtx)
 */
export function createUroEnqueueGate(): UroCrawlGate {
  return new UroCrawlGate()
}

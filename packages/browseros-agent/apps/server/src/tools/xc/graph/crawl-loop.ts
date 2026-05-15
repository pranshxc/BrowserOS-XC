/**
 * crawl-loop.ts — Automated continuous crawl loop.
 *
 * Drains the two-tier CrawlQueue (mustVisit → checkOnce) sorted by score.
 * Uses VisitTracker for stall detection — when 50 consecutive pages yield
 * zero new URLs, auto-triggers sitemap.xml/robots.txt fetch via recover_stall.
 *
 * The loop runs until:
 *   - Queue is exhausted (both tiers empty)
 *   - maxPages limit reached
 *   - maxDepth limit reached
 *   - Stall recovery fails to find new URLs
 *   - Manual stop requested
 */

import type { BrowserInterface } from './extraction-engine'
import type { MapperSession } from './mapper-session'
import {
  addFrontierItems,
  markVisited,
  popNextQueueItem,
} from './mapper-session'
import type {
  CrawlLoopResult,
  CrawlLoopState,
  CrawlTier,
  DiscoverySource,
  QueueItem,
} from './page-signals'
import { fetchDiscoveryUrls } from './sitemap-fetcher'

export interface CrawlLoopOptions {
  /** Max pages to visit in this loop run (default: session maxPages) */
  maxPages?: number
  /** Max depth for discovered URLs (default: session maxDepth) */
  maxDepth?: number
  /** Stall threshold — consecutive empty pages before recovery (default: 50) */
  stallThreshold?: number
  /** Max stall recovery attempts before giving up (default: 3) */
  maxStallRecoveries?: number
  /** Callback for each page visited — for progress reporting */
  onPageVisited?: (url: string, tier: CrawlTier, urlsFound: number) => void
  /** Callback when stall is detected */
  onStallDetected?: (consecutiveEmpty: number) => void
  /** Callback when stall recovery runs */
  onStallRecovery?: (urlsFound: number) => void
  /** Signal to stop the loop externally */
  stopSignal?: { stopped: boolean }
}

const DEFAULT_STALL_THRESHOLD = 50
const DEFAULT_MAX_STALL_RECOVERIES = 3

/**
 * Per-page visit result from the visit function callback.
 */
export interface VisitResult {
  urlCount: number
  depth: number
}

/**
 * Visit function signature — called for each URL popped from the queue.
 * Should navigate to the URL, extract signals, enqueue discovered links,
 * and return the count of new URLs discovered.
 */
export type VisitFn = (
  url: string,
  browser: BrowserInterface,
  session: MapperSession,
) => Promise<VisitResult>

export class CrawlLoop {
  private state: CrawlLoopState = {
    phase: 'mustVisit',
    mustVisitRemaining: 0,
    checkOnceRemaining: 0,
    pagesVisited: 0,
    consecutiveEmptyPages: 0,
    stallRecoveryAttempted: false,
    stallRecoveryCount: 0,
  }

  private errors: Array< url: string; message: string }> = []
  private stallRecoveryUrls: string[] = []
  private totalUrlsDiscovered = 0

  /**
   * Run the automated crawl loop until the queue is exhausted or limits are hit.
   */
  async run(
    session: MapperSession,
    browser: BrowserInterface,
    visitFn: VisitFn,
    options: CrawlLoopOptions = {},
  ): Promise<CrawlLoopResult> {
    const {
      maxPages = session.maxPages,
      maxDepth = session.maxDepth,
      stallThreshold = DEFAULT_STALL_THRESHOLD,
      maxStallRecoveries = DEFAULT_MAX_STALL_RECOVERIES,
      onPageVisited,
      onStallDetected,
      onStallRecovery,
      stopSignal,
    } = options

    this.reset()

    while (true) {
      // Check stop signal
      if (stopSignal?.stopped) {
        return this.buildResult('manual_stop')
      }

      // Check page limit
      if (this.state.pagesVisited >= maxPages) {
        return this.buildResult('max_pages_reached')
      }

      // Update phase based on queue state
      this.updatePhase(session)

      // If queue is empty, we're done
      if (this.state.phase === 'done') {
        return this.buildResult('queue_exhausted')
      }

      // Check for stall before popping
      if (this.state.phase === 'stalled') {
        const recovered = await this.attemptStallRecovery(
          session,
          browser,
          stallThreshold,
          maxStallRecoveries,
          onStallDetected,
          onStallRecovery,
        )

        if (!recovered) {
          return this.buildResult('stall_unrecoverable')
        }
        // After recovery, re-check phase and continue
        continue
      }

      // Pop next item from queue
      const item = popNextQueueItem(session)
      if (!item) {
        this.updatePhase(session)
        continue
      }

      // Check depth limit
      const depth = session.depthMap.get(item.url) ?? 0
      if (depth > maxDepth) {
        continue
      }

      // Visit the page
      try {
        const result = await visitFn(item.url, browser, session)
        const urlCount = result.urlCount

        markVisited(session, item.url, result.depth, item.tier, urlCount)

        this.state.pagesVisited++
        this.totalUrlsDiscovered += urlCount

        // Track consecutive empty pages
        if (urlCount === 0) {
          this.state.consecutiveEmptyPages++
        } else {
          this.state.consecutiveEmptyPages = 0
        }

        onPageVisited?.(item.url, item.tier, urlCount)

        // Check stall threshold
        if (this.state.consecutiveEmptyPages >= stallThreshold) {
          this.state.phase = 'stalled'
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.errors.push({ url: item.url, message })
        // Mark as visited anyway to avoid re-queuing
        markVisited(session, item.url, depth, item.tier, 0)
        this.state.pagesVisited++
        this.state.consecutiveEmptyPages++
      }
    }
  }

  private updatePhase(session: MapperSession): void {
    const stats = session.queue.stats
    this.state.mustVisitRemaining = stats.mustVisitSize
    this.state.checkOnceRemaining = stats.checkOnceSize

    if (stats.mustVisitSize > 0) {
      this.state.phase = 'mustVisit'
    } else if (stats.checkOnceSize > 0) {
      this.state.phase = 'checkOnce'
    } else {
      this.state.phase = 'done'
    }
  }

  private async attemptStallRecovery(
    session: MapperSession,
    browser: BrowserInterface,
    _stallThreshold: number,
    maxStallRecoveries: number,
    onStallDetected?: (consecutiveEmpty: number) => void,
    onStallRecovery?: (urlsFound: number) => void,
  ): Promise<boolean> {
    if (this.state.stallRecoveryCount >= maxStallRecoveries) {
      return false
    }

    onStallDetected?.(this.state.consecutiveEmptyPages)

    try {
      const result = await fetchDiscoveryUrls(session.rootUrl, browser)
      const allUrls = [...result.sitemapUrls, ...result.robotsUrls]
      const uniqueUrls = [...new Set(allUrls)]

      if (uniqueUrls.length === 0) {
        this.state.stallRecoveryCount++
        this.state.stallRecoveryAttempted = true
        return false
      }

      // Add discovered URLs to queue as checkOnce — LLM can promote via xc_frontier
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
      this.stallRecoveryUrls.push(...uniqueUrls)
      this.state.stallRecoveryCount++
      this.state.stallRecoveryAttempted = true
      this.state.consecutiveEmptyPages = 0

      onStallRecovery?.(added)

      // Re-check phase after adding items
      this.updatePhase(session)

      return added > 0
    } catch {
      this.state.stallRecoveryCount++
      this.state.stallRecoveryAttempted = true
      return false
    }
  }

  private buildResult(
    stopReason: CrawlLoopResult['stopReason'],
  ): CrawlLoopResult {
    return {
      finalState: { ...this.state },
      totalPagesVisited: this.state.pagesVisited,
      totalUrlsDiscovered: this.totalUrlsDiscovered,
      stopReason,
      stallRecoveryUrls: [...this.stallRecoveryUrls],
      errors: [...this.errors],
    }
  }

  private reset(): void {
    this.state = {
      phase: 'mustVisit',
      mustVisitRemaining: 0,
      checkOnceRemaining: 0,
      pagesVisited: 0,
      consecutiveEmptyPages: 0,
      stallRecoveryAttempted: false,
      stallRecoveryCount: 0,
    }
    this.errors = []
    this.stallRecoveryUrls = []
    this.totalUrlsDiscovered = 0
  }

  getState(): CrawlLoopState {
    return { ...this.state }
  }
}

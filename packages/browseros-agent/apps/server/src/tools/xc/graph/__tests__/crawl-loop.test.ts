import { describe, it, expect, beforeEach } from 'bun:test'
import { CrawlQueue } from '../crawl-queue'
import { VisitTracker } from '../visit-tracker'
import type { FrontierItem } from '../page-signals'

describe('CrawlQueue', () => {
  let queue: CrawlQueue

  beforeEach(() => {
    queue = new CrawlQueue()
  })

  describe('tier ordering', () => {
    it('drains mustVisit before checkOnce regardless of score', () => {
      const lowPriorityMust: FrontierItem = {
        url: 'https://example.com/admin',
        suggestedScore: 10,
        reasoning: 'admin panel',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: 'https://example.com',
        type: 'route',
      }
      const highPriorityCheck: FrontierItem = {
        url: 'https://example.com/blog/post-1',
        suggestedScore: 90,
        reasoning: 'popular blog post',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: 'https://example.com',
        type: 'route',
      }

      queue.addMustVisit(lowPriorityMust, 'link')
      queue.addCheckOnce(highPriorityCheck, 'link')

      const first = queue.popNext()
      const second = queue.popNext()

      expect(first?.url).toBe('https://example.com/admin')
      expect(first?.tier).toBe('mustVisit')
      expect(second?.url).toBe('https://example.com/blog/post-1')
      expect(second?.tier).toBe('checkOnce')
    })

    it('sorts items within each tier by score descending', () => {
      const item1: FrontierItem = {
        url: 'https://example.com/low',
        suggestedScore: 30,
        reasoning: '',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }
      const item2: FrontierItem = {
        url: 'https://example.com/high',
        suggestedScore: 90,
        reasoning: '',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }
      const item3: FrontierItem = {
        url: 'https://example.com/mid',
        suggestedScore: 60,
        reasoning: '',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }

      queue.addCheckOnce(item1, 'link')
      queue.addCheckOnce(item2, 'link')
      queue.addCheckOnce(item3, 'link')

      expect(queue.popNext()?.url).toBe('https://example.com/high')
      expect(queue.popNext()?.url).toBe('https://example.com/mid')
      expect(queue.popNext()?.url).toBe('https://example.com/low')
    })

    it('returns undefined when queue is empty', () => {
      expect(queue.popNext()).toBeUndefined()
    })

    it('peekNext returns highest priority without removing', () => {
      const item: FrontierItem = {
        url: 'https://example.com/page',
        suggestedScore: 50,
        reasoning: '',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }
      queue.addCheckOnce(item, 'link')
      expect(queue.peekNext()?.url).toBe('https://example.com/page')
      expect(queue.stats.checkOnceSize).toBe(1)
    })
  })

  describe('deduplication', () => {
    it('rejects duplicate URLs', () => {
      const item: FrontierItem = {
        url: 'https://example.com/page',
        suggestedScore: 50,
        reasoning: '',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }

      const first = queue.addCheckOnce(item, 'link')
      const second = queue.addCheckOnce(item, 'link')

      expect(first).toBe(true)
      expect(second).toBe(false)
      expect(queue.stats.totalSeen).toBe(1)
    })

    it('rejects URLs across tiers', () => {
      const item: FrontierItem = {
        url: 'https://example.com/page',
        suggestedScore: 50,
        reasoning: '',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }

      queue.addMustVisit(item, 'link')
      const second = queue.addCheckOnce(item, 'link')

      expect(second).toBe(false)
      expect(queue.stats.totalSeen).toBe(1)
    })
  })

  describe('promote/demote', () => {
    it('promotes checkOnce item to mustVisit', () => {
      const item: FrontierItem = {
        url: 'https://example.com/page',
        suggestedScore: 50,
        reasoning: '',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }
      queue.addCheckOnce(item, 'link')
      expect(queue.promoteToMustVisit('https://example.com/page')).toBe(true)
      expect(queue.stats.mustVisitSize).toBe(1)
      expect(queue.stats.checkOnceSize).toBe(0)
    })

    it('demotes mustVisit item to checkOnce', () => {
      const item: FrontierItem = {
        url: 'https://example.com/page',
        suggestedScore: 50,
        reasoning: '',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }
      queue.addMustVisit(item, 'link')
      expect(queue.demoteToCheckOnce('https://example.com/page')).toBe(true)
      expect(queue.stats.mustVisitSize).toBe(0)
      expect(queue.stats.checkOnceSize).toBe(1)
    })
  })

  describe('serialization', () => {
    it('survives round-trip serialization', () => {
      const item1: FrontierItem = {
        url: 'https://example.com/admin',
        suggestedScore: 95,
        reasoning: 'admin',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }
      const item2: FrontierItem = {
        url: 'https://example.com/blog',
        suggestedScore: 30,
        reasoning: 'blog',
        assumptions: [],
        signals: {},
        discoveredAt: Date.now(),
        sourceUrl: '',
        type: 'route',
      }

      queue.addMustVisit(item1, 'link')
      queue.addCheckOnce(item2, 'link')

      const serialized = queue.serialize()
      const restored = CrawlQueue.deserialize(serialized)

      expect(restored.stats.mustVisitSize).toBe(1)
      expect(restored.stats.checkOnceSize).toBe(1)
      expect(restored.popNext()?.url).toBe('https://example.com/admin')
      expect(restored.popNext()?.url).toBe('https://example.com/blog')
    })
  })
})

describe('VisitTracker', () => {
  let tracker: VisitTracker

  beforeEach(() => {
    tracker = new VisitTracker()
  })

  describe('stall detection', () => {
    it('detects stall after 50 consecutive empty pages', () => {
      for (let i = 0; i < 50; i++) {
        tracker.markVisited(`https://example.com/page-${i}`, 'checkOnce', 0)
      }

      const status = tracker.isStalled(50)
      expect(status.isStalled).toBe(true)
      expect(status.consecutiveEmptyPages).toBe(50)
    })

    it('does not detect stall when pages have URLs', () => {
      for (let i = 0; i < 49; i++) {
        tracker.markVisited(`https://example.com/page-${i}`, 'checkOnce', 0)
      }
      tracker.markVisited('https://example.com/page-49', 'checkOnce', 5)

      const status = tracker.isStalled(50)
      expect(status.isStalled).toBe(false)
    })

    it('resets consecutive count when a page yields URLs', () => {
      for (let i = 0; i < 30; i++) {
        tracker.markVisited(`https://example.com/page-${i}`, 'checkOnce', 0)
      }
      tracker.markVisited('https://example.com/page-30', 'checkOnce', 3)

      const consecutive = tracker.getConsecutiveEmptyPages()
      expect(consecutive).toBe(0)
    })

    it('uses custom threshold', () => {
      for (let i = 0; i < 10; i++) {
        tracker.markVisited(`https://example.com/page-${i}`, 'checkOnce', 0)
      }

      expect(tracker.isStalled(50).isStalled).toBe(false)
      expect(tracker.isStalled(10).isStalled).toBe(true)
    })
  })

  describe('visit tracking', () => {
    it('tracks total visited and URLs discovered', () => {
      tracker.markVisited('https://example.com/a', 'mustVisit', 10)
      tracker.markVisited('https://example.com/b', 'checkOnce', 5)
      tracker.markVisited('https://example.com/c', 'checkOnce', 0)

      const stats = tracker.getStats()
      expect(stats.totalVisited).toBe(3)
      expect(stats.mustVisitedCount).toBe(1)
      expect(stats.checkOnceCount).toBe(2)
      expect(stats.totalUrlsDiscovered).toBe(15)
    })

    it('prevents duplicate visits', () => {
      tracker.markVisited('https://example.com/a', 'checkOnce', 5)
      expect(tracker.isVisited('https://example.com/a')).toBe(true)
      expect(tracker.isVisited('https://example.com/b')).toBe(false)
    })

    it('calculates average URLs per page', () => {
      tracker.markVisited('https://example.com/a', 'checkOnce', 10)
      tracker.markVisited('https://example.com/b', 'checkOnce', 20)

      const stats = tracker.getStats()
      expect(stats.avgUrlsPerPage).toBe(15)
    })
  })

  describe('discovery history', () => {
    it('returns recent discovery counts', () => {
      tracker.markVisited('https://example.com/a', 'checkOnce', 3)
      tracker.markVisited('https://example.com/b', 'checkOnce', 0)
      tracker.markVisited('https://example.com/c', 'checkOnce', 7)

      const recent = tracker.getRecentDiscoveryCounts(2)
      expect(recent).toEqual([0, 7])
    })

    it('returns URLs sorted by discovery count', () => {
      tracker.markVisited('https://example.com/low', 'checkOnce', 2)
      tracker.markVisited('https://example.com/high', 'checkOnce', 10)
      tracker.markVisited('https://example.com/mid', 'checkOnce', 5)

      const sorted = tracker.getUrlsByDiscoveryCount()
      expect(sorted[0].url).toBe('https://example.com/high')
      expect(sorted[0].count).toBe(10)
      expect(sorted[2].url).toBe('https://example.com/low')
      expect(sorted[2].count).toBe(2)
    })
  })

  describe('serialization', () => {
    it('survives round-trip serialization', () => {
      tracker.markVisited('https://example.com/a', 'mustVisit', 5)
      tracker.markVisited('https://example.com/b', 'checkOnce', 3)

      const serialized = tracker.serialize()
      const restored = VisitTracker.deserialize(serialized)

      expect(restored.getStats().totalVisited).toBe(2)
      expect(restored.isVisited('https://example.com/a')).toBe(true)
      expect(restored.isVisited('https://example.com/b')).toBe(true)
    })
  })
})

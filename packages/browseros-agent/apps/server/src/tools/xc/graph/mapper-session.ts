/**
 * mapper-session.ts — Mapper session state that persists across xc_step calls.
 *
 * The graph store (store.ts) persists nodes/edges to disk.
 * This module stores the frontier, visited set, auth tracking, and stats.
 * Checkpoint files (.mapper.json) enable crash recovery.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CrawlQueue } from './crawl-queue'
import type {
  CrawlTier,
  DiscoverySource,
  FrontierItem,
  PageSignals,
  QueueItem,
} from './page-signals'
import { getOrCreateSession } from './store'
import { UroFilter } from './uro-filter'
import { DEFAULT_STALL_THRESHOLD, VisitTracker } from './visit-tracker'

const MAX_OPEN_PAGES = 10

export interface AuthBlockedPage {
  url: string
  detectedAt: number
  signals: Record<string, unknown>
  depth: number
}

export interface MapperSession {
  sessionId: string
  rootUrl: string
  rootDomain: string

  queue: CrawlQueue
  visitTracker: VisitTracker

  visited: Set<string>
  depthMap: Map<string, number>

  authBlockedPages: AuthBlockedPage[]
  savedAuthStateName: string | null
  isAuthenticated: boolean

  pagesVisited: number
  interactionsExecuted: number
  startedAt: number
  lastActionAt: number

  maxPages: number
  maxDepth: number

  openPages: Map<string, number>
  uroFilter: UroFilter

  /** Raw PageSignals from the seed URL — stored by startMapping for handler use. */
  _initialSignals?: PageSignals
}

const sessions = new Map<string, MapperSession>()

export function createSession(opts: {
  sessionId: string
  rootUrl: string
  rootDomain: string
  maxPages?: number
  maxDepth?: number
}): MapperSession {
  const session: MapperSession = {
    sessionId: opts.sessionId,
    rootUrl: opts.rootUrl,
    rootDomain: opts.rootDomain,
    queue: new CrawlQueue(),
    visitTracker: new VisitTracker(),
    visited: new Set(),
    depthMap: new Map(),
    authBlockedPages: [],
    savedAuthStateName: null,
    isAuthenticated: false,
    pagesVisited: 0,
    interactionsExecuted: 0,
    startedAt: Date.now(),
    lastActionAt: Date.now(),
    maxPages: opts.maxPages ?? 50,
    maxDepth: opts.maxDepth ?? 3,
    openPages: new Map(),
    uroFilter: new UroFilter(),
  }
  sessions.set(opts.sessionId, session)
  return session
}

export function getSession(sessionId: string): MapperSession | undefined {
  return sessions.get(sessionId)
}

export function addFrontierItems(
  session: MapperSession,
  items: QueueItem[],
): number {
  const added = session.queue.addBatch(
    items.filter((item) => !session.visited.has(item.url)),
  )
  session.lastActionAt = Date.now()
  return added
}

export function addFrontierItem(
  session: MapperSession,
  item: FrontierItem,
  tier: CrawlTier = 'checkOnce',
  source: DiscoverySource = 'link',
): boolean {
  if (session.visited.has(item.url)) return false

  const added =
    tier === 'mustVisit'
      ? session.queue.addMustVisit(item, source)
      : session.queue.addCheckOnce(item, source)

  if (added) {
    session.lastActionAt = Date.now()
  }
  return added
}

export function removeFrontierItem(
  session: MapperSession,
  url: string,
): boolean {
  const removed = session.queue.remove(url)
  if (removed) {
    session.lastActionAt = Date.now()
  }
  return removed
}

export function popNextFrontierItem(): QueueItem | undefined {
  return undefined
}

export function popNextQueueItem(
  session: MapperSession,
): QueueItem | undefined {
  const item = session.queue.popNext()
  if (item) {
    session.lastActionAt = Date.now()
  }
  return item
}

export function markVisited(
  session: MapperSession,
  url: string,
  depth: number,
  tier: CrawlTier = 'checkOnce',
  urlCount: number = 0,
): void {
  session.visited.add(url)
  session.depthMap.set(url, depth)
  session.pagesVisited++
  session.visitTracker.markVisited(url, tier, urlCount)
  session.lastActionAt = Date.now()
}

export function getStallStatus(
  session: MapperSession,
  threshold: number = DEFAULT_STALL_THRESHOLD,
) {
  return session.visitTracker.isStalled(threshold)
}

export function addAuthBlockedPage(
  session: MapperSession,
  page: AuthBlockedPage,
): void {
  if (session.authBlockedPages.some((p) => p.url === page.url)) return
  session.authBlockedPages.push(page)
}

export function markAuthenticated(
  session: MapperSession,
  savedStateName?: string,
): AuthBlockedPage[] {
  session.isAuthenticated = true
  if (savedStateName) session.savedAuthStateName = savedStateName
  const blocked = [...session.authBlockedPages]
  session.authBlockedPages = []
  session.lastActionAt = Date.now()
  return blocked
}

export function getSessionStats(session: MapperSession) {
  const queueStats = session.queue.stats
  const stallStatus = session.visitTracker.isStalled()
  return {
    sessionId: session.sessionId,
    rootUrl: session.rootUrl,
    rootDomain: session.rootDomain,
    pagesVisited: session.pagesVisited,
    interactionsExecuted: session.interactionsExecuted,
    frontierSize: queueStats.mustVisitSize + queueStats.checkOnceSize,
    mustVisitSize: queueStats.mustVisitSize,
    checkOnceSize: queueStats.checkOnceSize,
    visitedSize: session.visited.size,
    authBlockedCount: session.authBlockedPages.length,
    isAuthenticated: session.isAuthenticated,
    savedAuthStateName: session.savedAuthStateName,
    startedAt: session.startedAt,
    lastActionAt: session.lastActionAt,
    maxPages: session.maxPages,
    maxDepth: session.maxDepth,
    stallStatus: {
      isStalled: stallStatus.isStalled,
      consecutiveEmptyPages: stallStatus.consecutiveEmptyPages,
      threshold: stallStatus.threshold,
    },
  }
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId)
}

export function setOpenPage(
  session: MapperSession,
  url: string,
  pageId: number,
): void {
  // Evict oldest pages if we exceed the cap
  while (session.openPages.size >= MAX_OPEN_PAGES) {
    const oldest = session.openPages.keys().next().value
    if (oldest !== undefined) {
      session.openPages.delete(oldest)
    }
  }
  session.openPages.set(url, pageId)
  session.lastActionAt = Date.now()
}

export function getOpenPage(
  session: MapperSession,
  url: string,
): number | undefined {
  return session.openPages.get(url)
}

export function removeOpenPage(session: MapperSession, url: string): void {
  session.openPages.delete(url)
  session.lastActionAt = Date.now()
}

// ─── Crash Recovery Checkpoint ─────────────────────────────────────────────

export interface MapperSessionCheckpoint {
  sessionId: string
  rootUrl: string
  rootDomain: string
  queueState: string
  visitTrackerState: string
  visited: string[]
  depthMap: [string, number][]
  authBlockedPages: AuthBlockedPage[]
  savedAuthStateName: string | null
  isAuthenticated: boolean
  pagesVisited: number
  interactionsExecuted: number
  startedAt: number
  lastActionAt: number
  maxPages: number
  maxDepth: number
  uroFilterState: string
}

async function getCheckpointDir(): Promise<string> {
  const homeDir = join(homedir(), '.browseros', 'mapper-checkpoints')
  const cwdDir = join(process.cwd(), 'mapper-checkpoints')
  await mkdir(homeDir, { recursive: true }).catch(() => {})
  await mkdir(cwdDir, { recursive: true }).catch(() => {})
  return homeDir
}

function getCheckpointFileName(sessionId: string): string {
  return `${sessionId}.mapper.json`
}

export async function saveMapperCheckpoint(
  session: MapperSession,
): Promise<void> {
  const checkpoint: MapperSessionCheckpoint = {
    sessionId: session.sessionId,
    rootUrl: session.rootUrl,
    rootDomain: session.rootDomain,
    queueState: session.queue.serialize(),
    visitTrackerState: session.visitTracker.serialize(),
    visited: [...session.visited],
    depthMap: [...session.depthMap.entries()],
    authBlockedPages: session.authBlockedPages,
    savedAuthStateName: session.savedAuthStateName,
    isAuthenticated: session.isAuthenticated,
    pagesVisited: session.pagesVisited,
    interactionsExecuted: session.interactionsExecuted,
    startedAt: session.startedAt,
    lastActionAt: session.lastActionAt,
    maxPages: session.maxPages,
    maxDepth: session.maxDepth,
    uroFilterState: session.uroFilter.serialize(),
  }

  const dir = await getCheckpointDir()
  const fileName = getCheckpointFileName(session.sessionId)
  const tmpPath = join(dir, `${fileName}.tmp`)
  const finalPath = join(dir, fileName)

  await writeFile(tmpPath, JSON.stringify(checkpoint, null, 2))
  await rename(tmpPath, finalPath)
}

export async function loadMapperCheckpoint(
  sessionId: string,
): Promise<MapperSessionCheckpoint | null> {
  const homeDir = join(homedir(), '.browseros', 'mapper-checkpoints')
  const cwdDir = join(process.cwd(), 'mapper-checkpoints')
  const fileName = getCheckpointFileName(sessionId)

  let content: string
  try {
    content = await readFile(join(homeDir, fileName), 'utf-8')
  } catch {
    try {
      content = await readFile(join(cwdDir, fileName), 'utf-8')
    } catch {
      return null
    }
  }

  return JSON.parse(content) as MapperSessionCheckpoint
}

export async function resumeMapperSession(
  sessionId: string,
): Promise<MapperSession | null> {
  const checkpoint = await loadMapperCheckpoint(sessionId)
  if (!checkpoint) return null

  // Rebuild sets and maps from serialized data
  const visited = new Set(checkpoint.visited)
  const depthMap = new Map(checkpoint.depthMap)
  const uroFilter = UroFilter.deserialize(checkpoint.uroFilterState)
  const openPages = new Map<string, number>()
  const queue = CrawlQueue.deserialize(checkpoint.queueState)
  const visitTracker = VisitTracker.deserialize(checkpoint.visitTrackerState)

  // Re-ensure the graph session is loaded
  await getOrCreateSession(sessionId)

  const session: MapperSession = {
    sessionId: checkpoint.sessionId,
    rootUrl: checkpoint.rootUrl,
    rootDomain: checkpoint.rootDomain,
    queue,
    visitTracker,
    visited,
    depthMap,
    authBlockedPages: checkpoint.authBlockedPages,
    savedAuthStateName: checkpoint.savedAuthStateName,
    isAuthenticated: checkpoint.isAuthenticated,
    pagesVisited: checkpoint.pagesVisited,
    interactionsExecuted: checkpoint.interactionsExecuted,
    startedAt: checkpoint.startedAt,
    lastActionAt: checkpoint.lastActionAt,
    maxPages: checkpoint.maxPages,
    maxDepth: checkpoint.maxDepth,
    openPages,
    uroFilter,
  }

  sessions.set(sessionId, session)
  return session
}

export async function deleteMapperCheckpoint(sessionId: string): Promise<void> {
  const homeDir = join(homedir(), '.browseros', 'mapper-checkpoints')
  const cwdDir = join(process.cwd(), 'mapper-checkpoints')
  const fileName = getCheckpointFileName(sessionId)

  await Promise.all([
    import('node:fs/promises').then((fs) =>
      fs.unlink(join(homeDir, fileName)).catch(() => {}),
    ),
    import('node:fs/promises').then((fs) =>
      fs.unlink(join(cwdDir, fileName)).catch(() => {}),
    ),
  ])
}

export async function listCheckpoints(): Promise<string[]> {
  const homeDir = join(homedir(), '.browseros', 'mapper-checkpoints')
  const cwdDir = join(process.cwd(), 'mapper-checkpoints')

  const readDir = async (dir: string): Promise<string[]> => {
    try {
      const files = await import('node:fs/promises').then((fs) =>
        fs.readdir(dir),
      )
      return files
        .filter((f) => f.endsWith('.mapper.json'))
        .map((f) => f.replace('.mapper.json', ''))
    } catch {
      return []
    }
  }

  const home = await readDir(homeDir)
  const cwd = await readDir(cwdDir)
  return [...new Set([...home, ...cwd])]
}

/**
 * Try to resume the most recently modified mapper session from a checkpoint.
 *
 * Scans all checkpoint files, picks the one with the newest lastActionAt,
 * and attempts to restore it. Returns null if no checkpoints exist or
 * restoration fails.
 *
 * This is the primary crash-recovery entry point — call it at startup
 * after a crash to pick up where the crawl left off.
 */
export async function tryResumeLastSession(): Promise<MapperSession | null> {
  const checkpointIds = await listCheckpoints()
  if (checkpointIds.length === 0) return null

  // Load all checkpoints to find the most recent one
  let newestCheckpoint: MapperSessionCheckpoint | null = null
  let newestId = ''

  for (const id of checkpointIds) {
    const cp = await loadMapperCheckpoint(id)
    if (cp && (!newestCheckpoint || cp.lastActionAt > newestCheckpoint.lastActionAt)) {
      newestCheckpoint = cp
      newestId = id
    }
  }

  if (!newestCheckpoint) return null

  return resumeMapperSession(newestId)
}

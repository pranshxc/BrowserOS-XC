import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createSession,
  saveMapperCheckpoint,
  deleteMapperCheckpoint,
  tryResumeLastSession,
  deleteSession,
} from '../../src/tools/xc/graph/mapper-session'

const TEST_CHECKPOINT_DIR = join(homedir(), '.browseros', 'mapper-checkpoints')

describe('tryResumeLastSession', () => {
  const sessionId1 = 'test-resume-session-1'
  const sessionId2 = 'test-resume-session-2'

  beforeEach(async () => {
    await mkdir(TEST_CHECKPOINT_DIR, { recursive: true })
  })

  afterEach(async () => {
    deleteSession(sessionId1)
    deleteSession(sessionId2)
    await deleteMapperCheckpoint(sessionId1).catch(() => {})
    await deleteMapperCheckpoint(sessionId2).catch(() => {})
  })

  it('returns null when no checkpoints exist', async () => {
    const result = await tryResumeLastSession()
    expect(result).toBeNull()
  })

  it('resumes the only available session', async () => {
    const session = createSession({
      sessionId: sessionId1,
      rootUrl: 'https://example.com',
      rootDomain: 'example.com',
    })
    session.pagesVisited = 5
    await saveMapperCheckpoint(session)

    const resumed = await tryResumeLastSession()
    expect(resumed).not.toBeNull()
    expect(resumed!.sessionId).toBe(sessionId1)
    expect(resumed!.pagesVisited).toBe(5)
    expect(resumed!.rootUrl).toBe('https://example.com')
  })

  it('resumes the most recently modified session when multiple checkpoints exist', async () => {
    // Create older session
    const session1 = createSession({
      sessionId: sessionId1,
      rootUrl: 'https://older.example.com',
      rootDomain: 'older.example.com',
    })
    session1.pagesVisited = 3
    session1.lastActionAt = Date.now() - 10000
    await saveMapperCheckpoint(session1)

    // Create newer session
    const session2 = createSession({
      sessionId: sessionId2,
      rootUrl: 'https://newer.example.com',
      rootDomain: 'newer.example.com',
    })
    session2.pagesVisited = 10
    session2.lastActionAt = Date.now()
    await saveMapperCheckpoint(session2)

    const resumed = await tryResumeLastSession()
    expect(resumed).not.toBeNull()
    expect(resumed!.sessionId).toBe(sessionId2)
    expect(resumed!.pagesVisited).toBe(10)
    expect(resumed!.rootUrl).toBe('https://newer.example.com')
  })

  it('preserves visited set and depth map after resume', async () => {
    const session = createSession({
      sessionId: sessionId1,
      rootUrl: 'https://example.com',
      rootDomain: 'example.com',
    })
    session.visited.add('https://example.com/page1')
    session.visited.add('https://example.com/page2')
    session.depthMap.set('https://example.com/page1', 1)
    session.depthMap.set('https://example.com/page2', 2)
    await saveMapperCheckpoint(session)

    const resumed = await tryResumeLastSession()
    expect(resumed).not.toBeNull()
    expect(resumed!.visited.has('https://example.com/page1')).toBe(true)
    expect(resumed!.visited.has('https://example.com/page2')).toBe(true)
    expect(resumed!.depthMap.get('https://example.com/page1')).toBe(1)
    expect(resumed!.depthMap.get('https://example.com/page2')).toBe(2)
  })
})

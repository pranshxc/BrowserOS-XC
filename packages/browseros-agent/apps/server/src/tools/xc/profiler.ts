/**
 * XC Phase 8 — V8 CPU Profiler & Heap Snapshot
 *
 * Tools exported:
 *   start_js_profiler   — begin V8 CPU sampling profiler
 *   stop_js_profiler    — stop profiler, collect V8 Profile, optionally save
 *   summarize_profile   — parse profile and return top-N functions by CPU time
 *   get_heap_snapshot   — take a heap snapshot, return top constructors by count
 *
 * Architecture
 * ────────────
 * CDP Profiler.start / Profiler.stop operate on a per-target basis.
 * The profile returned by Profiler.stop is a V8 CPU profile object:
 *   { nodes: CallFrame[], startTime, endTime, samples, timeDeltas }
 * where nodes form a call tree via parentId links.
 *
 * summarize_profile walks the call tree to compute self-time per node,
 * then aggregates by function name+url to produce the hot-function list.
 *
 * Heap snapshot: HeapProfiler.takeHeapSnapshot fires multiple
 * HeapProfiler.addHeapSnapshotChunk events containing a fragmented
 * JSON string. We concatenate and parse to get the snapshot.
 * Object counts per constructor name are extracted from the snapshot
 * nodes without full graph traversal (fast and sufficient for
 * feature discovery purposes).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('performance')

// ── Types ─────────────────────────────────────────────────────────────────

interface V8ProfileNode {
  id: number
  callFrame: {
    functionName: string
    scriptId: string
    url: string
    lineNumber: number
    columnNumber: number
  }
  hitCount?: number
  children?: number[]
  positionTicks?: Array<{ line: number; ticks: number }>
}

interface V8Profile {
  nodes: V8ProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

interface ProfilerState {
  recording: boolean
  profile: V8Profile | null
}

const PAGE_PROFILER: Map<number, ProfilerState> = new Map()

function getOrCreateProfiler(pageId: number): ProfilerState {
  if (!PAGE_PROFILER.has(pageId)) {
    PAGE_PROFILER.set(pageId, { recording: false, profile: null })
  }
  return PAGE_PROFILER.get(pageId)!
}

type CdpSession = {
  Profiler: {
    enable: () => Promise<void>
    disable: () => Promise<void>
    start: () => Promise<void>
    stop: () => Promise<{ profile: V8Profile }>
    setSamplingInterval: (p: { interval: number }) => Promise<void>
  }
  HeapProfiler: {
    enable: () => Promise<void>
    disable: () => Promise<void>
    takeHeapSnapshot: (p?: { reportProgress?: boolean; captureNumericValue?: boolean }) => Promise<void>
    on: (event: string, cb: (params: unknown) => void) => () => void
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

export const start_js_profiler = defineXcTool({
  name: 'start_js_profiler',
  description:
    'Start the V8 CPU sampling profiler on a page. ' +
    'The profiler samples the call stack at a configurable interval. ' +
    'After starting, interact with the page, then call stop_js_profiler to collect the profile, ' +
    'followed by summarize_profile to see which JS functions are consuming CPU.',
  input: z.object({
    page: pageParam,
    samplingIntervalUs: z
      .number()
      .default(100)
      .describe('Sampling interval in microseconds (default 100 = 10kHz sampling)'),
  }),
  output: z.object({ recording: z.boolean() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateProfiler(args.page)
    if (state.recording) {
      response.error('Profiler already running. Call stop_js_profiler first.')
      return
    }

    const cdp = session as unknown as CdpSession
    await cdp.Profiler.enable()
    await cdp.Profiler.setSamplingInterval({ interval: args.samplingIntervalUs ?? 100 })
    await cdp.Profiler.start()
    state.recording = true
    state.profile = null

    response.text('JS profiler started. Interact with the page, then call stop_js_profiler().')
    response.data({ recording: true })
  },
})

export const stop_js_profiler = defineXcTool({
  name: 'stop_js_profiler',
  description:
    'Stop the V8 CPU profiler and collect the profile. ' +
    'Optionally save the raw V8 .cpuprofile JSON (loadable in Chrome DevTools → Performance tab). ' +
    'Call summarize_profile to get a human-readable hot-function breakdown.',
  input: z.object({
    page: pageParam,
    outputPath: z
      .string()
      .optional()
      .describe('Optional path to save raw .cpuprofile JSON (e.g. /tmp/profile.cpuprofile)'),
  }),
  output: z.object({
    nodeCount: z.number(),
    durationMs: z.number(),
    savedTo: z.string().optional(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateProfiler(args.page)
    if (!state.recording) {
      response.error('No profiler running. Call start_js_profiler first.')
      return
    }

    const cdp = session as unknown as CdpSession
    const { profile } = await cdp.Profiler.stop()
    state.recording = false
    state.profile = profile

    const durationMs = Math.round((profile.endTime - profile.startTime) / 1000)
    let savedTo: string | undefined

    if (args.outputPath) {
      try {
        const dir = path.dirname(args.outputPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(args.outputPath, JSON.stringify(profile, null, 2), 'utf8')
        savedTo = args.outputPath
      } catch (e) {
        response.error(`Failed to save profile: ${(e as Error).message}`)
        return
      }
    }

    response.text(
      `Profiler stopped. ${profile.nodes.length} call nodes, ${durationMs}ms duration.\n` +
      (savedTo ? `Saved to: ${savedTo}\n` : '') +
      `Call summarize_profile({ page: ${args.page} }) for the hot-function breakdown.`,
    )
    response.data({ nodeCount: profile.nodes.length, durationMs, savedTo })
  },
})

export const summarize_profile = defineXcTool({
  name: 'summarize_profile',
  description:
    'Parse the most recently stopped CPU profile (or a .cpuprofile file) and return ' +
    'the top-N hottest JS functions by CPU self-time. ' +
    'Self-time = time spent in the function body excluding callees. ' +
    'Reveals which features are expensive and which files contain hot code paths.',
  input: z.object({
    page: pageParam,
    profileFile: z
      .string()
      .optional()
      .describe('Path to a .cpuprofile file. If omitted, uses in-memory profile from stop_js_profiler.'),
    topN: z.number().default(20).describe('Number of top functions to return (default 20)'),
    excludeNative: z
      .boolean()
      .default(true)
      .describe('Exclude native/built-in functions (default true)'),
  }),
  output: z.object({ topFunctions: z.array(z.any()), totalSamplesMs: z.number() }),
  handler: async (args, _ctx, response) => {
    let profile: V8Profile

    if (args.profileFile) {
      try {
        profile = JSON.parse(fs.readFileSync(args.profileFile, 'utf8'))
      } catch (e) {
        response.error(`Failed to read profile: ${(e as Error).message}`)
        return
      }
    } else {
      const state = PAGE_PROFILER.get(args.page)
      if (!state?.profile) {
        response.error('No profile available. Call start_js_profiler + stop_js_profiler first.')
        return
      }
      profile = state.profile
    }

    // Build node map and compute self-time from samples
    const nodeMap = new Map<number, V8ProfileNode>()
    for (const node of profile.nodes) nodeMap.set(node.id, node)

    // Count samples per node
    const sampleCounts = new Map<number, number>()
    for (const s of profile.samples ?? []) {
      sampleCounts.set(s, (sampleCounts.get(s) ?? 0) + 1)
    }

    // Total time per sample
    const totalTimeDelta = (profile.timeDeltas ?? []).reduce((a, b) => a + b, 0)
    const avgSampleUs = profile.samples?.length ? totalTimeDelta / profile.samples.length : 100

    // Aggregate by function signature
    const funcTime: Record<
      string,
      { selfTimeMs: number; totalHits: number; url: string; line: number }
    > = {}

    for (const node of profile.nodes) {
      const frame = node.callFrame
      if (args.excludeNative !== false && (!frame.url || frame.url === 'native')) continue
      if (!frame.url && !frame.functionName) continue

      const key = `${frame.functionName || '(anonymous)'}|${frame.url}|${frame.lineNumber}`
      const hits = sampleCounts.get(node.id) ?? node.hitCount ?? 0
      const selfTimeMs = Math.round((hits * avgSampleUs) / 1000)

      if (!funcTime[key]) {
        funcTime[key] = {
          selfTimeMs: 0,
          totalHits: 0,
          url: frame.url,
          line: frame.lineNumber,
        }
      }
      funcTime[key].selfTimeMs += selfTimeMs
      funcTime[key].totalHits += hits
    }

    const topFunctions = Object.entries(funcTime)
      .map(([key, v]) => {
        const [name] = key.split('|')
        const fileShort = v.url ? v.url.split('/').slice(-2).join('/') : 'native'
        return {
          function: name,
          selfTimeMs: v.selfTimeMs,
          hits: v.totalHits,
          location: `${fileShort}:${v.line}`,
          url: v.url,
        }
      })
      .sort((a, b) => b.selfTimeMs - a.selfTimeMs)
      .slice(0, args.topN ?? 20)

    const totalSamplesMs = Math.round(totalTimeDelta / 1000)

    const lines = topFunctions.map(
      (f, i) =>
        `  ${String(i + 1).padStart(2)}. ${f.function.slice(0, 40).padEnd(40)} ${String(f.selfTimeMs).padStart(6)}ms  ${f.location.slice(0, 60)}`,
    )
    response.text(
      `Top ${topFunctions.length} JS functions by CPU self-time (total: ${totalSamplesMs}ms):\n` +
      lines.join('\n'),
    )
    response.data({ topFunctions, totalSamplesMs })
  },
})

export const get_heap_snapshot = defineXcTool({
  name: 'get_heap_snapshot',
  description:
    'Take a V8 heap snapshot and return the top object constructors by instance count. ' +
    'Useful for finding: leaked event listeners, large closure-held feature modules, ' +
    'or discovering what global/module objects exist (e.g. a StripeElements constructor ' +
    'in the heap confirms Stripe is loaded even if not visible in the DOM). ' +
    'Warning: heap snapshots pause JS execution for 1-5 seconds on large pages.',
  input: z.object({
    page: pageParam,
    topN: z.number().default(30).describe('Top N constructors by instance count (default 30)'),
    outputPath: z
      .string()
      .optional()
      .describe('Optional path to save raw .heapsnapshot file'),
    timeoutMs: z
      .number()
      .default(30000)
      .describe('Max ms to wait for snapshot (default 30000 — large heaps can take 10s+)'),
  }),
  output: z.object({ topConstructors: z.array(z.any()), totalObjects: z.number() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    await cdp.HeapProfiler.enable()

    const chunks: string[] = []
    const unsubChunk = cdp.HeapProfiler.on('addHeapSnapshotChunk', (params: unknown) => {
      chunks.push((params as { chunk: string }).chunk)
    })

    let resolveSnapshot!: () => void
    const snapshotPromise = new Promise<void>((r) => { resolveSnapshot = r })
    // HeapProfiler.takeHeapSnapshot resolves when snapshot is complete
    // but the chunks may arrive after — wait for the promise to settle

    const timeoutPromise = new Promise<'timeout'>((r) =>
      setTimeout(() => r('timeout'), args.timeoutMs ?? 30000)
    )

    const snapshotCallPromise = cdp.HeapProfiler.takeHeapSnapshot({ reportProgress: false })
      .then(() => resolveSnapshot())

    const raceResult = await Promise.race([snapshotCallPromise.then(() => 'done'), timeoutPromise])
    unsubChunk()

    if (raceResult === 'timeout') {
      response.error('Heap snapshot timed out. Try on a lighter page or increase timeoutMs.')
      return
    }

    const rawJson = chunks.join('')
    let savedTo: string | undefined

    if (args.outputPath) {
      try {
        const dir = path.dirname(args.outputPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(args.outputPath, rawJson, 'utf8')
        savedTo = args.outputPath
      } catch { /* ignore save error */ }
    }

    // Parse snapshot — format: { snapshot: { meta, node_count, edge_count }, nodes: [...], strings: [...] }
    let topConstructors: Array<{ constructor: string; count: number; sizeKb: number }> = []
    let totalObjects = 0

    try {
      const snapshot = JSON.parse(rawJson)
      const meta = snapshot.snapshot?.meta
      const nodes: number[] = snapshot.nodes ?? []
      const strings: string[] = snapshot.strings ?? []

      if (meta && nodes.length > 0) {
        const fieldCount = meta.node_fields?.length ?? 6
        const typeIdx = meta.node_fields?.indexOf('type') ?? 0
        const nameIdx = meta.node_fields?.indexOf('name') ?? 1
        const sizeIdx = meta.node_fields?.indexOf('self_size') ?? 4

        const constructorCounts: Record<string, { count: number; sizeBytes: number }> = {}

        for (let i = 0; i < nodes.length; i += fieldCount) {
          const nameStrIdx = nodes[i + nameIdx]
          const name = strings[nameStrIdx] ?? 'unknown'
          const size = nodes[i + sizeIdx] ?? 0
          if (!constructorCounts[name]) constructorCounts[name] = { count: 0, sizeBytes: 0 }
          constructorCounts[name].count++
          constructorCounts[name].sizeBytes += size
          totalObjects++
        }

        topConstructors = Object.entries(constructorCounts)
          .map(([name, v]) => ({
            constructor: name,
            count: v.count,
            sizeKb: Math.round(v.sizeBytes / 1024),
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, args.topN ?? 30)
      }
    } catch {
      // If parse fails (very large snapshot), return partial info
      totalObjects = -1
    }

    const lines = topConstructors.map(
      (c, i) =>
        `  ${String(i + 1).padStart(2)}. ${c.constructor.slice(0, 40).padEnd(40)} ${String(c.count).padStart(8)} instances  ${c.sizeKb}KB`,
    )
    response.text(
      `Heap snapshot: ${totalObjects} total objects\n` +
      (savedTo ? `Saved to: ${savedTo}\n` : '') +
      `Top constructors:\n${lines.join('\n')}`,
    )
    response.data({ topConstructors, totalObjects })
  },
})

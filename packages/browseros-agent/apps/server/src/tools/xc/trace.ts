/**
 * XC Phase 8 — Chrome DevTools Trace Capture & Analysis
 *
 * Tools exported:
 *   start_trace       — begin a Chrome trace session
 *   stop_trace        — end the trace, collect events, optionally save JSON
 *   analyze_trace     — parse a previously stopped trace and return a summary
 *   get_trace_summary — combined start+wait+stop+analyze in one call (convenience)
 *
 * Architecture
 * ────────────
 * CDP Tracing.start begins Chrome-level event recording across all threads.
 * CDP Tracing.end triggers async delivery: Chrome fires multiple
 * Tracing.dataCollected events (each carrying a chunk of trace events),
 * followed by a single Tracing.tracingComplete event.
 *
 * We accumulate dataCollected chunks in memory, then on tracingComplete
 * we concatenate and optionally persist to disk.
 *
 * Default categories are chosen for web-intelligence use:
 *   devtools.timeline    — layout, paint, composite, long tasks
 *   v8                   — JS execution (GC, compile, script evaluation)
 *   blink.user_timing    — performance.mark / measure calls
 *   loading              — resource loading timeline
 *   disabled-by-default-devtools.timeline.frame  — frame boundaries
 *   disabled-by-default-v8.cpu_profiler          — sampled CPU profile
 *
 * Analysis (analyze_trace) works entirely in-process on the collected
 * event array — no file I/O required if you don’t pass outputPath.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('performance')

// ── Per-page trace state ─────────────────────────────────────────────────────────

interface TraceEvent {
  pid: number
  tid: number
  ts: number // timestamp in microseconds
  ph: string // phase: B/E (begin/end), X (complete), I (instant), M (metadata)
  cat: string
  name: string
  dur?: number // duration in microseconds (for X events)
  args?: Record<string, unknown>
  sf?: number // stack frame id
}

interface TraceState {
  recording: boolean
  chunks: TraceEvent[][]
  allEvents: TraceEvent[] | null
  unsubscribers: Array<() => void>
  startTs: number
  completeResolve?: () => void
  completePromise?: Promise<void>
}

const PAGE_TRACE: Map<number, TraceState> = new Map()

function getOrCreateTrace(pageId: number): TraceState {
  if (!PAGE_TRACE.has(pageId)) {
    PAGE_TRACE.set(pageId, {
      recording: false,
      chunks: [],
      allEvents: null,
      unsubscribers: [],
      startTs: 0,
    })
  }
  return PAGE_TRACE.get(pageId)!
}

const DEFAULT_CATEGORIES = [
  'devtools.timeline',
  'v8',
  'v8.execute',
  'blink.user_timing',
  'loading',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-v8.cpu_profiler',
].join(',')

type CdpSession = {
  Tracing: {
    start: (p: object) => Promise<void>
    end: () => Promise<void>
    on: (event: string, cb: (params: unknown) => void) => () => void
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

export const start_trace = defineXcTool({
  name: 'start_trace',
  description:
    'Start a Chrome DevTools trace on a page. Records JS execution, layout, paint, ' +
    'long tasks, lazy chunk loads, and user timing marks. ' +
    'After starting, interact with the page (navigate, click, scroll), ' +
    'then call stop_trace to collect events, followed by analyze_trace for a summary. ' +
    'Tracing is browser-global — only one trace can run at a time per browser session.',
  input: z.object({
    page: pageParam,
    categories: z
      .string()
      .optional()
      .describe(
        'Comma-separated CDP trace categories (default: devtools.timeline,v8,blink.user_timing,loading,...)',
      ),
    bufferSizeMb: z
      .number()
      .default(100)
      .describe('Trace buffer size in MB (default 100)'),
  }),
  output: z.object({ recording: z.boolean(), categories: z.string() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateTrace(args.page)
    if (state.recording) {
      response.error('A trace is already recording on this page. Call stop_trace first.')
      return
    }

    // Clear old state
    for (const unsub of state.unsubscribers) unsub()
    state.unsubscribers = []
    state.chunks = []
    state.allEvents = null

    const cdp = session as unknown as CdpSession
    const categories = args.categories ?? DEFAULT_CATEGORIES

    // Set up complete promise
    let resolve!: () => void
    state.completePromise = new Promise<void>((r) => { resolve = r })
    state.completeResolve = resolve

    const unsubData = cdp.Tracing.on('dataCollected', (params: unknown) => {
      const p = params as { value: TraceEvent[] }
      state.chunks.push(p.value ?? [])
    })

    const unsubComplete = cdp.Tracing.on('tracingComplete', () => {
      state.recording = false
      state.allEvents = state.chunks.flat()
      state.completeResolve?.()
    })

    state.unsubscribers.push(unsubData, unsubComplete)

    await cdp.Tracing.start({
      categories,
      options: 'sampling-frequency=1000',
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        includedCategories: categories.split(','),
        enableSampling: true,
        enableSystrace: false,
        enableArgumentFilter: false,
        memoryDumpConfig: {},
      },
      transferMode: 'ReportEvents',
      bufferUsageReportingInterval: 1000,
    })

    state.recording = true
    state.startTs = Date.now()

    response.text(
      `Trace started.\nCategories: ${categories}\n` +
      `Now interact with the page, then call stop_trace().`,
    )
    response.data({ recording: true, categories })
  },
})

export const stop_trace = defineXcTool({
  name: 'stop_trace',
  description:
    'Stop the active trace and collect all recorded events. ' +
    'Optionally save the raw trace JSON to a file (loadable in chrome://tracing or Perfetto). ' +
    'After stopping, call analyze_trace to get a structured performance summary.',
  input: z.object({
    page: pageParam,
    outputPath: z
      .string()
      .optional()
      .describe(
        'Optional absolute file path to save trace JSON (e.g. /tmp/trace.json). ' +
        'If omitted, trace is kept in memory only.',
      ),
    waitTimeoutMs: z
      .number()
      .default(15000)
      .describe('Max ms to wait for trace collection to complete (default 15000)'),
  }),
  output: z.object({
    eventCount: z.number(),
    durationMs: z.number(),
    savedTo: z.string().optional(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const state = getOrCreateTrace(args.page)
    if (!state.recording) {
      response.error('No active trace on this page. Call start_trace first.')
      return
    }

    const cdp = session as unknown as CdpSession
    await cdp.Tracing.end()

    // Wait for tracingComplete
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Trace collection timed out')), args.waitTimeoutMs ?? 15000)
    )
    try {
      await Promise.race([state.completePromise!, timeout])
    } catch (e) {
      response.error(`Trace collection timed out. Partial events: ${state.chunks.flat().length}`)
      return
    }

    const allEvents = state.allEvents ?? []
    const durationMs = Date.now() - state.startTs
    let savedTo: string | undefined

    if (args.outputPath) {
      try {
        const dir = path.dirname(args.outputPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          args.outputPath,
          JSON.stringify({ traceEvents: allEvents }, null, 0),
          'utf8',
        )
        savedTo = args.outputPath
      } catch (e) {
        response.error(`Failed to save trace: ${(e as Error).message}`)
        return
      }
    }

    response.text(
      `Trace stopped. ${allEvents.length} events collected in ${durationMs}ms.\n` +
      (savedTo ? `Saved to: ${savedTo}\n` : '') +
      `Call analyze_trace({ page: ${args.page} }) for a performance summary.`,
    )
    response.data({ eventCount: allEvents.length, durationMs, savedTo })
  },
})

export const analyze_trace = defineXcTool({
  name: 'analyze_trace',
  description:
    'Analyze the most recently stopped trace on a page (or a saved trace file). ' +
    'Returns: long tasks (>50ms), top JS functions by self-time, ' +
    'layout/paint/composite event counts and durations, ' +
    'scripting vs rendering vs idle time breakdown, ' +
    'deferred/lazy chunk load events (reveals lazy-loaded features), ' +
    'and user timing marks.',
  input: z.object({
    page: pageParam,
    traceFile: z
      .string()
      .optional()
      .describe('Path to a saved trace JSON file. If omitted, uses the in-memory trace from stop_trace.'),
    longTaskThresholdMs: z
      .number()
      .default(50)
      .describe('Threshold in ms to classify a task as "long task" (default 50ms)'),
    topFunctions: z
      .number()
      .default(20)
      .describe('Number of top JS functions to return by self-time (default 20)'),
  }),
  output: z.object({
    summary: z.any(),
  }),
  handler: async (args, _ctx, response) => {
    let events: TraceEvent[]

    if (args.traceFile) {
      try {
        const raw = fs.readFileSync(args.traceFile, 'utf8')
        const parsed = JSON.parse(raw)
        events = parsed.traceEvents ?? parsed
      } catch (e) {
        response.error(`Failed to read trace file: ${(e as Error).message}`)
        return
      }
    } else {
      const state = PAGE_TRACE.get(args.page)
      if (!state?.allEvents) {
        response.error('No trace data available. Call start_trace + stop_trace first.')
        return
      }
      events = state.allEvents
    }

    const threshold = (args.longTaskThresholdMs ?? 50) * 1000 // convert to microseconds
    const topN = args.topFunctions ?? 20

    // ── Long tasks (TaskQueueManager RunTask + duration > threshold) ───────────
    const longTasks = events
      .filter(
        (e) =>
          (e.ph === 'X' || e.ph === 'B') &&
          (e.name === 'RunTask' || e.name === 'Task' || e.name === 'LongTask') &&
          (e.dur ?? 0) > threshold,
      )
      .map((e) => ({
        name: e.name,
        durationMs: Math.round((e.dur ?? 0) / 1000),
        ts: e.ts,
        initiator: (e.args as Record<string, { type?: string }>)?.data?.type ?? null,
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 20)

    // ── JS self-time aggregation (EvaluateScript, FunctionCall, v8.run) ────────
    const jsEvents = events.filter(
      (e) =>
        (e.ph === 'X' || e.ph === 'B') &&
        (e.cat?.includes('v8') || e.cat?.includes('devtools.timeline')) &&
        ['EvaluateScript', 'FunctionCall', 'v8.run', 'v8.compile', 'MinorGC', 'MajorGC'].includes(e.name),
    )

    const functionTime: Record<string, { selfTimeUs: number; count: number; source?: string }> = {}
    for (const e of jsEvents) {
      const dur = e.dur ?? 0
      const data = e.args as Record<string, { functionName?: string; url?: string; lineNumber?: number }>
      const fnName =
        data?.data?.functionName ||
        (e.name === 'EvaluateScript' ? `[Script: ${data?.data?.url?.split('/').pop()?.slice(0, 40) ?? 'inline'}]` : e.name)
      if (!functionTime[fnName]) functionTime[fnName] = { selfTimeUs: 0, count: 0 }
      functionTime[fnName].selfTimeUs += dur
      functionTime[fnName].count++
      if (data?.data?.url && !functionTime[fnName].source) {
        functionTime[fnName].source = `${data.data.url}:${data.data.lineNumber ?? 0}`
      }
    }

    const topFunctions = Object.entries(functionTime)
      .map(([name, v]) => ({
        name,
        selfTimeMs: Math.round(v.selfTimeUs / 1000),
        callCount: v.count,
        source: v.source,
      }))
      .sort((a, b) => b.selfTimeMs - a.selfTimeMs)
      .slice(0, topN)

    // ── Layout / Paint / Composite ───────────────────────────────────────────
    const renderEvents = ['Layout', 'Paint', 'CompositeLayers', 'UpdateLayerTree', 'PaintImage']
    const renderSummary: Record<string, { count: number; totalMs: number }> = {}
    for (const e of events) {
      if ((e.ph === 'X' || e.ph === 'B') && renderEvents.includes(e.name)) {
        if (!renderSummary[e.name]) renderSummary[e.name] = { count: 0, totalMs: 0 }
        renderSummary[e.name].count++
        renderSummary[e.name].totalMs += Math.round((e.dur ?? 0) / 1000)
      }
    }

    // ── Scripting vs Rendering time budget ───────────────────────────────────
    let scriptingUs = 0, renderingUs = 0, paintingUs = 0
    for (const e of events) {
      if (e.ph !== 'X' && e.ph !== 'B') continue
      const dur = e.dur ?? 0
      if (['EvaluateScript', 'FunctionCall', 'v8.run', 'TimerFire', 'EventDispatch'].includes(e.name)) scriptingUs += dur
      if (['Layout', 'UpdateLayerTree', 'RecalculateStyles'].includes(e.name)) renderingUs += dur
      if (['Paint', 'PaintImage', 'CompositeLayers'].includes(e.name)) paintingUs += dur
    }

    // ── Lazy chunk loads (ResourceSendRequest for .chunk.js files) ────────────
    const lazyChunks = events
      .filter((e) => {
        const url = (e.args as Record<string, { url?: string }>)?.data?.url ?? ''
        return (
          e.name === 'ResourceSendRequest' &&
          (url.includes('.chunk.') || url.includes('lazy') || url.match(/\.[0-9a-f]{8}\.js$/))
        )
      })
      .map((e) => {
        const data = (e.args as Record<string, { url?: string; requestId?: string }>).data
        return { url: data?.url ?? '', requestId: data?.requestId }
      })

    // ── User timing marks (performance.mark / measure) ──────────────────────
    const userMarks = events
      .filter((e) => e.cat?.includes('blink.user_timing') && e.ph === 'R')
      .map((e) => ({ name: e.name, ts: e.ts }))
      .slice(0, 50)

    const summary = {
      longTasks: {
        count: longTasks.length,
        totalMs: longTasks.reduce((s, t) => s + t.durationMs, 0),
        tasks: longTasks,
      },
      topJsFunctions: topFunctions,
      renderingEvents: renderSummary,
      timeBudgetMs: {
        scripting: Math.round(scriptingUs / 1000),
        rendering: Math.round(renderingUs / 1000),
        painting: Math.round(paintingUs / 1000),
      },
      lazyChunks: {
        count: lazyChunks.length,
        chunks: lazyChunks.slice(0, 30),
      },
      userTimingMarks: userMarks,
      totalEventsAnalyzed: events.length,
    }

    const lines = [
      `Trace analysis (${events.length} events):`,
      `  Long tasks (>${args.longTaskThresholdMs ?? 50}ms): ${longTasks.length} | total ${summary.longTasks.totalMs}ms`,
      `  Time budget: scripting ${summary.timeBudgetMs.scripting}ms | rendering ${summary.timeBudgetMs.rendering}ms | painting ${summary.timeBudgetMs.painting}ms`,
      `  Lazy JS chunks loaded: ${lazyChunks.length}`,
      `  User timing marks: ${userMarks.length}`,
      `  Top JS function: ${topFunctions[0]?.name ?? 'none'} (${topFunctions[0]?.selfTimeMs ?? 0}ms)`,
    ]
    response.text(lines.join('\n'))
    response.data({ summary })
  },
})

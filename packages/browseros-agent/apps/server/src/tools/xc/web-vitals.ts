/**
 * XC Phase 6 — Web Vitals
 *
 * Measures Core Web Vitals (LCP, CLS, TTFB, FCP, INP) using the browser's
 * native PerformanceObserver API — no external npm package required.
 *
 * The measurement script is injected via Runtime.evaluate and returns real
 * values from the browser's performance timeline.
 *
 * Tools exported:
 *   get_web_vitals — returns { LCP, CLS, TTFB, FCP, INP, navigationType }
 *
 * Why vitals matter for architecture mapping:
 *   - High LCP → large above-the-fold component, likely a hero image or SSR issue
 *   - High CLS → dynamic content injected without reserved space (ads, modals)
 *   - High INP → heavy JS on interaction (complex reducers, unoptimised event handlers)
 *   - TTFB → server-side rendering performance
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')

/**
 * Self-contained vitals collection script.
 * Uses PerformanceObserver (universally supported in Chromium).
 * Returns whatever is available immediately from the performance buffer +
 * any already-dispatched PerformanceObserver entries.
 */
const VITALS_JS = `
(function collectVitals() {
  var vitals = { LCP: null, CLS: null, TTFB: null, FCP: null, INP: null, navigationType: null };

  // TTFB — from Navigation Timing
  try {
    var navEntries = performance.getEntriesByType('navigation');
    if (navEntries.length > 0) {
      var nav = navEntries[0];
      vitals.TTFB = Math.round(nav.responseStart - nav.requestStart);
      vitals.navigationType = nav.type || null;
    }
  } catch(e) {}

  // FCP — from paint entries
  try {
    var paintEntries = performance.getEntriesByType('paint');
    paintEntries.forEach(function(e) {
      if (e.name === 'first-contentful-paint') vitals.FCP = Math.round(e.startTime);
    });
  } catch(e) {}

  // LCP — from largest-contentful-paint
  try {
    var lcpEntries = performance.getEntriesByType('largest-contentful-paint');
    if (lcpEntries.length > 0) {
      var last = lcpEntries[lcpEntries.length - 1];
      vitals.LCP = Math.round(last.startTime);
    }
  } catch(e) {}

  // CLS — from layout-shift
  try {
    var clsEntries = performance.getEntriesByType('layout-shift');
    var clsValue = 0;
    clsEntries.forEach(function(e) {
      if (!e.hadRecentInput) clsValue += e.value;
    });
    vitals.CLS = Math.round(clsValue * 10000) / 10000;
  } catch(e) {}

  // INP — from event-timing (Chrome 96+)
  try {
    var eventEntries = performance.getEntriesByType('event');
    if (eventEntries.length > 0) {
      var maxDuration = 0;
      eventEntries.forEach(function(e) {
        if (e.duration > maxDuration) maxDuration = e.duration;
      });
      vitals.INP = Math.round(maxDuration);
    }
  } catch(e) {}

  // Ratings
  function rateLCP(v) { return v === null ? 'unknown' : v <= 2500 ? 'good' : v <= 4000 ? 'needs-improvement' : 'poor'; }
  function rateFCP(v) { return v === null ? 'unknown' : v <= 1800 ? 'good' : v <= 3000 ? 'needs-improvement' : 'poor'; }
  function rateCLS(v) { return v === null ? 'unknown' : v <= 0.1 ? 'good' : v <= 0.25 ? 'needs-improvement' : 'poor'; }
  function rateTTFB(v) { return v === null ? 'unknown' : v <= 800 ? 'good' : v <= 1800 ? 'needs-improvement' : 'poor'; }
  function rateINP(v) { return v === null ? 'unknown' : v <= 200 ? 'good' : v <= 500 ? 'needs-improvement' : 'poor'; }

  // Additional page context
  var pageContext = {
    url: location.href,
    title: document.title,
    resourceCount: performance.getEntriesByType('resource').length,
    domContentLoaded: null,
    domInteractive: null,
  };
  try {
    var nav2 = performance.getEntriesByType('navigation')[0];
    if (nav2) {
      pageContext.domContentLoaded = Math.round(nav2.domContentLoadedEventEnd);
      pageContext.domInteractive = Math.round(nav2.domInteractive);
    }
  } catch(e) {}

  return {
    metrics: {
      LCP:  { value: vitals.LCP,  unit: 'ms',  rating: rateLCP(vitals.LCP) },
      FCP:  { value: vitals.FCP,  unit: 'ms',  rating: rateFCP(vitals.FCP) },
      TTFB: { value: vitals.TTFB, unit: 'ms',  rating: rateTTFB(vitals.TTFB) },
      CLS:  { value: vitals.CLS,  unit: 'score', rating: rateCLS(vitals.CLS) },
      INP:  { value: vitals.INP,  unit: 'ms',  rating: rateINP(vitals.INP) },
    },
    navigationType: vitals.navigationType,
    pageContext: pageContext,
  };
})()
`

export const get_web_vitals = defineXcTool({
  name: 'get_web_vitals',
  description:
    'Measure Core Web Vitals for the current page using the browser Performance API. ' +
    'Returns LCP, CLS, TTFB, FCP, INP with values, units, and ratings (good/needs-improvement/poor). ' +
    'Also returns domContentLoaded, domInteractive, and resource count. ' +
    'No external library needed — reads from the native performance timeline. ' +
    'Architecture insight: high LCP → heavy above-fold component; high CLS → dynamic content injection; ' +
    'high INP → expensive event handlers; TTFB → SSR effectiveness.',
  input: z.object({
    page: pageParam,
    waitForLCP: z
      .boolean()
      .default(false)
      .describe(
        'If true, wait 1s before collecting to give LCP time to fire (useful right after navigation)',
      ),
  }),
  output: z.object({
    metrics: z.record(
      z.object({
        value: z.number().nullable(),
        unit: z.string(),
        rating: z.string(),
      }),
    ),
    navigationType: z.string().nullable(),
    pageContext: z.object({
      url: z.string(),
      title: z.string(),
      resourceCount: z.number(),
      domContentLoaded: z.number().nullable(),
      domInteractive: z.number().nullable(),
    }),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    if (args.waitForLCP) {
      await new Promise((r) => setTimeout(r, 1000))
    }

    const result = await session.Runtime.evaluate({
      expression: VITALS_JS,
      returnByValue: true,
      awaitPromise: false,
    })

    const data = result.result?.value as {
      metrics: Record<string, { value: number | null; unit: string; rating: string }>
      navigationType: string | null
      pageContext: { url: string; title: string; resourceCount: number; domContentLoaded: number | null; domInteractive: number | null }
    }

    if (!data?.metrics) {
      response.error('Failed to collect web vitals.')
      return
    }

    const lines = Object.entries(data.metrics).map(([key, m]) => {
      const val = m.value !== null ? `${m.value}${m.unit}` : 'N/A'
      const emoji = m.rating === 'good' ? '✅' : m.rating === 'needs-improvement' ? '⚠️' : m.rating === 'poor' ? '❌' : '❓'
      return `  ${emoji} ${key}: ${val} (${m.rating})`
    })
    lines.push('')
    lines.push(`  Resources loaded: ${data.pageContext.resourceCount}`)
    if (data.pageContext.domInteractive !== null) lines.push(`  DOM interactive: ${data.pageContext.domInteractive}ms`)
    if (data.pageContext.domContentLoaded !== null) lines.push(`  DOMContentLoaded: ${data.pageContext.domContentLoaded}ms`)
    lines.push(`  Navigation type: ${data.navigationType ?? 'unknown'}`)

    response.text(`Web Vitals — ${data.pageContext.url}\n${lines.join('\n')}`)
    response.data(data)
  },
})

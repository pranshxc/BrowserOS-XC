/**
 * XC Phase 5 — URL-to-URL Diff
 *
 * Opens two URLs in parallel hidden pages, runs the requested diff mode
 * (snapshot, screenshot, or both), then closes the temporary pages.
 *
 * Tools exported:
 *   diff_url — compare two URLs via snapshot diff, screenshot diff, or both
 *
 * Use cases:
 *   - Compare logged-in vs logged-out view of the same page
 *   - Compare two different pages in the same app (e.g. /settings vs /profile)
 *   - Compare before/after a deployment
 */

import { z } from 'zod'
import { buildInteractiveTree } from '../../browser/snapshot'
import { defineToolWithCategory } from '../framework'

const defineXcTool = defineToolWithCategory('observation')

type AXNode = {
  nodeId: string
  ignored?: boolean
  role?: { type: string; value?: unknown }
  name?: { type: string; value?: unknown }
  value?: { type: string; value?: unknown }
  properties?: Array<{ name: string; value: { type: string; value?: unknown } }>
  childIds?: string[]
  backendDOMNodeId?: number
}

const PIXEL_DIFF_SCRIPT = (dataA: string, dataB: string, threshold: number) => `
(function() {
  return new Promise(function(resolve) {
    var imgA = new Image(), imgB = new Image(), loaded = 0;
    function onLoad() {
      loaded++; if (loaded < 2) return;
      var w = Math.max(imgA.naturalWidth, imgB.naturalWidth);
      var h = Math.max(imgA.naturalHeight, imgB.naturalHeight);
      if (!w || !h) { resolve({ changedPixels:0, totalPixels:0, changedPercent:0, diffDataUrl:'' }); return; }
      var ca = document.createElement('canvas'); ca.width=w; ca.height=h;
      var cta = ca.getContext('2d'); cta.drawImage(imgA,0,0);
      var da = cta.getImageData(0,0,w,h).data;
      var cb = document.createElement('canvas'); cb.width=w; cb.height=h;
      var ctb = cb.getContext('2d'); ctb.drawImage(imgB,0,0);
      var db = ctb.getImageData(0,0,w,h).data;
      var cd = document.createElement('canvas'); cd.width=w; cd.height=h;
      var ctd = cd.getContext('2d'); ctd.drawImage(imgA,0,0);
      var id = ctd.getImageData(0,0,w,h); var dd = id.data;
      var changed=0;
      for (var i=0;i<da.length;i+=4) {
        var diff=(Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2]))/3;
        if(diff>${threshold}){dd[i]=220;dd[i+1]=38;dd[i+2]=38;dd[i+3]=200;changed++;}
      }
      ctd.putImageData(id,0,0);
      var b64=cd.toDataURL('image/png').replace(/^data:image\/png;base64,/,'');
      resolve({changedPixels:changed,totalPixels:w*h,changedPercent:Math.round(changed/(w*h)*10000)/100,diffDataUrl:b64});
    }
    imgA.onload=onLoad; imgB.onload=onLoad;
    imgA.onerror=function(){resolve({changedPixels:-1,totalPixels:0,changedPercent:0,diffDataUrl:'',error:'baseline load failed'});};
    imgB.onerror=function(){resolve({changedPixels:-1,totalPixels:0,changedPercent:0,diffDataUrl:'',error:'current load failed'});};
    imgA.src=${JSON.stringify('data:image/png;base64,' + dataA)};
    imgB.src=${JSON.stringify('data:image/png;base64,' + dataB)};
  });
})()
`

export const diff_url = defineXcTool({
  name: 'diff_url',
  description:
    'Open two URLs in temporary pages and compare them via accessibility snapshot diff, ' +
    'pixel screenshot diff, or both. ' +
    'Useful for: logged-in vs logged-out views, A/B page variants, before/after deployments. ' +
    'Both pages are closed automatically after the diff.',
  input: z.object({
    urlA: z.string().url().describe('First URL (treated as "baseline")'),
    urlB: z.string().url().describe('Second URL (treated as "current")'),
    mode: z
      .enum(['snapshot', 'screenshot', 'both'])
      .default('both')
      .describe('Diff mode: snapshot (AX tree), screenshot (pixel), or both'),
    waitMs: z
      .number()
      .default(2000)
      .describe('Milliseconds to wait after navigation before capturing (default 2000)'),
    screenshotThreshold: z
      .number()
      .default(10)
      .describe('Pixel diff threshold 0–255 (default 10)'),
  }),
  output: z.object({
    urlA: z.string(),
    urlB: z.string(),
    mode: z.string(),
    snapshotDiff: z
      .object({
        added: z.array(z.string()),
        removed: z.array(z.string()),
        unchanged: z.number(),
        hasChanges: z.boolean(),
      })
      .optional(),
    screenshotDiff: z
      .object({
        changedPixels: z.number(),
        totalPixels: z.number(),
        changedPercent: z.number(),
      })
      .optional(),
  }),
  handler: async (args, ctx, response) => {
    // Open two hidden pages
    let pageA: number | undefined
    let pageB: number | undefined

    try {
      pageA = await ctx.browser.newHiddenPage()
      pageB = await ctx.browser.newHiddenPage()
    } catch {
      // Fallback: try newPage
      try {
        pageA = await ctx.browser.newPage()
        pageB = await ctx.browser.newPage()
      } catch (err) {
        response.error(`Could not open pages for diff: ${String(err)}`)
        return
      }
    }

    const cleanup = async () => {
      if (pageA !== undefined)
        await ctx.browser.closePage(pageA).catch(() => {})
      if (pageB !== undefined)
        await ctx.browser.closePage(pageB).catch(() => {})
    }

    try {
      // Navigate both pages in parallel
      await Promise.all([
        ctx.browser.navigate(pageA, args.urlA),
        ctx.browser.navigate(pageB, args.urlB),
      ])

      // Wait for pages to settle
      const waitMs = args.waitMs ?? 2000
      await new Promise((r) => setTimeout(r, waitMs))

      const mode = args.mode ?? 'both'
      const result: {
        urlA: string
        urlB: string
        mode: string
        snapshotDiff?: {
          added: string[]
          removed: string[]
          unchanged: number
          hasChanges: boolean
        }
        screenshotDiff?: {
          changedPixels: number
          totalPixels: number
          changedPercent: number
        }
      } = { urlA: args.urlA, urlB: args.urlB, mode }

      const outputLines: string[] = [`URL diff: ${args.urlA}  vs  ${args.urlB}`]

      // ── Snapshot diff ──────────────────────────────────────────────────────
      if (mode === 'snapshot' || mode === 'both') {
        const sessionA = await ctx.browser.getSession(pageA)
        const sessionB = await ctx.browser.getSession(pageB)

        const getLines = async (session: {
          Accessibility: { getFullAXTree: (opts: object) => Promise<{ nodes?: unknown[] }> }
        }) => {
          const r = await session.Accessibility.getFullAXTree({})
          return buildInteractiveTree((r.nodes ?? []) as AXNode[])
        }

        const [linesA, linesB] = await Promise.all([
          getLines(sessionA as Parameters<typeof getLines>[0]),
          getLines(sessionB as Parameters<typeof getLines>[0]),
        ])

        const setA = new Set(linesA)
        const setB = new Set(linesB)
        const added = linesB.filter((l) => !setA.has(l))
        const removed = linesA.filter((l) => !setB.has(l))
        const unchanged = linesB.filter((l) => setA.has(l)).length
        const hasChanges = added.length > 0 || removed.length > 0

        result.snapshotDiff = { added, removed, unchanged, hasChanges }

        outputLines.push('')
        outputLines.push(`── SNAPSHOT DIFF ──`)
        if (!hasChanges) {
          outputLines.push('  No accessibility tree differences.')
        } else {
          if (added.length)
            outputLines.push(
              `  IN urlB only (${added.length}):`,
              ...added.slice(0, 30).map((l) => `    + ${l}`),
            )
          if (removed.length)
            outputLines.push(
              `  IN urlA only (${removed.length}):`,
              ...removed.slice(0, 30).map((l) => `    - ${l}`),
            )
          outputLines.push(`  Unchanged: ${unchanged}`)
        }
      }

      // ── Screenshot diff ────────────────────────────────────────────────────
      if (mode === 'screenshot' || mode === 'both') {
        const [shotA, shotB] = await Promise.all([
          ctx.browser.screenshot(pageA, { format: 'png', fullPage: false }),
          ctx.browser.screenshot(pageB, { format: 'png', fullPage: false }),
        ])

        // Run diff in pageB context
        const sessionB = await ctx.browser.getSession(pageB)
        let pixelResult: {
          changedPixels: number
          totalPixels: number
          changedPercent: number
          diffDataUrl: string
        } | null = null

        const evalR = await sessionB.Runtime.evaluate({
          expression: PIXEL_DIFF_SCRIPT(
            shotA.data,
            shotB.data,
            args.screenshotThreshold ?? 10,
          ),
          returnByValue: true,
          awaitPromise: true,
        })
        pixelResult = evalR.result?.value as typeof pixelResult

        if (pixelResult) {
          result.screenshotDiff = {
            changedPixels: pixelResult.changedPixels,
            totalPixels: pixelResult.totalPixels,
            changedPercent: pixelResult.changedPercent,
          }
          outputLines.push('')
          outputLines.push('── SCREENSHOT DIFF ──')
          outputLines.push(
            `  ${pixelResult.changedPixels.toLocaleString()} / ${pixelResult.totalPixels.toLocaleString()} pixels changed (${pixelResult.changedPercent}%)`,
          )
          if (pixelResult.diffDataUrl) {
            response.image(pixelResult.diffDataUrl, 'image/png')
          }
        }
      }

      response.text(outputLines.join('\n'))
      response.data(result)
    } finally {
      await cleanup()
    }
  },
})

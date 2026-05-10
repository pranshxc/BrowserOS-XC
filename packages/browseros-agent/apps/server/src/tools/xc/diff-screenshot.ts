/**
 * XC Phase 5 — Screenshot Diff
 *
 * Pixel-level comparison of two screenshots. No external npm dependencies —
 * the diff is computed inside the browser page using an injected canvas element
 * that draws both images and compares pixel data client-side via ImageData.
 *
 * Changed regions are highlighted in red on a semi-transparent overlay.
 * The result is returned inline as a base64 PNG.
 *
 * Tools exported:
 *   save_screenshot_baseline  — screenshot the page and save base64 PNG to disk
 *   diff_screenshot           — compare current page screenshot to a saved baseline
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')

const SCREENSHOTS_DIR = join(homedir(), '.browseros-xc', 'screenshots')

function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64)
}

async function ensureDir(): Promise<void> {
  await mkdir(SCREENSHOTS_DIR, { recursive: true })
}

// ── save_screenshot_baseline ──────────────────────────────────────────────────

export const save_screenshot_baseline = defineXcTool({
  name: 'save_screenshot_baseline',
  description:
    'Take a screenshot of the current page and save it as a named baseline for future pixel-diff comparisons. ' +
    'Use before performing an action, then diff_screenshot() afterwards to see which regions changed.',
  input: z.object({
    page: pageParam,
    name: z.string().describe('Baseline name (e.g. "before-modal", "login-page")'),
    fullPage: z.boolean().default(false),
  }),
  output: z.object({ name: z.string(), path: z.string() }),
  handler: async (args, ctx, response) => {
    await ensureDir()
    const shot = await ctx.browser.screenshot(args.page, {
      format: 'png',
      fullPage: args.fullPage ?? false,
    })
    const name = sanitizeName(args.name)
    const filePath = join(SCREENSHOTS_DIR, `${name}.b64`)
    await writeFile(filePath, shot.data, 'utf8')
    response.text(`Screenshot baseline "${name}" saved.\nPath: ${filePath}`)
    response.data({ name, path: filePath })
  },
})

// ── diff_screenshot ───────────────────────────────────────────────────────────

/**
 * Pure-TS pixel diff using CDP Runtime.evaluate to run canvas comparison
 * inside the browser context. This avoids any native module dependency.
 *
 * The script:
 *   1. Creates an offscreen canvas
 *   2. Draws baseline image (data URI)
 *   3. Draws current image on top, blended
 *   4. Compares pixel data → marks changed pixels red
 *   5. Returns { changedPixels, totalPixels, diffDataUrl }
 */
const DIFF_SCRIPT = (baselineDataUrl: string, currentDataUrl: string, threshold: number) => `
(function() {
  return new Promise(function(resolve, reject) {
    var imgA = new Image();
    var imgB = new Image();
    var loaded = 0;
    var threshold = ${threshold};

    function onLoad() {
      loaded++;
      if (loaded < 2) return;
      var w = Math.max(imgA.naturalWidth, imgB.naturalWidth);
      var h = Math.max(imgA.naturalHeight, imgB.naturalHeight);
      if (w === 0 || h === 0) { resolve({ changedPixels: 0, totalPixels: 0, changedPercent: 0, diffDataUrl: '' }); return; }

      var canvasA = document.createElement('canvas');
      canvasA.width = w; canvasA.height = h;
      var ctxA = canvasA.getContext('2d');
      ctxA.drawImage(imgA, 0, 0);
      var dataA = ctxA.getImageData(0, 0, w, h).data;

      var canvasB = document.createElement('canvas');
      canvasB.width = w; canvasB.height = h;
      var ctxB = canvasB.getContext('2d');
      ctxB.drawImage(imgB, 0, 0);
      var dataB = ctxB.getImageData(0, 0, w, h).data;

      var diffCanvas = document.createElement('canvas');
      diffCanvas.width = w; diffCanvas.height = h;
      var ctxD = diffCanvas.getContext('2d');
      ctxD.drawImage(imgA, 0, 0);
      var diffData = ctxD.getImageData(0, 0, w, h);
      var dd = diffData.data;

      var changed = 0;
      var total = w * h;
      for (var i = 0; i < dataA.length; i += 4) {
        var dr = Math.abs(dataA[i]   - dataB[i]);
        var dg = Math.abs(dataA[i+1] - dataB[i+1]);
        var db = Math.abs(dataA[i+2] - dataB[i+2]);
        var diff = (dr + dg + db) / 3;
        if (diff > threshold) {
          dd[i]   = 220;  // R — red highlight
          dd[i+1] = 38;
          dd[i+2] = 38;
          dd[i+3] = 200;
          changed++;
        }
      }
      ctxD.putImageData(diffData, 0, 0);
      var url = diffCanvas.toDataURL('image/png');
      // strip data URI prefix for response.image()
      var b64 = url.replace(/^data:image\/png;base64,/, '');
      resolve({
        changedPixels: changed,
        totalPixels: total,
        changedPercent: Math.round((changed / total) * 10000) / 100,
        diffDataUrl: b64
      });
    }

    imgA.onload = onLoad;
    imgB.onload = onLoad;
    imgA.onerror = function() { reject('Failed to load baseline image'); };
    imgB.onerror = function() { reject('Failed to load current image'); };
    imgA.src = ${JSON.stringify('data:image/png;base64,' + baselineDataUrl)};
    imgB.src = ${JSON.stringify('data:image/png;base64,' + currentDataUrl)};
  });
})()
`

export const diff_screenshot = defineXcTool({
  name: 'diff_screenshot',
  description:
    'Compare the current page screenshot to a previously saved baseline at the pixel level. ' +
    'Returns the diff image (changed regions highlighted in red) inline, plus changedPixels count and changedPercent. ' +
    'Use after save_screenshot_baseline to detect visual changes caused by an action.',
  input: z.object({
    page: pageParam,
    baseline: z
      .string()
      .describe('Baseline name from save_screenshot_baseline (e.g. "before-modal")'),
    threshold: z
      .number()
      .default(10)
      .describe(
        'Per-channel difference threshold 0–255 to count a pixel as changed (default 10). ' +
          'Lower = more sensitive.',
      ),
    fullPage: z.boolean().default(false),
  }),
  output: z.object({
    changedPixels: z.number(),
    totalPixels: z.number(),
    changedPercent: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const name = sanitizeName(args.baseline)
    const filePath = join(SCREENSHOTS_DIR, `${name}.b64`)

    let baselineData: string
    try {
      baselineData = await readFile(filePath, 'utf8')
    } catch {
      response.error(
        `Screenshot baseline "${name}" not found at ${filePath}. ` +
          'Use save_screenshot_baseline first.',
      )
      return
    }

    // Take current screenshot
    const current = await ctx.browser.screenshot(args.page, {
      format: 'png',
      fullPage: args.fullPage ?? false,
    })

    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    // Run pixel diff inside the browser (async via Runtime.evaluate with awaitPromise)
    let diffResult: {
      changedPixels: number
      totalPixels: number
      changedPercent: number
      diffDataUrl: string
    } | null = null

    try {
      const evalResult = await session.Runtime.evaluate({
        expression: DIFF_SCRIPT(baselineData, current.data, args.threshold ?? 10),
        returnByValue: true,
        awaitPromise: true,
      })
      diffResult = evalResult.result?.value as typeof diffResult
    } catch (err) {
      response.error(`Pixel diff failed: ${String(err)}`)
      return
    }

    if (!diffResult) {
      response.error('Pixel diff returned no result.')
      return
    }

    response.text(
      `Pixel diff — ${diffResult.changedPixels.toLocaleString()} changed pixel(s) ` +
        `out of ${diffResult.totalPixels.toLocaleString()} total (${diffResult.changedPercent}%).`,
    )
    if (diffResult.diffDataUrl) {
      response.image(diffResult.diffDataUrl, 'image/png')
    }
    response.data({
      changedPixels: diffResult.changedPixels,
      totalPixels: diffResult.totalPixels,
      changedPercent: diffResult.changedPercent,
    })
  },
})

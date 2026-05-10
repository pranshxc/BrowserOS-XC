/**
 * XC Phase 5 — Annotated Screenshot
 *
 * annotated_screenshot() takes a regular CDP screenshot then injects a
 * transparent canvas overlay into the page that draws numbered bounding
 * boxes around every interactive element visible in the current AX tree.
 * The annotated PNG is returned inline (base64) so the AI can reason about
 * visual position and label text simultaneously.
 *
 * Architecture
 * ────────────
 * 1. Call Accessibility.getFullAXTree to collect all interactive nodes with
 *    backendDOMNodeId values.
 * 2. For each node: call DOM.getBoxModel(backendNodeId) to get the quad
 *    coordinates of the element's border box.
 * 3. Inject a <canvas> overlay (position:fixed, top:0, left:0, z-index:2147483647,
 *    pointer-events:none) and draw labelled red rectangles for every element.
 * 4. Take screenshot via browser.screenshot().
 * 5. Remove the injected canvas.
 * 6. Return the annotated screenshot + a ref map.
 *
 * clear_visual_annotations() removes any lingering canvas overlay.
 *
 * Tools exported:
 *   annotated_screenshot  — full annotated screenshot with element map
 *   clear_visual_annotations — cleanup in case of error / manual call
 */

import { buildInteractiveTree } from '../../browser/snapshot'
import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')

const CANVAS_ID = '__xc_annotation_canvas__'

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

interface ElementRef {
  index: number
  backendNodeId: number
  role: string
  name: string
  x: number
  y: number
  width: number
  height: number
}

// ── annotated_screenshot ──────────────────────────────────────────────────────

export const annotated_screenshot = defineXcTool({
  name: 'annotated_screenshot',
  description:
    'Take a screenshot with numbered bounding boxes drawn around every interactive ' +
    'element (buttons, inputs, links, checkboxes, etc.). ' +
    'Returns the annotated image inline AND a map of element index → { role, name, backendNodeId }. ' +
    'Use this when you need to reason about visual layout and text labels together, ' +
    'or when standard snapshot refs do not match what you see on screen.',
  input: z.object({
    page: pageParam,
    labelColor: z
      .string()
      .default('#e53e3e')
      .describe('CSS color for annotation boxes (default red #e53e3e)'),
    fontSize: z
      .number()
      .default(11)
      .describe('Font size in px for index labels (default 11)'),
    fullPage: z
      .boolean()
      .default(false)
      .describe('Capture full scrollable page (default: viewport only)'),
  }),
  output: z.object({
    elementCount: z.number(),
    elements: z.record(
      z.string(),
      z.object({ role: z.string(), name: z.string(), backendNodeId: z.number() }),
    ),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) {
      response.error(`No active session for page ${args.page}.`)
      return
    }

    // Step 1: Get AX tree
    let axNodes: AXNode[] = []
    try {
      const axResult = await session.Accessibility.getFullAXTree({})
      axNodes = (axResult.nodes ?? []) as AXNode[]
    } catch {
      response.error('Failed to get accessibility tree.')
      return
    }

    // Step 2: Filter to interactive nodes with backendDOMNodeId
    const interactiveLines = buildInteractiveTree(axNodes)
    // Build map: backendNodeId -> { role, name }
    const nodeMap = new Map<number, { role: string; name: string }>()
    for (const node of axNodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue
      const role = (node.role?.value as string) ?? ''
      const name = (node.name?.value as string) ?? ''
      if (role && node.backendDOMNodeId) {
        nodeMap.set(node.backendDOMNodeId, { role, name })
      }
    }

    // Only annotate nodes that appear in the interactive tree (respect same filter)
    const interactiveNodeIds = new Set<number>()
    for (const line of interactiveLines) {
      const match = line.match(/^\[(\d+)\]/)
      if (match) interactiveNodeIds.add(Number(match[1]))
    }

    // Step 3: Collect box models for each interactive node
    const refs: ElementRef[] = []
    let index = 1
    for (const [backendNodeId, meta] of nodeMap) {
      if (!interactiveNodeIds.has(backendNodeId)) continue
      try {
        const box = await session.DOM.getBoxModel({ backendNodeId })
        if (!box.model) continue
        const quad = box.model.border // [x1,y1, x2,y1, x2,y2, x1,y2]
        const xs = [quad[0], quad[2], quad[4], quad[6]]
        const ys = [quad[1], quad[3], quad[5], quad[7]]
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        const width = Math.max(...xs) - x
        const height = Math.max(...ys) - y
        if (width < 2 || height < 2) continue // invisible
        refs.push({ index, backendNodeId, role: meta.role, name: meta.name, x, y, width, height })
        index++
      } catch {
        // Element may not be in DOM / off-screen — skip
      }
    }

    // Step 4: Inject canvas overlay
    const color = args.labelColor ?? '#e53e3e'
    const fontSize = args.fontSize ?? 11
    const refsJson = JSON.stringify(refs)
    const injectScript = `(function() {
      var existing = document.getElementById('${CANVAS_ID}');
      if (existing) existing.remove();
      var c = document.createElement('canvas');
      c.id = '${CANVAS_ID}';
      c.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;';
      c.width = window.innerWidth;
      c.height = window.innerHeight;
      document.documentElement.appendChild(c);
      var ctx = c.getContext('2d');
      var refs = ${refsJson};
      ctx.lineWidth = 2;
      ctx.font = 'bold ${fontSize}px monospace';
      refs.forEach(function(r) {
        if (r.x < 0 || r.y < 0 || r.x > c.width || r.y > c.height) return;
        ctx.strokeStyle = '${color}';
        ctx.strokeRect(r.x, r.y, r.width, r.height);
        var label = String(r.index);
        var tw = ctx.measureText(label).width;
        var lx = Math.max(0, r.x);
        var ly = Math.max(${fontSize} + 2, r.y);
        ctx.fillStyle = '${color}';
        ctx.fillRect(lx, ly - ${fontSize} - 2, tw + 4, ${fontSize} + 4);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, lx + 2, ly);
      });
      return refs.length;
    })()`

    try {
      await ctx.browser.evaluate(args.page, injectScript)
    } catch {
      // Canvas injection failed — take unannotated screenshot
    }

    // Step 5: Screenshot
    let screenshotData = ''
    let mimeType = 'image/png'
    try {
      const shot = await ctx.browser.screenshot(args.page, {
        format: 'png',
        fullPage: args.fullPage ?? false,
      })
      screenshotData = shot.data
      mimeType = shot.mimeType
    } catch (err) {
      // Remove canvas before erroring
      await ctx.browser.evaluate(args.page, `(function(){var c=document.getElementById('${CANVAS_ID}');if(c)c.remove();})()`).catch(() => {})
      response.error(`Screenshot failed: ${String(err)}`)
      return
    }

    // Step 6: Remove canvas
    await ctx.browser.evaluate(
      args.page,
      `(function(){var c=document.getElementById('${CANVAS_ID}');if(c)c.remove();})()`
    ).catch(() => {})

    // Build element map
    const elements: Record<string, { role: string; name: string; backendNodeId: number }> = {}
    for (const ref of refs) {
      elements[String(ref.index)] = {
        role: ref.role,
        name: ref.name,
        backendNodeId: ref.backendNodeId,
      }
    }

    const summary = refs
      .slice(0, 20)
      .map((r) => `  [${r.index}] ${r.role} "${r.name.slice(0, 40)}"`)
      .join('\n')
    const more = refs.length > 20 ? `\n  ... and ${refs.length - 20} more` : ''

    response.text(
      `Annotated screenshot — ${refs.length} interactive element(s) labelled:\n${summary}${more}`,
    )
    response.image(screenshotData, mimeType)
    response.data({ elementCount: refs.length, elements })
  },
})

// ── clear_visual_annotations ─────────────────────────────────────────────────

export const clear_visual_annotations = defineXcTool({
  name: 'clear_visual_annotations',
  description:
    'Remove any lingering annotation canvas overlay from the page. ' +
    'Call this if annotated_screenshot crashed or you want a clean view.',
  input: z.object({ page: pageParam }),
  output: z.object({ removed: z.boolean() }),
  handler: async (args, ctx, response) => {
    try {
      const result = await ctx.browser.evaluate(
        args.page,
        `(function(){var c=document.getElementById('${CANVAS_ID}');if(c){c.remove();return true;}return false;})()`
      )
      const removed = result?.value === true
      response.text(removed ? 'Annotation canvas removed.' : 'No annotation canvas found.')
      response.data({ removed })
    } catch {
      response.data({ removed: false })
    }
  },
})

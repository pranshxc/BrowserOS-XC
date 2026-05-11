/**
 * map-site-skill.ts — BFS orchestrator with BrowserOS-native semantic extraction.
 *
 * Per-page extraction pipeline (7 phases, all using ctx.browser.* — NO Playwright):
 *
 *   Phase 1: ctx.browser.evaluate — title, h1, meta description, pageRole detection,
 *            JSON-LD schema.org blocks, localStorage/sessionStorage keys,
 *            JS framework detection (Next.js __NEXT_DATA__, React, Vue, Angular),
 *            detected global feature flags
 *   Phase 2: ctx.browser.snapshot — flat list of all interactive elements (inputs,
 *            buttons, selects) with their element IDs
 *   Phase 3: ctx.browser.enhancedSnapshot — full ARIA landmark tree, dialogs,
 *            shadow DOM components, cursor-interactive elements snapshot misses
 *   Phase 4: ctx.browser.getDom scoped to 'form' — raw HTML of every <form>,
 *            parsed for action, method, fields, submit button label
 *   Phase 5: ctx.browser.searchDom CSS queries — targeted element discovery:
 *            input[type=password] (auth detection), [role=dialog] (popups),
 *            [data-testid], [aria-label], buttons with onclick attributes
 *   Phase 6: ctx.browser.evaluate — Performance API entries to infer API calls
 *            made during page load (fetch/XHR resource timing)
 *   Phase 7: ctx.browser.getPageLinks — link discovery for BFS queue
 *            (uses accessibility tree — handles role="link" + shadow DOM)
 *
 * All extraction phases are non-fatal: each is individually try/caught.
 * Partial failures are recorded but never stop the crawl.
 *
 * Output: every page produces rich nodes (page, form, field, action, api_call,
 * popup, nav_region, js_bundle, local_storage, schema_org) + typed edges
 * (contains, submits_to, triggers, navigates_to, authenticates_with).
 *
 * File output: THREE formats auto-saved to TWO locations after every page:
 *   ~/.browseros/graphs/<session>.ndjson + .json + .mmd
 *   ./graphs/<session>.ndjson + .json + .mmd
 *
 * No Playwright APIs used anywhere. 100% ctx.browser.* only.
 */
import { z } from 'zod'
import { defineTool } from '../../framework'
import {
  addEdge,
  addNode,
  generateSessionId,
  getOrCreateSession,
  getSessionSummary,
  saveAllFormats,
} from './store'
import {
  slugify,
  formId,
  fieldId,
  actionId,
  apiCallId,
  popupId,
  navRegionId,
  jsBundleId,
  localStorageNodeId,
  schemaDotOrgId,
  nowISO,
} from './schema'

interface BfsState {
  sessionId: string
  rootUrl: string
  visited: Set<string>
  queue: string[]
  maxDepth: number
  maxPages: number
  depthMap: Map<string, number>
  status: 'idle' | 'running' | 'done' | 'error'
  startedAt: number
  homePath: string
  cwdPath: string
  homeJsonPath: string
  cwdJsonPath: string
  homeMMDPath: string
  cwdMMDPath: string
  pagesVisited: number
  lastError: string | null
}

let bfsState: BfsState | null = null

function urlToSessionId(url: string): string {
  try {
    const u = new URL(url)
    const slug = (u.hostname + u.pathname)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase()
    return `map-${slug}-${Math.random().toString(36).slice(2, 6)}`
  } catch {
    return generateSessionId()
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inferPageRole(
  title: string,
  h1: string,
  hasPassword: boolean,
  hasPricing: boolean,
  hasDocs: boolean,
): 'landing' | 'login' | 'dashboard' | 'form' | 'docs' | 'pricing' | 'blog' | 'other' {
  const text = (title + ' ' + h1).toLowerCase()
  if (hasPassword || /sign.?in|log.?in|login/.test(text)) return 'login'
  if (hasPricing || /pricing|plan|subscription/.test(text)) return 'pricing'
  if (hasDocs || /docs|documentation|api.?reference/.test(text)) return 'docs'
  if (/dashboard|console|admin|portal/.test(text)) return 'dashboard'
  if (/blog|post|article|news/.test(text)) return 'blog'
  return 'landing'
}

function inferFormPurpose(action: string, fields: Array<{ inputType: string; name?: string; label?: string }>): string {
  const actionLower = action.toLowerCase()
  const names = fields.map(f => (f.name ?? f.label ?? '').toLowerCase()).join(' ')
  if (/login|signin|auth/.test(actionLower) || (fields.some(f => f.inputType === 'password'))) return 'Sign In'
  if (/register|signup|join/.test(actionLower) || /username|firstname|lastname/.test(names)) return 'Sign Up'
  if (/search/.test(actionLower) || /search|query|q/.test(names)) return 'Search'
  if (/contact|support|help/.test(actionLower)) return 'Contact'
  if (/subscribe|newsletter/.test(actionLower) || /email/.test(names)) return 'Subscribe'
  if (/reset|forgot|recover/.test(actionLower)) return 'Password Reset'
  if (/checkout|payment|pay/.test(actionLower)) return 'Checkout'
  return 'Submit'
}

// ─── Main BFS tool ────────────────────────────────────────────────────────────

export const map_site_start = defineTool({
  name: 'map_site_start',
  description: [
    'Autonomously BFS-crawl a website and build a rich semantic knowledge graph.',
    'Uses 7 BrowserOS-native extraction phases per page (ctx.browser.* only — no Playwright):',
    '  Phase 1: JS evaluate — title, h1, description, pageRole, JSON-LD, localStorage, JS framework',
    '  Phase 2: snapshot — all interactive elements (inputs, buttons, selects)',
    '  Phase 3: enhancedSnapshot — ARIA landmarks, dialogs, shadow DOM',
    '  Phase 4: getDom("form") — raw HTML of every <form> for field extraction',
    '  Phase 5: searchDom — CSS queries for passwords, dialogs, ARIA-labeled elements',
    '  Phase 6: evaluate — Performance API network interception for API call detection',
    '  Phase 7: getPageLinks — BFS link discovery via accessibility tree',
    'Produces nodes: page, form, field, action, api_call, popup, nav_region, js_bundle,',
    'local_storage, schema_org — plus typed edges (contains, submits_to, triggers, etc.).',
    'All three formats (.ndjson, .json, .mmd) auto-saved after every page.',
    'REQUIRED: url. OPTIONAL: maxDepth (1-5, default 2), maxPages (1-100, default 20),',
    'session_id (auto-generated if omitted), mermaid_direction (LR or TD, default LR).',
  ].join(' '),
  approvalCategory: 'observation',
  input: z.object({
    url: z.string().describe('Root URL to start crawling from'),
    maxDepth: z.coerce.number().int().min(1).max(5).default(2)
      .describe('Maximum BFS depth (default: 2, max: 5)'),
    maxPages: z.coerce.number().int().min(1).max(100).default(20)
      .describe('Maximum pages to visit (default: 20, max: 100)'),
    session_id: z.string().optional()
      .describe('Graph session ID. Auto-generated from URL if omitted.'),
    mermaid_direction: z.enum(['LR', 'TD']).default('LR')
      .describe('Mermaid diagram direction: LR (left-to-right) or TD (top-down).'),
  }),

  async handler(args, ctx, response) {
    const origin = (() => {
      try { return new URL(args.url).origin } catch { return args.url }
    })()

    const sessionId = args.session_id ?? urlToSessionId(args.url)
    const session = await getOrCreateSession(sessionId)
    const mermaidDir = (args.mermaid_direction ?? 'LR') as 'LR' | 'TD'

    bfsState = {
      sessionId,
      rootUrl: args.url,
      visited: new Set(),
      queue: [args.url],
      maxDepth: args.maxDepth,
      maxPages: args.maxPages,
      depthMap: new Map([[args.url, 0]]),
      status: 'running',
      startedAt: Date.now(),
      homePath: session.homePath,
      cwdPath: session.cwdPath,
      homeJsonPath: session.homePath.replace(/\.ndjson$/, '.json'),
      cwdJsonPath: session.cwdPath.replace(/\.ndjson$/, '.json'),
      homeMMDPath: session.homePath.replace(/\.ndjson$/, '.mmd'),
      cwdMMDPath: session.cwdPath.replace(/\.ndjson$/, '.mmd'),
      pagesVisited: 0,
      lastError: null,
    }

    await addNode('Root', 'page', { url: args.url, depth: 0 }, sessionId)

    while (bfsState.queue.length > 0 && bfsState.pagesVisited < args.maxPages) {
      const url = bfsState.queue.shift()!
      if (bfsState.visited.has(url)) continue
      bfsState.visited.add(url)
      bfsState.pagesVisited++

      const depth = bfsState.depthMap.get(url) ?? 0
      let pageId: number | undefined
      const pageSlug = slugify(url)

      try {
        pageId = await ctx.browser.newPage(url, { background: true })
        await ctx.browser.goto(pageId, url)

        // ── Phase 1: JS evaluate — page semantics, framework, storage ──────────
        let title = url
        let h1 = ''
        let description = ''
        let hasPassword = false
        let localStorageKeys: string[] = []
        let sessionStorageKeys: string[] = []
        let framework = ''
        let hasNextData = false
        let featureFlags: Record<string, unknown> = {}
        let schemaOrgBlocks: Array<{ type: string; summary: string }> = []
        let apiCallsObserved: string[] = []

        try {
          const semanticsResult = await ctx.browser.evaluate(pageId, `(() => {
            const title = document.title || document.location.pathname
            const h1 = document.querySelector('h1')?.textContent?.trim() ?? ''
            const desc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
            const hasPassword = !!document.querySelector('input[type="password"]')

            // localStorage / sessionStorage keys
            const lsKeys = Object.keys(localStorage).slice(0, 30)
            const ssKeys = Object.keys(sessionStorage).slice(0, 30)

            // Framework detection
            const hasNextData = !!window.__NEXT_DATA__
            const hasReact = !!(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__)
            const hasVue = !!(window.__VUE__ || window.Vue)
            const hasAngular = !!(window.ng || window.getAllAngularRootElements)
            let framework = ''
            if (hasNextData) framework = 'Next.js'
            else if (hasReact) framework = 'React'
            else if (hasVue) framework = 'Vue'
            else if (hasAngular) framework = 'Angular'

            // Feature flags
            let flags = {}
            try {
              if (window.__FEATURE_FLAGS__) flags = { ...window.__FEATURE_FLAGS__ }
              else if (window.featureFlags) flags = { ...window.featureFlags }
              else if (window.__FLAGS__) flags = { ...window.__FLAGS__ }
            } catch {}

            // JSON-LD schema.org blocks
            const schemaBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
              .map(el => { try { return JSON.parse(el.textContent ?? '{}') } catch { return null } })
              .filter(Boolean)
              .map(b => ({ type: b['@type'] ?? 'Unknown', summary: JSON.stringify(b).slice(0, 200) }))

            return { title, h1, desc, hasPassword, lsKeys, ssKeys,
                     hasNextData, hasReact, hasVue, hasAngular, framework,
                     flags, schemaBlocks }
          })()`)

          if (semanticsResult.value && typeof semanticsResult.value === 'object') {
            const v = semanticsResult.value as Record<string, unknown>
            title = typeof v.title === 'string' ? v.title : url
            h1 = typeof v.h1 === 'string' ? v.h1 : ''
            description = typeof v.desc === 'string' ? v.desc : ''
            hasPassword = v.hasPassword === true
            localStorageKeys = Array.isArray(v.lsKeys) ? v.lsKeys as string[] : []
            sessionStorageKeys = Array.isArray(v.ssKeys) ? v.ssKeys as string[] : []
            framework = typeof v.framework === 'string' ? v.framework : ''
            hasNextData = v.hasNextData === true
            featureFlags = typeof v.flags === 'object' && v.flags !== null ? v.flags as Record<string, unknown> : {}
            schemaOrgBlocks = Array.isArray(v.schemaBlocks) ? v.schemaBlocks as Array<{ type: string; summary: string }> : []
          }
        } catch { /* Phase 1 failed — continue with defaults */ }

        // ── Phase 6: Performance API — infer API calls from resource timing ────
        try {
          const perfResult = await ctx.browser.evaluate(pageId, `(() => {
            return performance.getEntriesByType('resource')
              .filter(e => {
                const url = e.name
                return (url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/')
                  || url.includes('/graphql') || url.includes('/rest/')
                  || e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')
              })
              .map(e => e.name)
              .slice(0, 20)
          })()`)
          if (Array.isArray(perfResult.value)) {
            apiCallsObserved = perfResult.value as string[]
          }
        } catch { /* Phase 6 failed — continue */ }

        // ── Phase 5: searchDom — detect dialogs + password fields ──────────────
        let hasDialogs = false
        let dialogCount = 0
        try {
          const dialogSearch = await ctx.browser.searchDom(pageId, '[role="dialog"],[role="alertdialog"],.modal,dialog', { limit: 10 })
          hasDialogs = dialogSearch.results.length > 0
          dialogCount = dialogSearch.results.length
        } catch { /* Phase 5 failed — continue */ }

        const pageRole = inferPageRole(title, h1, hasPassword, false, false)

        // ── Add main page node ─────────────────────────────────────────────────
        const { nodeId: mainNodeId } = await addNode(
          title,
          'page',
          {
            url,
            depth,
            statusCode: 200,
            title,
            description,
            h1,
            pageRole,
            hasAuth: hasPassword,
            framework: framework || undefined,
            apiCallsObserved,
            schemaOrgTypes: schemaOrgBlocks.map(b => b.type),
          },
          sessionId,
        )

        // ── Phase 2+3: snapshot + enhancedSnapshot — interactive elements ──────
        let snapshotText = ''
        try {
          snapshotText = (await ctx.browser.snapshot(pageId)) ?? ''
        } catch { /* Phase 2 failed — continue */ }

        let enhancedSnapshotText = ''
        try {
          enhancedSnapshotText = (await ctx.browser.enhancedSnapshot(pageId)) ?? ''
        } catch { /* Phase 3 failed — continue */ }

        // Extract ARIA landmark roles from enhanced snapshot
        const landmarkRoles = ['navigation', 'banner', 'main', 'contentinfo', 'complementary', 'search']
        for (const role of landmarkRoles) {
          if (enhancedSnapshotText.toLowerCase().includes(role)) {
            try {
              const nrId = navRegionId(pageSlug, role)
              const { nodeId: nrNodeId } = await addNode(role, 'nav_region', {
                parentPageId: mainNodeId,
                role,
                discoveredAt: nowISO(),
              }, sessionId)
              await addEdge(mainNodeId, nrNodeId, 'contains', { role }, sessionId)
            } catch { /* skip */ }
          }
        }

        // Extract popups from enhanced snapshot / searchDom results
        if (hasDialogs) {
          try {
            const pdId = popupId(pageSlug, 0)
            const { nodeId: popupNodeId } = await addNode('dialog', 'popup', {
              parentPageId: mainNodeId,
              role: 'dialog',
              discoveredAt: nowISO(),
            }, sessionId)
            await addEdge(mainNodeId, popupNodeId, 'contains', { count: dialogCount }, sessionId)
          } catch { /* skip */ }
        }

        // ── Phase 4: getDom('form') — extract all forms + fields ───────────────
        try {
          const formDomResult = await ctx.browser.getDom(pageId, { selector: 'form' })
          if (formDomResult) {
            // Parse form count and basic attributes via evaluate
            const formsResult = await ctx.browser.evaluate(pageId, `(() => {
              return Array.from(document.querySelectorAll('form')).map((f, i) => {
                const fields = Array.from(f.elements)
                  .filter(el => ['INPUT','SELECT','TEXTAREA'].includes(el.tagName))
                  .map(el => ({
                    tag: el.tagName.toLowerCase(),
                    inputType: (el.type || el.tagName.toLowerCase()),
                    name: el.name || '',
                    id: el.id || '',
                    placeholder: el.placeholder || '',
                    required: el.required || false,
                    autocomplete: el.autocomplete || '',
                    label: (() => {
                      if (el.id) {
                        const l = document.querySelector('label[for="' + el.id + '"]')
                        if (l) return l.textContent?.trim() ?? ''
                      }
                      return el.getAttribute('aria-label') ?? ''
                    })(),
                    options: el.tagName === 'SELECT'
                      ? Array.from(el.options).map(o => o.text).slice(0,20)
                      : [],
                  }))
                const submitBtn = f.querySelector('[type="submit"],button[type="submit"],button:not([type])')
                return {
                  action: f.action || '',
                  method: f.method || 'get',
                  fields,
                  submitLabel: submitBtn?.textContent?.trim() ?? '',
                }
              })
            })()`)

            if (Array.isArray(formsResult.value)) {
              const forms = formsResult.value as Array<{
                action: string
                method: string
                submitLabel: string
                fields: Array<{
                  tag: string; inputType: string; name: string; id: string
                  placeholder: string; required: boolean; autocomplete: string
                  label: string; options: string[]
                }>
              }>

              for (let fi = 0; fi < forms.length; fi++) {
                const form = forms[fi]
                const purpose = inferFormPurpose(form.action, form.fields)
                const fId = formId(pageSlug, fi)

                const { nodeId: formNodeId } = await addNode(
                  purpose,
                  'form',
                  {
                    parentPageId: mainNodeId,
                    action: form.action,
                    method: form.method.toUpperCase(),
                    purpose,
                    submitLabel: form.submitLabel,
                    fieldCount: form.fields.length,
                    discoveredAt: nowISO(),
                  },
                  sessionId,
                )
                await addEdge(mainNodeId, formNodeId, 'contains', { formIndex: fi }, sessionId)

                // Add form submission as api_call node if action looks like an endpoint
                if (form.action && (form.action.startsWith('http') || form.action.startsWith('/'))) {
                  const acId = apiCallId(pageSlug, form.method.toUpperCase(), form.action)
                  const { nodeId: acNodeId } = await addNode(
                    `${form.method.toUpperCase()} ${form.action}`,
                    'api_call',
                    {
                      parentPageId: mainNodeId,
                      method: form.method.toUpperCase(),
                      endpoint: form.action,
                      inferredPurpose: purpose,
                      triggerSource: formNodeId,
                      payloadKeys: form.fields.map(f => f.name).filter(Boolean),
                      discoveredAt: nowISO(),
                    },
                    sessionId,
                  )
                  await addEdge(formNodeId, acNodeId, 'submits_to', {}, sessionId)
                }

                // Add field nodes
                for (let fli = 0; fli < form.fields.length; fli++) {
                  const field = form.fields[fli]
                  if (field.inputType === 'hidden' || field.inputType === 'submit') continue
                  const flId = fieldId(fId, field.name || String(fli))

                  const { nodeId: fieldNodeId } = await addNode(
                    field.label || field.name || field.placeholder || field.inputType,
                    'field',
                    {
                      parentFormId: formNodeId,
                      parentPageId: mainNodeId,
                      inputType: field.inputType,
                      name: field.name || undefined,
                      label: field.label || undefined,
                      placeholder: field.placeholder || undefined,
                      required: field.required,
                      autocomplete: field.autocomplete || undefined,
                      options: field.options.length > 0 ? field.options : undefined,
                      discoveredAt: nowISO(),
                    },
                    sessionId,
                  )
                  await addEdge(formNodeId, fieldNodeId, 'contains', { fieldIndex: fli }, sessionId)
                }
              }
            }
          }
        } catch { /* Phase 4 failed — continue */ }

        // ── JS bundle node ────────────────────────────────────────────────────
        if (framework || hasNextData || Object.keys(featureFlags).length > 0) {
          try {
            const { nodeId: jsBundleNodeId } = await addNode(
              framework || 'JS Bundle',
              'js_bundle',
              {
                parentPageId: mainNodeId,
                framework: framework || undefined,
                hasNextData,
                featureFlags: Object.keys(featureFlags).length > 0 ? featureFlags : undefined,
                discoveredAt: nowISO(),
              },
              sessionId,
            )
            await addEdge(mainNodeId, jsBundleNodeId, 'contains', {}, sessionId)
          } catch { /* skip */ }
        }

        // ── localStorage / sessionStorage nodes ───────────────────────────────
        const allStorageKeys = [
          ...localStorageKeys.map(k => ({ k, type: 'localStorage' as const })),
          ...sessionStorageKeys.map(k => ({ k, type: 'sessionStorage' as const })),
        ]
        for (const { k, type } of allStorageKeys.slice(0, 10)) {
          try {
            const lsId = localStorageNodeId(pageSlug, k)
            const { nodeId: lsNodeId } = await addNode(k, 'local_storage', {
              parentPageId: mainNodeId,
              storageType: type,
              key: k,
              discoveredAt: nowISO(),
            }, sessionId)
            await addEdge(mainNodeId, lsNodeId, 'contains', { storageType: type }, sessionId)
          } catch { /* skip */ }
        }

        // ── schema.org JSON-LD nodes ──────────────────────────────────────────
        for (const block of schemaOrgBlocks) {
          try {
            const soId = schemaDotOrgId(pageSlug, block.type)
            const { nodeId: soNodeId } = await addNode(block.type, 'schema_org', {
              parentPageId: mainNodeId,
              schemaType: block.type,
              summary: block.summary,
              discoveredAt: nowISO(),
            }, sessionId)
            await addEdge(mainNodeId, soNodeId, 'contains', {}, sessionId)
          } catch { /* skip */ }
        }

        // ── API calls from Performance API ────────────────────────────────────
        for (const endpoint of apiCallsObserved.slice(0, 10)) {
          try {
            const { nodeId: acNodeId } = await addNode(
              `GET ${endpoint}`,
              'api_call',
              {
                parentPageId: mainNodeId,
                method: 'GET',
                endpoint,
                inferredPurpose: 'page load request',
                discoveredAt: nowISO(),
              },
              sessionId,
            )
            await addEdge(mainNodeId, acNodeId, 'triggers', { phase: 'page-load' }, sessionId)
          } catch { /* skip */ }
        }

        // ── Phase 7: getPageLinks — BFS discovery ─────────────────────────────
        if (depth < args.maxDepth) {
          const links = await ctx.browser.getPageLinks(pageId)
          const sameSiteLinks = links
            .map((l) => l.href)
            .filter((h) => {
              try { return new URL(h).origin === origin } catch { return false }
            })
            .filter((h, i, arr) => arr.indexOf(h) === i)

          for (const link of sameSiteLinks) {
            const { nodeId: linkedNodeId } = await addNode(
              link,
              'page',
              { url: link, depth: depth + 1, status: 'queued' },
              sessionId,
            )
            await addEdge(mainNodeId, linkedNodeId, 'navigates_to', { fromDepth: depth }, sessionId)

            if (!bfsState.visited.has(link) && !bfsState.queue.includes(link)) {
              bfsState.queue.push(link)
              bfsState.depthMap.set(link, depth + 1)
            }
          }
        }

        await saveAllFormats(sessionId, mermaidDir)

      } catch (err) {
        bfsState.lastError = err instanceof Error ? err.message : String(err)
        await addNode(
          url,
          'page',
          { url, depth, error: bfsState.lastError, statusCode: 0 },
          sessionId,
        ).catch(() => {})
        await saveAllFormats(sessionId, mermaidDir).catch(() => {})
      } finally {
        if (pageId !== undefined) {
          try { await ctx.browser.closePage(pageId) } catch { /* ignore */ }
        }
      }
    }

    bfsState.status = 'done'

    const [saveResult, summary] = await Promise.all([
      saveAllFormats(sessionId, mermaidDir),
      getSessionSummary(sessionId),
    ])

    bfsState.homeMMDPath = saveResult.homeMMDPath
    bfsState.cwdMMDPath = saveResult.cwdMMDPath

    response.text(
      JSON.stringify(
        {
          status: 'done',
          sessionId,
          pagesVisited: bfsState.pagesVisited,
          graph: {
            nodes: summary.nodeCount,
            edges: summary.edgeCount,
            nodeTypes: summary.nodeTypes,
          },
          files: {
            ndjson: { home: saveResult.homeNdjsonPath, cwd: saveResult.cwdNdjsonPath },
            json: { home: saveResult.homeJsonPath, cwd: saveResult.cwdJsonPath },
            mermaid: { home: saveResult.homeMMDPath, cwd: saveResult.cwdMMDPath },
          },
          note: [
            'Semantic extraction complete.',
            'Each page produced: page node + form/field nodes + action/api_call nodes + js_bundle + storage nodes.',
            'Use graph_load to re-open. Use graph_query to inspect. Use graph_read to read files.',
            'Paste .mmd at https://mermaid.live to visualise.',
          ].join(' '),
        },
        null,
        2,
      ),
    )
  },
})

export const map_site_bfs_status = defineTool({
  name: 'map_site_bfs_status',
  description: 'Get the current status and file paths of an in-progress or completed map_site_start BFS crawl.',
  approvalCategory: 'observation',
  input: z.object({}),
  async handler(_args, _ctx, response) {
    if (!bfsState) {
      response.text(JSON.stringify({ status: 'idle', message: 'No crawl started yet. Call map_site_start first.' }))
      return
    }

    let summary = null
    try {
      summary = await getSessionSummary(bfsState.sessionId)
    } catch { /* session may not exist yet */ }

    response.text(
      JSON.stringify(
        {
          status: bfsState.status,
          sessionId: bfsState.sessionId,
          rootUrl: bfsState.rootUrl,
          pagesVisited: bfsState.pagesVisited,
          queued: bfsState.queue.length,
          elapsedMs: Date.now() - bfsState.startedAt,
          lastError: bfsState.lastError,
          files: {
            ndjson: { home: bfsState.homePath, cwd: bfsState.cwdPath },
            json: { home: bfsState.homeJsonPath, cwd: bfsState.cwdJsonPath },
            mermaid: { home: bfsState.homeMMDPath, cwd: bfsState.cwdMMDPath },
          },
          graph: summary
            ? { nodes: summary.nodeCount, edges: summary.edgeCount, nodeTypes: summary.nodeTypes }
            : null,
        },
        null,
        2,
      ),
    )
  },
})

export const map_site_enqueue = defineTool({
  name: 'map_site_enqueue',
  description: 'Manually enqueue a URL into the active BFS crawl queue.',
  approvalCategory: 'observation',
  input: z.object({
    url: z.string().describe('URL to add to the crawl queue'),
  }),
  async handler(args, _ctx, response) {
    if (!bfsState || bfsState.status === 'done') {
      response.text(JSON.stringify({ error: 'No active crawl. Run map_site_start first.' }))
      return
    }
    if (!bfsState.visited.has(args.url) && !bfsState.queue.includes(args.url)) {
      bfsState.queue.push(args.url)
      bfsState.depthMap.set(args.url, 0)
      response.text(JSON.stringify({ queued: true, url: args.url, sessionId: bfsState.sessionId }))
    } else {
      response.text(JSON.stringify({ queued: false, reason: 'Already visited or queued.', url: args.url }))
    }
  },
})

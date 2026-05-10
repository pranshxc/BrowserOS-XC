/**
 * XC Phase 9 — Init Scripts (Page.addScriptToEvaluateOnNewDocument)
 *
 * Tools exported:
 *   add_init_script     — register a JS snippet to run on every new page load
 *   remove_init_script  — remove a previously registered init script by ID
 *   list_init_scripts   — list all registered init scripts for a page
 *   clear_init_scripts  — remove all init scripts from a page
 *
 * Architecture
 * ────────────
 * CDP Page.addScriptToEvaluateOnNewDocument registers JS that runs in the
 * main world BEFORE any page scripts (including framework boot code).
 * This is the only way to:
 *   • Intercept fetch/XHR from the very first request
 *   • Override window.fetch/XMLHttpRequest before the app patches them
 *   • Inject globals that the app code will see at startup
 *   • Hook Object.defineProperty to spy on property access
 *   • Patch Array.prototype or Promise for debugging
 *
 * Each init script is assigned a CDP identifier (a string like "1", "2").
 * We maintain a per-page registry (INIT_SCRIPTS map) that tracks the
 * label, source, CDP id, and timestamp for each script.
 *
 * Value to AI agent
 * ─────────────────
 * Use case 1 (Route monitoring):
 *   add_init_script with a script that records every History.pushState call
 *   → agent can later evaluate window.__xcNavigationLog to get all SPA
 *   navigations that happened, revealing the full router event timeline.
 *
 * Use case 2 (Network hook):
 *   add_init_script that wraps window.fetch to log every request URL into
 *   window.__xcFetchLog before delegating — captures ALL fetches including
 *   those from third-party SDKs that bypass the network-intercept tools.
 *
 * Use case 3 (Feature flag injection):
 *   add_init_script that sets window.FEATURE_FLAGS = { newCheckoutFlow: true }
 *   → forces the app into a feature-flagged state from the very first paint.
 *
 * Use case 4 (Error capture):
 *   add_init_script with window.onerror / unhandledrejection handlers that
 *   push errors into window.__xcErrors — catches errors that happen before
 *   the console listener in Phase 1 attaches.
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('js-engine')

// ── Per-page init script registry ─────────────────────────────────────────────

interface InitScriptEntry {
  id: string        // CDP identifier returned by addScriptToEvaluateOnNewDocument
  label: string     // Human-readable name
  source: string    // JS source code
  addedAt: number   // unix timestamp
}

const INIT_SCRIPTS: Map<number, InitScriptEntry[]> = new Map()

function getPageScripts(pageId: number): InitScriptEntry[] {
  if (!INIT_SCRIPTS.has(pageId)) INIT_SCRIPTS.set(pageId, [])
  return INIT_SCRIPTS.get(pageId)!
}

// ── CDP session type ───────────────────────────────────────────────────────────

type CdpSession = {
  Page: {
    enable: () => Promise<void>
    addScriptToEvaluateOnNewDocument: (p: { source: string; worldName?: string }) => Promise<{ identifier: string }>
    removeScriptToEvaluateOnNewDocument: (p: { identifier: string }) => Promise<void>
  }
  Runtime: {
    evaluate: (p: object) => Promise<{ result?: { value?: unknown }; exceptionDetails?: unknown }>
  }
}

// ── Built-in convenience scripts ───────────────────────────────────────────────

export const BUILTIN_INIT_SCRIPTS: Record<string, string> = {
  /**
   * Navigation logger — records every SPA route change into window.__xcNavLog.
   * Call evaluate_js({ code: 'JSON.stringify(window.__xcNavLog)' }) after
   * interacting with the site to get the full navigation timeline.
   */
  navigation_logger: /* js */ `
(function() {
  window.__xcNavLog = [];
  const _pushState = history.pushState.bind(history);
  const _replaceState = history.replaceState.bind(history);
  function record(type, url) {
    window.__xcNavLog.push({ type, url, ts: Date.now() });
  }
  history.pushState = function(state, title, url) {
    record('pushState', url);
    return _pushState(state, title, url);
  };
  history.replaceState = function(state, title, url) {
    record('replaceState', url);
    return _replaceState(state, title, url);
  };
  window.addEventListener('popstate', () => record('popstate', location.href));
  window.addEventListener('hashchange', () => record('hashchange', location.href));
})();
`,

  /**
   * Fetch logger — records every fetch call into window.__xcFetchLog.
   * Captures URL, method, and response status for all fetch calls.
   */
  fetch_logger: /* js */ `
(function() {
  window.__xcFetchLog = [];
  const _fetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
    const method = (init && init.method) || 'GET';
    const entry = { url, method, ts: Date.now(), status: null, durationMs: null };
    const idx = window.__xcFetchLog.push(entry) - 1;
    const start = Date.now();
    return _fetch(input, init).then(resp => {
      window.__xcFetchLog[idx].status = resp.status;
      window.__xcFetchLog[idx].durationMs = Date.now() - start;
      return resp;
    }, err => {
      window.__xcFetchLog[idx].error = err.message;
      window.__xcFetchLog[idx].durationMs = Date.now() - start;
      throw err;
    });
  };
})();
`,

  /**
   * Error capture — collects all uncaught errors and unhandled rejections.
   */
  error_capture: /* js */ `
(function() {
  window.__xcErrors = [];
  window.addEventListener('error', function(e) {
    window.__xcErrors.push({ type: 'error', message: e.message, filename: e.filename, lineno: e.lineno, ts: Date.now() });
  });
  window.addEventListener('unhandledrejection', function(e) {
    window.__xcErrors.push({ type: 'unhandledrejection', reason: String(e.reason), ts: Date.now() });
  });
})();
`,

  /**
   * Console capture — captures all console.log/warn/error calls into
   * window.__xcConsoleLog for later retrieval.
   */
  console_capture: /* js */ `
(function() {
  window.__xcConsoleLog = [];
  const levels = ['log', 'warn', 'error', 'info', 'debug'];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = function(...args) {
      window.__xcConsoleLog.push({ level, args: args.map(a => {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(e) { return String(a); }
      }), ts: Date.now() });
      return original(...args);
    };
  }
})();
`,
}

// ── Tools ──────────────────────────────────────────────────────────────────────

export const add_init_script = defineXcTool({
  name: 'add_init_script',
  description:
    'Register a JavaScript snippet to run on every new page load, BEFORE any site JS executes. ' +
    'Essential for injecting monitoring hooks. ' +
    'Built-in convenience scripts (pass as `builtin` parameter): ' +
    Object.keys(BUILTIN_INIT_SCRIPTS)
      .map((k) => `"${k}"`)
      .join(', ') +
    '. ' +
    'Or pass custom JS via the `source` parameter. ' +
    'Returns a script ID that can be used to remove the script later.',
  input: z.object({
    page: pageParam,
    label: z
      .string()
      .describe('Human-readable name for this init script (for management)'),
    source: z
      .string()
      .optional()
      .describe('Custom JavaScript to run on page load. Required if builtin is not set.'),
    builtin: z
      .enum(['navigation_logger', 'fetch_logger', 'error_capture', 'console_capture'])
      .optional()
      .describe('Use a built-in convenience script instead of writing custom JS.'),
    worldName: z
      .string()
      .optional()
      .describe(
        'Optional isolated world name. If omitted, script runs in the main world ' +
        '(same context as page JS). Use an isolated world for non-interfering observers.',
      ),
  }),
  output: z.object({
    id: z.string(),
    label: z.string(),
    worldName: z.string().optional(),
  }),
  handler: async (args, ctx, response) => {
    const js = args.builtin ? BUILTIN_INIT_SCRIPTS[args.builtin] : args.source
    if (!js) {
      response.error('Either `source` or `builtin` must be provided.')
      return
    }

    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    await cdp.Page.enable()

    const addParams: { source: string; worldName?: string } = { source: js }
    if (args.worldName) addParams.worldName = args.worldName

    const { identifier } = await cdp.Page.addScriptToEvaluateOnNewDocument(addParams)

    const entry: InitScriptEntry = {
      id: identifier,
      label: args.label,
      source: js,
      addedAt: Date.now(),
    }
    getPageScripts(args.page).push(entry)

    response.text(
      `Init script registered (id: ${identifier})\n` +
      `Label: ${args.label}\n` +
      `World: ${args.worldName ?? 'main'}\n` +
      `Source length: ${js.length} chars\n` +
      `Will run before any site JS on every new document load.`,
    )
    response.data({ id: identifier, label: args.label, worldName: args.worldName })
  },
})

export const remove_init_script = defineXcTool({
  name: 'remove_init_script',
  description:
    'Remove a previously registered init script by its ID (from add_init_script). ' +
    'The script will no longer run on subsequent page loads. ' +
    'Current page context is not affected — only future navigations.',
  input: z.object({
    page: pageParam,
    id: z.string().describe('Init script identifier (from add_init_script or list_init_scripts)'),
  }),
  output: z.object({ removed: z.boolean(), id: z.string() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    try {
      await cdp.Page.removeScriptToEvaluateOnNewDocument({ identifier: args.id })
    } catch (e) {
      response.error(`Failed to remove init script: ${(e as Error).message}`)
      return
    }

    // Remove from local registry
    const scripts = getPageScripts(args.page)
    const idx = scripts.findIndex((s) => s.id === args.id)
    if (idx !== -1) scripts.splice(idx, 1)

    response.text(`Init script removed: ${args.id}`)
    response.data({ removed: true, id: args.id })
  },
})

export const list_init_scripts = defineXcTool({
  name: 'list_init_scripts',
  description:
    'List all init scripts currently registered for a page, with their IDs, labels, and registration time.',
  input: z.object({ page: pageParam }),
  output: z.object({
    scripts: z.array(z.any()),
    count: z.number(),
  }),
  handler: async (args, _ctx, response) => {
    const scripts = getPageScripts(args.page)

    if (scripts.length === 0) {
      response.text('No init scripts registered for this page.')
      response.data({ scripts: [], count: 0 })
      return
    }

    const lines = scripts.map(
      (s) =>
        `  [${s.id}] ${s.label}\n    Added: ${new Date(s.addedAt).toISOString()} | Source: ${s.source.length} chars`,
    )
    response.text(`Init scripts (${scripts.length}):\n${lines.join('\n')}`)
    response.data({
      scripts: scripts.map((s) => ({ id: s.id, label: s.label, addedAt: s.addedAt, sourceLength: s.source.length })),
      count: scripts.length,
    })
  },
})

export const clear_init_scripts = defineXcTool({
  name: 'clear_init_scripts',
  description:
    'Remove ALL init scripts registered for a page. ' +
    'Use before starting a fresh analysis session to avoid stale hooks.',
  input: z.object({ page: pageParam }),
  output: z.object({ removed: z.number() }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const cdp = session as unknown as CdpSession
    const scripts = getPageScripts(args.page)

    let removed = 0
    for (const s of scripts) {
      try {
        await cdp.Page.removeScriptToEvaluateOnNewDocument({ identifier: s.id })
        removed++
      } catch { /* ignore individual failures */ }
    }
    INIT_SCRIPTS.set(args.page, [])

    response.text(`Removed ${removed} init scripts from page ${args.page}.`)
    response.data({ removed })
  },
})

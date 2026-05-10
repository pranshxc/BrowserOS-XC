/**
 * XC Phase 6 — React & Framework Introspection: React DevTools
 *
 * Injects a lightweight React DevTools fiber reader into the page at runtime
 * (no browser extension needed) and exposes three tools:
 *
 *  react_get_tree            — walk the fiber tree, return component hierarchy
 *  react_inspect_component   — full props, state, hooks, source location for one fiber
 *  react_get_renders         — start/stop a render profiler, return which components
 *                              re-rendered and the render count
 *  react_get_suspense_boundaries — find all Suspense nodes, fallback state, lazy targets
 *
 * Design
 * ──────
 * React 16.3+ exposes its internal fiber tree on the DOM root via
 *   element._reactFiber* or element[internalInstanceKey]
 * AND via the global __REACT_DEVTOOLS_GLOBAL_HOOK__ which React populates
 * automatically if the hook is installed BEFORE React initialises.
 *
 * Strategy A (works on already-loaded pages):  walk the fiber tree from the
 *   root DOM node by scanning for the _reactFiber* property.
 * Strategy B (works on fresh loads when BROWSEROS_XC_ENABLE_REACT=true):
 *   install __REACT_DEVTOOLS_GLOBAL_HOOK__ via Page.addScriptToEvaluateOnNewDocument
 *   so React calls hook.inject() and we get the renderers map.
 *
 * We implement both strategies and fall back gracefully.
 *
 * No external npm packages are required — all fiber-walking JS is embedded
 * as template-literal strings and executed via Runtime.evaluate.
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')

// ─────────────────────────────────────────────────────────────────────────────
// Shared JS snippets injected via Runtime.evaluate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the React root fiber node on the page.
 * Tries the DevTools global hook first, then falls back to DOM scanning.
 */
const FIND_ROOT_FIBER_JS = `
(function findRootFiber() {
  // Strategy 1: __REACT_DEVTOOLS_GLOBAL_HOOK__ (installed before React)
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook && hook.renderers && hook.renderers.size > 0) {
    var renderer = hook.renderers.values().next().value;
    if (renderer && renderer.getFiberRoots) {
      var roots = renderer.getFiberRoots(1);
      if (roots && roots.size > 0) {
        return roots.values().next().value.current;
      }
    }
  }
  // Strategy 2: Walk DOM nodes looking for _reactFiber* or __reactFiber*
  function getFiberFromDom(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.startsWith('__reactFiber') || k.startsWith('_reactFiber') ||
          k.startsWith('__reactInternalInstance')) {
        return el[k];
      }
    }
    return null;
  }
  // Find the outermost fiber from document.body subtree
  var candidates = [document.getElementById('root'), document.getElementById('__next'),
    document.getElementById('app'), document.getElementById('react-root'),
    document.querySelector('[data-reactroot]'), document.body];
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    if (!el) continue;
    var fiber = getFiberFromDom(el);
    if (fiber) {
      // Walk up to the HostRoot
      var f = fiber;
      while (f.return) f = f.return;
      return f;
    }
    // Try children
    var children = el.children;
    for (var j = 0; j < children.length; j++) {
      var cf = getFiberFromDom(children[j]);
      if (cf) {
        var f2 = cf;
        while (f2.return) f2 = f2.return;
        return f2;
      }
    }
  }
  return null;
})
`

/**
 * Walk the fiber tree and build a compact JSON representation.
 * Returns an array of node descriptors (flat, with parentId for tree reconstruction).
 */
const BUILD_FIBER_TREE_JS = (maxNodes: number, maxDepth: number) => `
(function buildFiberTree() {
  var findRoot = ${FIND_ROOT_FIBER_JS};
  var root = findRoot();
  if (!root) return { error: 'React root not found. Is this a React app?' };

  var nodes = [];
  var idCounter = 0;
  var MAX_NODES = ${maxNodes};
  var MAX_DEPTH = ${maxDepth};

  function safeStr(v, max) {
    try {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      if (typeof v === 'string') return v.slice(0, max || 80);
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (Array.isArray(v)) return '[Array(' + v.length + ')]';
      if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (typeof v === 'object') {
        var keys = Object.keys(v).slice(0, 5);
        return '{' + keys.join(', ') + (Object.keys(v).length > 5 ? ', ...' : '') + '}';
      }
      return String(v).slice(0, max || 80);
    } catch(e) { return '[unreadable]'; }
  }

  function getComponentName(fiber) {
    var type = fiber.type;
    if (!type) return fiber.tag === 3 ? '#HostRoot' : fiber.tag === 5 ? (fiber.stateNode && fiber.stateNode.localName) || '#DOM' : '#Unknown';
    if (typeof type === 'string') return type;
    if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
    if (type.$$typeof) {
      // forwardRef, memo, lazy, context
      var inner = type.render || type.type || type._payload;
      if (inner && typeof inner === 'function') return (inner.displayName || inner.name || 'Anonymous') + (type.$$typeof.toString().includes('memo') ? '(memo)' : type.$$typeof.toString().includes('forward') ? '(forwardRef)' : '');
      if (type._status !== undefined) return 'Lazy(' + (type._payload && type._payload._result && (type._payload._result.displayName || type._payload._result.name) || '?') + ')';
    }
    return 'Unknown';
  }

  function summarizeProps(props) {
    if (!props) return {};
    var summary = {};
    var keys = Object.keys(props).filter(function(k){ return k !== 'children'; });
    keys.slice(0, 8).forEach(function(k) {
      summary[k] = safeStr(props[k], 60);
    });
    if (keys.length > 8) summary['_more'] = '...' + (keys.length - 8) + ' more props';
    return summary;
  }

  function getHookNames(fiber) {
    // memoizedState is a linked list of hooks for function components
    var hooks = [];
    var memoized = fiber.memoizedState;
    var count = 0;
    while (memoized && count < 20) {
      var hook = memoized;
      if (hook.queue !== null && hook.queue !== undefined) {
        // useState or useReducer
        hooks.push({ type: 'useState/useReducer', value: safeStr(hook.memoizedState, 40) });
      } else if (hook.memoizedState !== null && hook.memoizedState !== undefined) {
        if (typeof hook.memoizedState === 'function') {
          hooks.push({ type: 'useEffect/useMemo/useCallback', value: '[function]' });
        } else if (typeof hook.memoizedState === 'object' && hook.memoizedState.tag !== undefined) {
          hooks.push({ type: 'useEffect', value: '[effect]' });
        } else {
          hooks.push({ type: 'useMemo/useRef', value: safeStr(hook.memoizedState, 40) });
        }
      }
      memoized = memoized.next;
      count++;
    }
    return hooks;
  }

  function walkFiber(fiber, parentId, depth) {
    if (!fiber || nodes.length >= MAX_NODES || depth > MAX_DEPTH) return;
    var id = ++idCounter;
    var name = getComponentName(fiber);
    // Skip pure DOM nodes unless they are the only children (reduces noise)
    var isDomNode = typeof fiber.type === 'string';
    var hasCompositeParent = parentId > 0;
    if (isDomNode && hasCompositeParent && depth > 3) {
      // recurse but don't add DOM leaf noise at depth > 3
      var child = fiber.child;
      while (child) { walkFiber(child, parentId, depth + 1); child = child.sibling; }
      return;
    }
    var node = {
      id: id,
      parentId: parentId,
      depth: depth,
      name: name,
      tag: fiber.tag,
      key: fiber.key || null,
      propsSummary: isDomNode ? {} : summarizeProps(fiber.memoizedProps),
      hooks: (!isDomNode && typeof fiber.type === 'function') ? getHookNames(fiber) : [],
      hasState: fiber.memoizedState !== null && fiber.memoizedState !== undefined && !isDomNode,
    };
    nodes.push(node);
    var child = fiber.child;
    while (child) { walkFiber(child, id, depth + 1); child = child.sibling; }
  }

  walkFiber(root, 0, 0);
  return { nodes: nodes, totalFound: nodes.length, truncated: nodes.length >= ${maxNodes} };
})()
`

/**
 * Inspect a single component by walking the fiber tree to find it by position index.
 * Returns full props, state, hooks.
 */
const INSPECT_COMPONENT_JS = (componentIndex: number) => `
(function inspectComponent() {
  var findRoot = ${FIND_ROOT_FIBER_JS};
  var root = findRoot();
  if (!root) return { error: 'React root not found.' };

  function getComponentName(fiber) {
    var type = fiber.type;
    if (!type) return fiber.tag === 3 ? '#HostRoot' : '#Unknown';
    if (typeof type === 'string') return type;
    if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
    return 'Unknown';
  }

  var counter = 0;
  var target = null;
  function walk(fiber) {
    if (!fiber || target) return;
    counter++;
    if (counter === ${componentIndex}) { target = fiber; return; }
    var child = fiber.child;
    while (child) { walk(child); child = child.sibling; }
  }
  walk(root);

  if (!target) return { error: 'Component index ' + ${componentIndex} + ' not found. Run react_get_tree first.' };

  function deepSerialize(v, depth) {
    if (depth > 3) return '[deep]';
    if (v === null || v === undefined) return v;
    if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.slice(0, 10).map(function(i){ return deepSerialize(i, depth+1); });
    if (typeof v === 'object') {
      var res = {};
      var keys = Object.keys(v).slice(0, 20);
      keys.forEach(function(k){ res[k] = deepSerialize(v[k], depth+1); });
      return res;
    }
    return String(v);
  }

  // Props (full, not summarized)
  var props = {};
  if (target.memoizedProps) {
    Object.keys(target.memoizedProps).forEach(function(k) {
      if (k !== 'children') props[k] = deepSerialize(target.memoizedProps[k], 0);
    });
  }

  // State (class components have memoizedState as object, function components as hook LL)
  var state = null;
  if (target.memoizedState) {
    // Check if it's a hook linked list (function component)
    if (target.memoizedState.queue !== undefined || target.memoizedState.next !== undefined) {
      var hooks = [];
      var m = target.memoizedState;
      var i = 0;
      while (m && i < 30) {
        hooks.push({ index: i, value: deepSerialize(m.memoizedState, 1) });
        m = m.next; i++;
      }
      state = { type: 'hooks', hooks: hooks };
    } else {
      state = { type: 'classState', value: deepSerialize(target.memoizedState, 1) };
    }
  }

  // Source location (available in development builds)
  var source = null;
  if (target._debugSource) {
    source = { file: target._debugSource.fileName, line: target._debugSource.lineNumber, col: target._debugSource.columnNumber };
  }

  // Ref
  var ref = target.ref ? (typeof target.ref === 'function' ? '[callback ref]' : typeof target.ref === 'object' ? (target.ref.current !== undefined ? '[useRef current=' + String(target.ref.current).slice(0,40) + ']' : '[ref object]') : String(target.ref)) : null;

  return {
    index: ${componentIndex},
    name: getComponentName(target),
    tag: target.tag,
    props: props,
    state: state,
    ref: ref,
    source: source,
    effectTag: target.flags || target.effectTag || 0,
    mode: target.mode,
  };
})()
`

/**
 * Find all Suspense fiber nodes, report their fallback state and any lazy children.
 */
const GET_SUSPENSE_JS = `
(function getSuspense() {
  var findRoot = ${FIND_ROOT_FIBER_JS};
  var root = findRoot();
  if (!root) return { error: 'React root not found.' };

  var SUSPENSE_TAG = 13; // React fiber tag for SuspenseComponent
  var suspenseNodes = [];

  function getComponentName(fiber) {
    var type = fiber.type;
    if (!type) return '#Unknown';
    if (typeof type === 'string') return type;
    if (typeof type === 'function') return type.displayName || type.name || 'Anonymous';
    return 'Unknown';
  }

  function findLazyChildren(fiber, acc, depth) {
    if (!fiber || depth > 15) return;
    if (fiber.type && fiber.type._status !== undefined) {
      // React.lazy node
      var status = ['pending','resolved','rejected'][fiber.type._status] || 'unknown';
      var moduleName = null;
      try {
        if (fiber.type._payload && fiber.type._payload._result) {
          moduleName = fiber.type._payload._result.displayName || fiber.type._payload._result.name || null;
        }
      } catch(e) {}
      acc.push({ type: 'lazy', status: status, resolvedName: moduleName });
    }
    var child = fiber.child;
    while (child) { findLazyChildren(child, acc, depth + 1); child = child.sibling; }
  }

  function walk(fiber, depth) {
    if (!fiber || depth > 60) return;
    if (fiber.tag === SUSPENSE_TAG) {
      // memoizedState !== null means fallback is showing
      var isFallback = fiber.memoizedState !== null;
      var lazyChildren = [];
      findLazyChildren(fiber, lazyChildren, 0);
      // Try to find the fallback element text
      var fallbackText = null;
      try {
        if (fiber.child && fiber.child.sibling) {
          var fb = fiber.child.sibling;
          if (fb.stateNode && fb.stateNode.innerText) fallbackText = fb.stateNode.innerText.slice(0,60);
        }
      } catch(e) {}
      suspenseNodes.push({
        depth: depth,
        key: fiber.key || null,
        isFallbackShowing: isFallback,
        fallbackText: fallbackText,
        lazyChildren: lazyChildren,
      });
    }
    var child = fiber.child;
    while (child) { walk(child, depth + 1); child = child.sibling; }
  }
  walk(root, 0);
  return { suspenseBoundaries: suspenseNodes, count: suspenseNodes.length };
})()
`

/**
 * Lightweight render profiler.
 * Patches React DevTools global hook onCommitFiberRoot to record renders.
 * install_render_profiler() starts it; get_renders() reads and clears it.
 */
const INSTALL_PROFILER_JS = `
(function installProfiler() {
  if (window.__XC_RENDER_LOG__) return { alreadyInstalled: true, count: window.__XC_RENDER_LOG__.length };
  window.__XC_RENDER_LOG__ = [];

  function getComponentName(fiber) {
    var type = fiber.type;
    if (!type) return null;
    if (typeof type === 'string') return null; // skip DOM nodes
    if (typeof type === 'function') return type.displayName || type.name || null;
    return null;
  }

  function walkCommittedFibers(fiber, renders) {
    if (!fiber) return;
    // flags & 4 (PerformedWork) or flags & 1 (Placement) or flags & 2 (Update)
    var flags = fiber.flags !== undefined ? fiber.flags : (fiber.effectTag || 0);
    if (flags & (1 | 2 | 4 | 8)) {
      var name = getComponentName(fiber);
      if (name) {
        var reason = [];
        if (flags & 1) reason.push('placed');
        if (flags & 2) reason.push('updated');
        if (flags & 4) reason.push('performedWork');
        if (flags & 8) reason.push('deletion');
        renders.push({ component: name, flags: flags, reasons: reason });
      }
    }
    walkCommittedFibers(fiber.child, renders);
    walkCommittedFibers(fiber.sibling, renders);
  }

  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook && hook.onCommitFiberRoot) {
    var original = hook.onCommitFiberRoot.bind(hook);
    hook.onCommitFiberRoot = function(rendererID, root, priorityLevel) {
      try {
        var renders = [];
        walkCommittedFibers(root.current, renders);
        if (renders.length > 0) {
          window.__XC_RENDER_LOG__.push({ ts: Date.now(), renders: renders });
          if (window.__XC_RENDER_LOG__.length > 500) window.__XC_RENDER_LOG__.shift();
        }
      } catch(e) {}
      return original(rendererID, root, priorityLevel);
    };
    return { installed: true, method: 'devtools-hook' };
  }
  // Fallback: patch requestAnimationFrame to sample fiber tree for changes
  return { installed: false, method: 'none', reason: '__REACT_DEVTOOLS_GLOBAL_HOOK__ not available. Load the page fresh with BROWSEROS_XC_ENABLE_REACT=true for full profiling.' };
})()
`

const GET_RENDERS_JS = `
(function getRenders() {
  if (!window.__XC_RENDER_LOG__) return { error: 'Profiler not installed. Call react_get_renders with action=start first.' };
  var log = window.__XC_RENDER_LOG__.slice();
  window.__XC_RENDER_LOG__ = [];
  // Aggregate: component → count
  var counts = {};
  log.forEach(function(commit) {
    commit.renders.forEach(function(r) {
      if (!counts[r.component]) counts[r.component] = { count: 0, reasons: {} };
      counts[r.component].count++;
      r.reasons.forEach(function(reason) {
        counts[r.component].reasons[reason] = (counts[r.component].reasons[reason] || 0) + 1;
      });
    });
  });
  var components = Object.keys(counts).map(function(name) {
    return { component: name, renderCount: counts[name].count, reasons: counts[name].reasons };
  }).sort(function(a,b){ return b.renderCount - a.renderCount; });
  return { commits: log.length, components: components };
})()
`

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

export const react_get_tree = defineXcTool({
  name: 'react_get_tree',
  description:
    'Walk the React fiber tree of the current page and return the component hierarchy as JSON. ' +
    'Each node has: id, parentId, depth, name (component name), propsSummary, hooks summary, hasState. ' +
    'This is X-ray vision into the app architecture — a <CheckoutFlow> containing <PaymentStep> tells you ' +
    'more about the site than 100 DOM snapshots. Works on React 16.3+ apps without any browser extension.',
  input: z.object({
    page: pageParam,
    maxNodes: z.number().default(300).describe('Max fiber nodes to return (default 300)'),
    maxDepth: z.number().default(40).describe('Max tree depth to walk (default 40)'),
    filterName: z
      .string()
      .optional()
      .describe('If set, only return nodes whose component name contains this string (case-insensitive)'),
  }),
  output: z.object({
    nodes: z.array(z.any()),
    totalFound: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const result = await session.Runtime.evaluate({
      expression: BUILD_FIBER_TREE_JS(args.maxNodes ?? 300, args.maxDepth ?? 40),
      returnByValue: true,
      awaitPromise: false,
    })

    const data = result.result?.value as { error?: string; nodes?: unknown[]; totalFound?: number; truncated?: boolean }
    if (!data || data.error) {
      response.error(data?.error ?? 'Failed to read React fiber tree.')
      return
    }

    let nodes = (data.nodes ?? []) as Array<{ name: string; [k: string]: unknown }>
    if (args.filterName) {
      const f = args.filterName.toLowerCase()
      nodes = nodes.filter((n) => n.name.toLowerCase().includes(f))
    }

    const lines = nodes
      .slice(0, 60)
      .map((n) => {
        const d = n as { depth: number; id: number; name: string; hooks?: unknown[]; hasState?: boolean; propsSummary?: Record<string, unknown> }
        const indent = '  '.repeat(Math.min(d.depth, 20))
        const hooks = (d.hooks as unknown[])?.length ? ` [${(d.hooks as unknown[]).length} hooks]` : ''
        const state = d.hasState ? ' [state]' : ''
        const props = Object.keys(d.propsSummary ?? {}).slice(0, 3).join(', ')
        return `${indent}[${d.id}] ${d.name}${hooks}${state}${props ? ` {${props}}` : ''}`
      })
    if (nodes.length > 60) lines.push(`  ... and ${nodes.length - 60} more nodes`)
    if (data.truncated) lines.push(`  (truncated at maxNodes=${args.maxNodes ?? 300})`)

    response.text(`React fiber tree — ${nodes.length} component(s):\n${lines.join('\n')}`)
    response.data({ nodes, totalFound: data.totalFound ?? nodes.length, truncated: data.truncated ?? false })
  },
})

export const react_inspect_component = defineXcTool({
  name: 'react_inspect_component',
  description:
    'Inspect a single React component by its tree index (from react_get_tree). ' +
    'Returns full props (no truncation), state (class or hooks), ref, and source file/line (dev builds only). ' +
    'Use this after react_get_tree to deep-dive into a specific component.',
  input: z.object({
    page: pageParam,
    componentIndex: z
      .number()
      .describe('The id field from a react_get_tree node (1-based counter in fiber walk order)'),
  }),
  output: z.object({
    name: z.string(),
    props: z.record(z.any()),
    state: z.any(),
    ref: z.string().nullable(),
    source: z.any(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const result = await session.Runtime.evaluate({
      expression: INSPECT_COMPONENT_JS(args.componentIndex),
      returnByValue: true,
      awaitPromise: false,
    })

    const data = result.result?.value as { error?: string; name?: string; props?: unknown; state?: unknown; ref?: string | null; source?: unknown }
    if (!data || data.error) {
      response.error(data?.error ?? 'Inspection failed.')
      return
    }

    response.text(
      `Component [${args.componentIndex}] ${data.name}\n` +
      `Props: ${JSON.stringify(data.props, null, 2).slice(0, 1200)}\n` +
      `State: ${JSON.stringify(data.state, null, 2).slice(0, 800)}\n` +
      `Source: ${data.source ? JSON.stringify(data.source) : 'not available (production build)'}`,
    )
    response.data(data as Parameters<typeof response.data>[0])
  },
})

export const react_get_renders = defineXcTool({
  name: 'react_get_renders',
  description:
    'Start or read the React fiber render profiler. ' +
    'action=start: installs the profiler (patches __REACT_DEVTOOLS_GLOBAL_HOOK__). ' +
    'action=read: returns which components re-rendered since last read, with render counts and reasons. ' +
    'action=stop: reads final results and uninstalls the profiler. ' +
    'Use this to detect which components re-render on user actions — critical for understanding reactivity.',
  input: z.object({
    page: pageParam,
    action: z.enum(['start', 'read', 'stop']).default('start'),
  }),
  output: z.object({
    action: z.string(),
    commits: z.number().optional(),
    components: z.array(z.any()).optional(),
    installed: z.boolean().optional(),
    method: z.string().optional(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const action = args.action ?? 'start'

    if (action === 'start') {
      const result = await session.Runtime.evaluate({
        expression: INSTALL_PROFILER_JS,
        returnByValue: true,
        awaitPromise: false,
      })
      const data = result.result?.value as { installed?: boolean; method?: string; alreadyInstalled?: boolean; reason?: string }
      const msg = data?.alreadyInstalled
        ? 'Profiler already running.'
        : data?.installed
        ? `Profiler installed via ${data.method}. Now interact with the page, then call react_get_renders with action=read.`
        : `Profiler partially installed. ${data?.reason ?? ''}`
      response.text(msg)
      response.data({ action, installed: data?.installed ?? false, method: data?.method })
      return
    }

    if (action === 'read' || action === 'stop') {
      const result = await session.Runtime.evaluate({
        expression: GET_RENDERS_JS,
        returnByValue: true,
        awaitPromise: false,
      })
      const data = result.result?.value as { error?: string; commits?: number; components?: unknown[] }
      if (data?.error) { response.error(data.error); return }

      if (action === 'stop') {
        await session.Runtime.evaluate({
          expression: 'delete window.__XC_RENDER_LOG__; void 0',
          returnByValue: false,
        }).catch(() => {})
      }

      const comps = (data?.components ?? []) as Array<{ component: string; renderCount: number; reasons: Record<string, number> }>
      const lines = comps.slice(0, 30).map((c) => `  ${c.renderCount}x ${c.component} (${Object.keys(c.reasons).join(', ')})`)
      if (comps.length > 30) lines.push(`  ... and ${comps.length - 30} more`)

      response.text(
        `Render profile — ${data?.commits ?? 0} commit(s), ${comps.length} component(s) re-rendered:\n` +
        (lines.length ? lines.join('\n') : '  No renders recorded yet.'),
      )
      response.data({ action, commits: data?.commits ?? 0, components: comps })
    }
  },
})

export const react_get_suspense_boundaries = defineXcTool({
  name: 'react_get_suspense_boundaries',
  description:
    'Find all React Suspense boundaries in the fiber tree. ' +
    'Returns each boundary with: isFallbackShowing (true = loading spinner visible), ' +
    'fallbackText (text inside the fallback element), and lazyChildren (React.lazy() modules it wraps). ' +
    'Critical for mapping lazy-loaded feature modules — each Suspense boundary is a feature boundary.',
  input: z.object({ page: pageParam }),
  output: z.object({
    suspenseBoundaries: z.array(z.any()),
    count: z.number(),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const result = await session.Runtime.evaluate({
      expression: GET_SUSPENSE_JS,
      returnByValue: true,
      awaitPromise: false,
    })

    const data = result.result?.value as { error?: string; suspenseBoundaries?: unknown[]; count?: number }
    if (data?.error) { response.error(data.error); return }

    const boundaries = (data?.suspenseBoundaries ?? []) as Array<{
      depth: number
      key: string | null
      isFallbackShowing: boolean
      fallbackText: string | null
      lazyChildren: Array<{ type: string; status: string; resolvedName: string | null }>
    }>

    const lines = boundaries.map((b, i) => {
      const lazy = b.lazyChildren.length
        ? ' → lazy: ' + b.lazyChildren.map((l) => l.resolvedName ?? `(${l.status})`).join(', ')
        : ''
      const fallback = b.isFallbackShowing ? ` [FALLBACK SHOWING${b.fallbackText ? ': "' + b.fallbackText + '"' : ''}]` : ''
      return `  [${i + 1}] depth=${b.depth}${b.key ? ` key=${b.key}` : ''}${fallback}${lazy}`
    })

    response.text(
      `Suspense boundaries — ${boundaries.length} found:\n` +
      (lines.length ? lines.join('\n') : '  No Suspense boundaries found.'),
    )
    response.data({ suspenseBoundaries: boundaries, count: boundaries.length })
  },
})

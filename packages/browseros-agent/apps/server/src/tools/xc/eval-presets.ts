/**
 * XC Phase 9 — Eval Presets: Pre-written Knowledge Extraction Scripts
 *
 * Tools exported:
 *   eval_preset             — dispatcher: run a named preset by key
 *   eval_extract_routes     — React Router / Next.js / Vue / TanStack / Remix / Angular / SvelteKit
 *   eval_extract_flags      — LaunchDarkly / Statsig / Unleash / GrowthBook / Split / Optimizely
 *   eval_extract_graphql    — Apollo Client v2/v3 schema extraction
 *   eval_extract_redux      — Redux / Zustand / Jotai / MobX store snapshot
 *   eval_extract_i18n       — react-i18next / vue-i18n / FormatJS / window.i18n
 *
 * Architecture
 * ────────────
 * Each preset is a self-contained IIFE string that probes well-known
 * global variables and returns a structured result object.
 * All presets are safe (read-only), return JSON-serializable data,
 * handle missing frameworks gracefully (return { found: false, framework: null }),
 * and cap array sizes to avoid massive payloads.
 *
 * Preset strings are plain JS (no TS) so they can be sent verbatim to
 * CDP Runtime.evaluate without compilation.
 *
 * Value to AI agent
 * ─────────────────
 * eval_preset('extract_routes')  → complete client-side route table including hidden routes
 * eval_preset('extract_flags')   → features built but not yet shown in the UI
 * eval_preset('extract_graphql') → full API shape the app uses
 * eval_preset('extract_redux')   → exact data model (field names, types, shape)
 * eval_preset('extract_i18n')    → every feature string in the app (acts as a feature catalog)
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('js-engine')

type CdpSession = {
  Runtime: {
    evaluate: (p: object) => Promise<{
      result: { type: string; value?: unknown; description?: string; objectId?: string }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>
  }
}

// ── Preset scripts ─────────────────────────────────────────────────────────────

const PRESET_ROUTES = /* js */ `
(function extractRoutes() {
  const result = { framework: null, routes: [], rawData: null };

  // ── Next.js ──────────────────────────────────────────────────────────────────
  // Next.js 13+ App Router
  if (window.__next_router_utils) {
    result.framework = 'nextjs-app-router';
    try { result.rawData = window.__next_router_utils; } catch(e) {}
  }
  // Next.js 12 Pages Router
  if (!result.framework && window.__NEXT_DATA__) {
    result.framework = 'nextjs-pages';
    const nd = window.__NEXT_DATA__;
    result.routes = [{ path: nd.page, props: Object.keys(nd.props || {}) }];
    // Try to get the router from __NEXT_DATA__ manifest
    try {
      if (window.next && window.next.router) {
        const router = window.next.router;
        result.rawData = {
          pathname: router.pathname,
          query: router.query,
          asPath: router.asPath,
        };
      }
    } catch(e) {}
    // Try __BUILD_MANIFEST for all page routes
    try {
      if (window.__BUILD_MANIFEST) {
        result.routes = Object.keys(window.__BUILD_MANIFEST.sortedPages || window.__BUILD_MANIFEST).slice(0, 500);
      }
    } catch(e) {}
  }

  // ── React Router v5 ──────────────────────────────────────────────────────────
  if (!result.framework) {
    try {
      const rr5 = window.__reactRouterContext || window.__routeContext;
      if (rr5) {
        result.framework = 'react-router-v5';
        result.routes = rr5;
      }
    } catch(e) {}
  }

  // ── React Router v6 / Remix ───────────────────────────────────────────────────
  if (!result.framework) {
    try {
      // Walk React fiber to find RouterProvider's value
      function getFiberRoutes(el) {
        if (!el) return null;
        let fiber = el._reactFiber || el[Object.keys(el).find(k => k.startsWith('__reactFiber')) || ''];
        if (!fiber) return null;
        let node = fiber;
        const visited = new Set();
        while (node) {
          if (visited.has(node)) break;
          visited.add(node);
          const pending = node.pendingProps || {};
          const memoized = node.memoizedProps || {};
          const value = (node.memoizedState && node.memoizedState.element) || pending.value || memoized.value;
          if (value && value.router && value.router.routes) {
            return value.router.routes;
          }
          if (pending.routes) return pending.routes;
          node = node.return;
        }
        return null;
      }
      const routes = getFiberRoutes(document.getElementById('root') || document.body);
      if (routes) {
        result.framework = 'react-router-v6';
        function flattenRoutes(routes, prefix) {
          const flat = [];
          for (const r of routes || []) {
            const path = (prefix + '/' + (r.path || '')).replace(/\/+/g, '/');
            flat.push({ path, id: r.id, index: r.index, hasLoader: !!r.loader, hasAction: !!r.action });
            flat.push(...flattenRoutes(r.children, path));
          }
          return flat;
        }
        result.routes = flattenRoutes(routes, '');
      }
    } catch(e) {}
  }

  // ── TanStack Router ───────────────────────────────────────────────────────────
  if (!result.framework) {
    try {
      const ts = window.__TSR_ROUTER__ || window.__tanstack_router__;
      if (ts) {
        result.framework = 'tanstack-router';
        result.routes = (ts.routeTree ? Object.keys(ts.routesByPath || {}) : []).slice(0, 500);
      }
    } catch(e) {}
  }

  // ── Vue Router ────────────────────────────────────────────────────────────────
  if (!result.framework) {
    try {
      // Vue 3: app.__vue_app__.config.globalProperties.$router
      const vueApps = document.querySelectorAll('[data-v-app]');
      for (const el of vueApps) {
        const app = el._vei || el.__vue_app__;
        const router = app && (app.$router || (app.config && app.config.globalProperties && app.config.globalProperties.$router));
        if (router && router.options && router.options.routes) {
          result.framework = 'vue-router';
          function flatVueRoutes(routes, prefix) {
            const flat = [];
            for (const r of routes || []) {
              const path = (prefix + '/' + (r.path || '')).replace(/\/+/g, '/');
              flat.push({ path, name: r.name, meta: r.meta });
              flat.push(...flatVueRoutes(r.children, path));
            }
            return flat;
          }
          result.routes = flatVueRoutes(router.options.routes, '');
          break;
        }
      }
    } catch(e) {}
  }

  // ── Angular ───────────────────────────────────────────────────────────────────
  if (!result.framework) {
    try {
      const ngEl = document.querySelector('[ng-version]') || document.querySelector('app-root');
      if (ngEl && window.getAllAngularRootElements) {
        const roots = window.getAllAngularRootElements();
        if (roots.length > 0) {
          result.framework = 'angular';
          // Angular stores router config in the injector
          try {
            const injector = window.ng.getInjector(roots[0]);
            const router = injector.get(window.ng.core && window.ng.core.Router);
            if (router && router.config) {
              function flatAngularRoutes(routes, prefix) {
                const flat = [];
                for (const r of routes || []) {
                  const path = (prefix + '/' + (r.path || '')).replace(/\/+/g, '/');
                  flat.push({ path, component: r.component && r.component.name, redirectTo: r.redirectTo });
                  flat.push(...flatAngularRoutes(r.children, path));
                }
                return flat;
              }
              result.routes = flatAngularRoutes(router.config, '');
            }
          } catch(e) {}
        }
      }
    } catch(e) {}
  }

  // ── SvelteKit ─────────────────────────────────────────────────────────────────
  if (!result.framework) {
    try {
      const sk = window.__sveltekit_data || window.sveltekit || window.__app;
      if (sk) {
        result.framework = 'sveltekit';
        result.rawData = typeof sk === 'object' ? JSON.stringify(sk).slice(0, 2000) : String(sk);
      }
    } catch(e) {}
  }

  // ── Generic window.__routes / window.routes ───────────────────────────────────
  if (!result.framework && (window.__routes || window.routes)) {
    result.framework = 'custom (window.__routes)';
    result.routes = window.__routes || window.routes;
  }

  result.found = result.framework !== null;
  result.routeCount = Array.isArray(result.routes) ? result.routes.length : 0;
  return result;
})()
`

const PRESET_FEATURE_FLAGS = /* js */ `
(function extractFeatureFlags() {
  const result = { providers: [], flags: {}, rawData: {} };

  // ── LaunchDarkly ──────────────────────────────────────────────────────────────
  try {
    // LDClient.allFlags() via global
    const ld = window.ldclient || window.LDClient || window.__ldclient__;
    if (ld && typeof ld.allFlags === 'function') {
      const flags = ld.allFlags();
      result.providers.push('LaunchDarkly');
      Object.assign(result.flags, flags);
      result.rawData.launchDarkly = flags;
    }
    // React SDK context
    if (window.__ld_context__ || window.__LD_CONTEXT__) {
      result.rawData.ldContext = window.__ld_context__ || window.__LD_CONTEXT__;
    }
  } catch(e) {}

  // ── Statsig ───────────────────────────────────────────────────────────────────
  try {
    const sg = window.statsig || window.Statsig || window.__STATSIG__;
    if (sg) {
      result.providers.push('Statsig');
      // statsig.getConfig / statsig.getFeatureGate
      const store = sg._store || sg.store || (sg._client && sg._client._store);
      if (store) {
        const gates = store.gates || store._gates || {};
        const configs = store.configs || store._configs || {};
        Object.assign(result.flags, Object.fromEntries(
          Object.entries(gates).map(([k, v]) => [k, typeof v === 'object' ? v.value : v])
        ));
        result.rawData.statsig = { gates, configs };
      }
    }
  } catch(e) {}

  // ── Unleash ───────────────────────────────────────────────────────────────────
  try {
    const ul = window.unleash || window.Unleash || window.__unleash__;
    if (ul) {
      result.providers.push('Unleash');
      const toggles = ul.toggles || ul._toggles || (ul.getVariant && ul.getAllToggles ? ul.getAllToggles() : null);
      if (toggles) {
        for (const [k, v] of Object.entries(toggles)) {
          result.flags[k] = typeof v === 'object' ? (v.enabled !== undefined ? v.enabled : v) : v;
        }
        result.rawData.unleash = toggles;
      }
    }
  } catch(e) {}

  // ── GrowthBook ────────────────────────────────────────────────────────────────
  try {
    const gb = window.growthbook || window.GrowthBook || window.__growthbook__;
    if (gb) {
      result.providers.push('GrowthBook');
      const features = gb._features || gb.features || (typeof gb.getFeatures === 'function' ? gb.getFeatures() : null);
      if (features) {
        Object.assign(result.flags, Object.fromEntries(
          Object.entries(features).map(([k, v]) => [k, typeof v === 'object' ? (v.defaultValue !== undefined ? v.defaultValue : v) : v])
        ));
        result.rawData.growthbook = features;
      }
    }
  } catch(e) {}

  // ── Split.io ──────────────────────────────────────────────────────────────────
  try {
    const sp = window.splitio || window.__splitio__ || window.SplitFactory;
    if (sp) {
      result.providers.push('Split.io');
      result.rawData.splitio = { detected: true, globalKey: Object.keys(window).filter(k => k.toLowerCase().includes('split')) };
    }
  } catch(e) {}

  // ── Optimizely ────────────────────────────────────────────────────────────────
  try {
    const op = window.optimizely || window.optlyX || window['optimizely-datafile'];
    if (op) {
      result.providers.push('Optimizely');
      const state = typeof op.get === 'function' ? op.get('state') : null;
      const experiments = state && state.getExperimentStates ? state.getExperimentStates() : null;
      result.rawData.optimizely = experiments || { detected: true };
      if (experiments) {
        for (const [k, v] of Object.entries(experiments)) {
          result.flags['exp_' + k] = v && (v.isActive !== undefined ? v.isActive : v);
        }
      }
    }
  } catch(e) {}

  // ── Custom: window.flags / window.featureFlags / window.FEATURE_FLAGS ─────────
  const customSources = [
    'flags', 'featureFlags', 'FEATURE_FLAGS', 'features', 'FEATURES',
    '__flags__', '__features__', 'appFlags', 'FF', 'feature_flags',
    '_flags', 'flagsmith',
  ];
  for (const key of customSources) {
    try {
      const val = window[key];
      if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length > 0) {
        const allBoolOrPrimitive = Object.values(val).every(v => typeof v !== 'function');
        if (allBoolOrPrimitive) {
          result.providers.push('custom:window.' + key);
          Object.assign(result.flags, val);
          result.rawData['custom_' + key] = val;
        }
      }
    } catch(e) {}
  }

  result.found = result.providers.length > 0;
  result.totalFlags = Object.keys(result.flags).length;
  return result;
})()
`

const PRESET_GRAPHQL = /* js */ `
(function extractGraphQL() {
  const result = { found: false, client: null, schema: null, queries: [], types: [] };

  // ── Apollo Client v3 ──────────────────────────────────────────────────────────
  try {
    // Apollo DevTools hook
    const hook = window.__APOLLO_CLIENT__ || window.apolloClient;
    if (hook) {
      result.found = true;
      result.client = 'apollo-v3';
      // Extract type policies / possible types
      const cache = hook.cache;
      if (cache) {
        const data = cache.extract ? cache.extract() : null;
        if (data) {
          const keys = Object.keys(data);
          result.types = [...new Set(keys.map(k => k.split(':')[0]).filter(t => t !== 'ROOT_QUERY' && t !== 'ROOT_MUTATION'))].slice(0, 100);
          // ROOT_QUERY keys = all queries the app has run
          const rootQuery = data['ROOT_QUERY'] || {};
          result.queries = Object.keys(rootQuery)
            .filter(k => k !== '__typename')
            .map(k => k.split('(')[0]) // strip args
            .slice(0, 200);
        }
        // Type policies
        const typePolicies = cache.policies && cache.policies.config && cache.policies.config.typePolicies;
        if (typePolicies) {
          result.typePolicies = Object.keys(typePolicies);
        }
      }
      // Extract schema if stored
      if (hook.schema) {
        result.schema = { detected: true, note: 'Schema object exists on client' };
      }
      // Possible types / fragment matcher
      const possibleTypes = hook.cache && hook.cache.config && hook.cache.config.possibleTypes;
      if (possibleTypes) {
        result.possibleTypes = possibleTypes;
      }
    }
  } catch(e) {}

  // ── Apollo Client v2 ──────────────────────────────────────────────────────────
  if (!result.found) {
    try {
      const hook2 = window.__APOLLO_STATE__ || (window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.apolloState);
      if (hook2) {
        result.found = true;
        result.client = 'apollo-v2-ssr-state';
        const keys = Object.keys(hook2);
        result.types = [...new Set(keys.map(k => k.split(':')[0]))].slice(0, 100);
        result.queries = keys.filter(k => k.startsWith('ROOT_QUERY')).length > 0
          ? Object.keys(hook2['ROOT_QUERY'] || {})
          : [];
      }
    } catch(e) {}
  }

  // ── Relay ─────────────────────────────────────────────────────────────────────
  if (!result.found) {
    try {
      const relay = window.__RELAY_STORE__ || window.__relaySSRData__;
      if (relay) {
        result.found = true;
        result.client = 'relay';
        result.rawData = typeof relay === 'object' ? Object.keys(relay).slice(0, 100) : String(relay);
      }
    } catch(e) {}
  }

  // ── URQL ──────────────────────────────────────────────────────────────────────
  if (!result.found) {
    try {
      const urql = window.__URQL_DATA__ || window.urqlClient;
      if (urql) {
        result.found = true;
        result.client = 'urql';
      }
    } catch(e) {}
  }

  // ── Generic: look for __schema in window ──────────────────────────────────────
  if (!result.schema) {
    const schemaKeys = Object.keys(window).filter(k =>
      k.includes('schema') || k.includes('Schema') || k.includes('SCHEMA')
    );
    for (const k of schemaKeys) {
      try {
        const v = window[k];
        if (v && v.__schema) {
          result.schema = {
            source: k,
            queryType: v.__schema.queryType,
            mutationType: v.__schema.mutationType,
            subscriptionType: v.__schema.subscriptionType,
            typeCount: v.__schema.types && v.__schema.types.length,
            typeNames: v.__schema.types && v.__schema.types.map(t => t.name).slice(0, 100),
          };
          result.found = true;
          break;
        }
      } catch(e) {}
    }
  }

  return result;
})()
`

const PRESET_REDUX = /* js */ `
(function extractState() {
  const result = { stores: [], found: false };

  // ── Redux DevTools Extension ──────────────────────────────────────────────────
  try {
    const devtools = window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__
      || (window.__REDUX_DEVTOOLS_EXTENSION__ && window.__REDUX_DEVTOOLS_EXTENSION__)
      || window.__redux_devtools_extension__;
    if (devtools) {
      result.found = true;
      result.devtoolsPresent = true;
    }
  } catch(e) {}

  // ── Redux store on window ─────────────────────────────────────────────────────
  const storeKeys = [
    'store', '__store__', 'reduxStore', '__REDUX_STORE__', 'appStore',
    '_store', 'globalStore', 'rootStore',
  ];
  for (const key of storeKeys) {
    try {
      const s = window[key];
      if (s && typeof s.getState === 'function' && typeof s.dispatch === 'function') {
        const state = s.getState();
        result.stores.push({
          source: 'window.' + key,
          type: 'redux',
          stateKeys: Object.keys(state || {}).slice(0, 100),
          state: JSON.parse(JSON.stringify(state, (k, v) => {
            if (typeof v === 'function') return '[Function]';
            if (typeof v === 'symbol') return v.toString();
            return v;
          })),
        });
        result.found = true;
      }
    } catch(e) {}
  }

  // ── Zustand ───────────────────────────────────────────────────────────────────
  try {
    // Zustand stores are closures; they can be found via __ZUSTAND__ or by
    // walking React fiber for zustand context providers
    const zKeys = Object.keys(window).filter(k =>
      k.includes('zustand') || k.includes('Zustand') || k.includes('ZUSTAND')
    );
    for (const k of zKeys) {
      try {
        const store = window[k];
        if (store && typeof store.getState === 'function') {
          const state = store.getState();
          result.stores.push({
            source: 'window.' + k,
            type: 'zustand',
            stateKeys: Object.keys(state || {}).slice(0, 100),
            state: JSON.parse(JSON.stringify(state, (k2, v) =>
              typeof v === 'function' ? '[Function]' : v
            )),
          });
          result.found = true;
        }
      } catch(e) {}
    }
  } catch(e) {}

  // ── Jotai ─────────────────────────────────────────────────────────────────────
  try {
    const jotai = window.jotaiStore || window.__jotai_store__ || window.__JOTAI_STORE__;
    if (jotai) {
      result.stores.push({ source: 'window.jotaiStore', type: 'jotai', detected: true });
      result.found = true;
    }
  } catch(e) {}

  // ── MobX ──────────────────────────────────────────────────────────────────────
  try {
    const mobxKeys = Object.keys(window).filter(k =>
      k.includes('mobx') || k.includes('MobX') || k.includes('MOBX') || k.includes('observable')
    );
    for (const k of mobxKeys) {
      try {
        const store = window[k];
        if (store && store.$mobx) {
          result.stores.push({
            source: 'window.' + k,
            type: 'mobx-observable',
            keys: Object.keys(store).slice(0, 100),
          });
          result.found = true;
        }
      } catch(e) {}
    }
  } catch(e) {}

  // ── Recoil ────────────────────────────────────────────────────────────────────
  try {
    const recoilStore = window.__recoilStore__ || window.__RECOIL_STORE__;
    if (recoilStore) {
      result.stores.push({ source: 'window.__recoilStore__', type: 'recoil', detected: true });
      result.found = true;
    }
  } catch(e) {}

  result.storeCount = result.stores.length;
  return result;
})()
`

const PRESET_I18N = /* js */ `
(function extractI18n() {
  const result = { found: false, provider: null, locales: [], currentLocale: null, keys: {}, namespaces: [] };

  // ── react-i18next / i18next ───────────────────────────────────────────────────
  try {
    const i18n = window.i18next || window.i18n || window.__i18next__;
    if (i18n && i18n.store) {
      result.found = true;
      result.provider = 'i18next';
      result.currentLocale = i18n.language;
      result.locales = i18n.languages || [i18n.language];
      const data = i18n.store.data || i18n.store;
      result.namespaces = [];
      for (const [lang, namespaces] of Object.entries(data || {})) {
        for (const [ns, translations] of Object.entries(namespaces || {})) {
          if (!result.namespaces.includes(ns)) result.namespaces.push(ns);
          if (!result.keys[ns]) result.keys[ns] = [];
          function flattenKeys(obj, prefix) {
            for (const [k, v] of Object.entries(obj || {})) {
              const fullKey = prefix ? prefix + '.' + k : k;
              if (typeof v === 'object' && !Array.isArray(v)) {
                flattenKeys(v, fullKey);
              } else {
                result.keys[ns].push(fullKey);
              }
            }
          }
          flattenKeys(translations, '');
          result.keys[ns] = [...new Set(result.keys[ns])].slice(0, 2000);
          break; // Only first language to avoid duplication
        }
      }
    }
  } catch(e) {}

  // ── vue-i18n ──────────────────────────────────────────────────────────────────
  if (!result.found) {
    try {
      const vi18n = window.__VUE_I18N__ || window.vueI18n;
      if (vi18n) {
        result.found = true;
        result.provider = 'vue-i18n';
        const locale = vi18n.locale && (typeof vi18n.locale === 'object' ? vi18n.locale.value : vi18n.locale);
        result.currentLocale = locale;
        const messages = vi18n.messages && (typeof vi18n.messages.value === 'object' ? vi18n.messages.value : vi18n.messages);
        const lang = messages && messages[locale];
        if (lang) {
          result.keys['default'] = [];
          function flatVueKeys(obj, prefix) {
            for (const [k, v] of Object.entries(obj || {})) {
              const full = prefix ? prefix + '.' + k : k;
              if (typeof v === 'object') flatVueKeys(v, full);
              else result.keys['default'].push(full);
            }
          }
          flatVueKeys(lang, '');
          result.keys['default'] = result.keys['default'].slice(0, 2000);
        }
      }
    } catch(e) {}
  }

  // ── FormatJS / react-intl ─────────────────────────────────────────────────────
  if (!result.found) {
    try {
      const intl = window.__REACT_INTL_CONTEXT__ || window.ReactIntl;
      if (intl) {
        result.found = true;
        result.provider = 'react-intl';
        result.detected = true;
      }
    } catch(e) {}
  }

  // ── Generic: window.translations / window.i18n (plain object) ─────────────────
  if (!result.found) {
    const candidates = ['translations', '__translations__', 'TRANSLATIONS', 'i18n', 'locale', 'messages', 'localeData'];
    for (const key of candidates) {
      try {
        const val = window[key];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const keys = Object.keys(val);
          if (keys.length > 2) {
            result.found = true;
            result.provider = 'custom:window.' + key;
            result.keys['default'] = keys.slice(0, 2000);
            result.totalKeys = keys.length;
            break;
          }
        }
      } catch(e) {}
    }
  }

  result.totalKeys = Object.values(result.keys).reduce((s, a) => s + a.length, 0);
  return result;
})()
`

// ── Preset map ─────────────────────────────────────────────────────────────────

export const PRESETS = {
  extract_routes: PRESET_ROUTES,
  extract_feature_flags: PRESET_FEATURE_FLAGS,
  extract_graphql: PRESET_GRAPHQL,
  extract_redux: PRESET_REDUX,
  extract_i18n: PRESET_I18N,
} as const

export type PresetKey = keyof typeof PRESETS

const PRESET_DESCRIPTIONS: Record<PresetKey, string> = {
  extract_routes:
    'Scan for React Router v5/v6, Next.js Pages/App Router, Vue Router, TanStack Router, ' +
    'Angular Router, Remix, SvelteKit route tables. Returns all known client-side routes ' +
    'including hidden ones not linked from the UI.',
  extract_feature_flags:
    'Detect LaunchDarkly, Statsig, Unleash, GrowthBook, Split.io, Optimizely, and custom ' +
    'window.flags objects. Returns all feature flag keys and their current values. ' +
    'Reveals features built but not yet exposed in the UI.',
  extract_graphql:
    'If Apollo Client, Relay, or URQL is loaded, extract the cache state, all executed ' +
    'query names, entity types, type policies, and possible types. ' +
    'Also scans for __schema on window. Returns the full API shape the app uses.',
  extract_redux:
    'Dump the complete state tree from Redux, Zustand, Jotai, MobX, or Recoil stores. ' +
    'Returns the exact data model the app uses, including all keys and current values. ' +
    'Functions are represented as [Function] strings.',
  extract_i18n:
    'Dump i18n translation keys from i18next, vue-i18n, react-intl, or custom window.translations. ' +
    'Returns all translation key names (not values) per namespace. ' +
    'Key names act as a complete feature catalog — every feature the app has text for.',
}

// ── Helper: run a preset script ───────────────────────────────────────────────

async function runPreset(
  presetKey: PresetKey,
  args: { page: number; timeoutMs?: number },
  ctx: { browser: { getSession: (pageId: number) => Promise<unknown> } },
  response: {
    text: (s: string) => void
    data: (d: Record<string, unknown>) => void
    error: (s: string) => void
  },
): Promise<void> {
  const session = await ctx.browser.getSession(args.page)
  if (!session) {
    response.error(`No active session for page ${args.page}.`)
    return
  }

  const cdp = session as unknown as CdpSession
  const code = PRESETS[presetKey]
  const timeoutMs = args.timeoutMs ?? 15000

  let evalResult: Awaited<ReturnType<CdpSession['Runtime']['evaluate']>>
  try {
    evalResult = await Promise.race([
      cdp.Runtime.evaluate({
        expression: code,
        returnByValue: true,
        awaitPromise: false,
        userGesture: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Preset ${presetKey} timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ])
  } catch (e) {
    response.error((e as Error).message)
    return
  }

  if (evalResult.exceptionDetails) {
    const ex = evalResult.exceptionDetails
    response.error(`Preset ${presetKey} threw: ${ex.exception?.description ?? ex.text}`)
    return
  }

  const data = evalResult.result?.value as Record<string, unknown>
  const display = JSON.stringify(data, null, 2).slice(0, 10000)
  const truncated = JSON.stringify(data).length > 10000

  response.text(
    `[${presetKey}] ${PRESET_DESCRIPTIONS[presetKey]}\n\n` +
    display +
    (truncated ? '\n... [truncated at 10000 chars]' : ''),
  )
  response.data({ preset: presetKey, result: data })
}

// ── Tools ──────────────────────────────────────────────────────────────────────

export const eval_preset = defineXcTool({
  name: 'eval_preset',
  description:
    'Run a named knowledge-extraction preset against the page. ' +
    'Available presets:\n' +
    Object.entries(PRESET_DESCRIPTIONS)
      .map(([k, v]) => `  • ${k}: ${v}`)
      .join('\n'),
  input: z.object({
    page: pageParam,
    preset: z
      .enum(['extract_routes', 'extract_feature_flags', 'extract_graphql', 'extract_redux', 'extract_i18n'])
      .describe('Preset name to run'),
    timeoutMs: z.number().default(15000).describe('Timeout in ms (default 15000)'),
  }),
  output: z.object({ preset: z.string(), result: z.unknown() }),
  handler: async (args, ctx, response) => {
    await runPreset(args.preset, args, ctx, response)
  },
})

export const eval_extract_routes = defineXcTool({
  name: 'eval_extract_routes',
  description: PRESET_DESCRIPTIONS.extract_routes,
  input: z.object({ page: pageParam, timeoutMs: z.number().default(15000) }),
  output: z.object({ preset: z.string(), result: z.unknown() }),
  handler: async (args, ctx, response) => {
    await runPreset('extract_routes', args, ctx, response)
  },
})

export const eval_extract_flags = defineXcTool({
  name: 'eval_extract_flags',
  description: PRESET_DESCRIPTIONS.extract_feature_flags,
  input: z.object({ page: pageParam, timeoutMs: z.number().default(15000) }),
  output: z.object({ preset: z.string(), result: z.unknown() }),
  handler: async (args, ctx, response) => {
    await runPreset('extract_feature_flags', args, ctx, response)
  },
})

export const eval_extract_graphql = defineXcTool({
  name: 'eval_extract_graphql',
  description: PRESET_DESCRIPTIONS.extract_graphql,
  input: z.object({ page: pageParam, timeoutMs: z.number().default(15000) }),
  output: z.object({ preset: z.string(), result: z.unknown() }),
  handler: async (args, ctx, response) => {
    await runPreset('extract_graphql', args, ctx, response)
  },
})

export const eval_extract_redux = defineXcTool({
  name: 'eval_extract_redux',
  description: PRESET_DESCRIPTIONS.extract_redux,
  input: z.object({ page: pageParam, timeoutMs: z.number().default(15000) }),
  output: z.object({ preset: z.string(), result: z.unknown() }),
  handler: async (args, ctx, response) => {
    await runPreset('extract_redux', args, ctx, response)
  },
})

export const eval_extract_i18n = defineXcTool({
  name: 'eval_extract_i18n',
  description: PRESET_DESCRIPTIONS.extract_i18n,
  input: z.object({ page: pageParam, timeoutMs: z.number().default(15000) }),
  output: z.object({ preset: z.string(), result: z.unknown() }),
  handler: async (args, ctx, response) => {
    await runPreset('extract_i18n', args, ctx, response)
  },
})

/**
 * XC Phase 6 — Framework Detection
 *
 * detect_framework() probes the page's JS globals, DOM attributes, meta tags,
 * and window properties to identify the frontend framework and return structured
 * metadata the agent can use to tailor its exploration strategy.
 *
 * Detected frameworks:
 *   React, Vue 2/3, Angular, Svelte, Next.js, Nuxt 2/3,
 *   Remix, SvelteKit, Astro, Qwik, Solid
 *
 * Returns:
 *   { framework, version, ssr, router, renderMode, meta }
 *
 * Tools exported:
 *   detect_framework
 */

import { z } from 'zod'
import { defineToolWithCategory } from '../framework'

const pageParam = z.number().describe('Page ID (from list_pages)')
const defineXcTool = defineToolWithCategory('observation')

const DETECT_JS = `
(function detectFramework() {
  var results = [];

  function probe(name, test) {
    try { var r = test(); if (r) results.push(r); } catch(e) {}
  }

  // ─── Next.js ────────────────────────────────────────────────────────────────
  probe('Next.js', function() {
    var data = window.__NEXT_DATA__;
    if (!data && !document.getElementById('__NEXT_DATA__')) return null;
    var version = null;
    try {
      // Next 13+ App Router: window.next.version
      if (window.next && window.next.version) version = window.next.version;
    } catch(e) {}
    var router = 'unknown';
    try {
      if (data && data.page) router = data.page.includes('/_app') ? 'pages' : 'pages';
      if (window.next && window.next.router) router = window.next.router.pathname ? 'pages' : 'app';
    } catch(e) {}
    // Check for App Router indicators
    var isAppRouter = !!document.querySelector('[data-nextjs-router="app"]') ||
      !!(data && data.appRouter) ||
      !!(window.__next_router_basepath !== undefined);
    return {
      framework: 'Next.js',
      version: version,
      ssr: true,
      router: isAppRouter ? 'App Router' : 'Pages Router',
      renderMode: 'SSR/SSG/ISR',
      meta: {
        buildId: data && data.buildId || null,
        page: data && data.page || null,
        query: data && data.query || null,
        runtimeConfig: !!(data && data.runtimeConfig),
      },
    };
  });

  // ─── Nuxt ──────────────────────────────────────────────────────────────────
  probe('Nuxt', function() {
    var nuxt = window.__NUXT__ || window.$nuxt;
    if (!nuxt) return null;
    var version = null;
    try { if (window.$nuxt && window.$nuxt.$root && window.$nuxt.$root.$options._base) version = '2.x'; } catch(e) {}
    try { if (window.__NUXT__ && window.__NUXT__.config && window.__NUXT__.config.app) version = '3.x'; } catch(e) {}
    return {
      framework: 'Nuxt',
      version: version,
      ssr: true,
      router: version === '3.x' ? 'vue-router 4' : 'vue-router 3',
      renderMode: 'SSR/SSG',
      meta: {
        state: !!(window.__NUXT__ && window.__NUXT__.state),
      },
    };
  });

  // ─── Remix ─────────────────────────────────────────────────────────────────
  probe('Remix', function() {
    if (!window.__remixContext && !window.__remixRouteModules && !window.__remixManifest) return null;
    return {
      framework: 'Remix',
      version: null,
      ssr: true,
      router: 'React Router 6',
      renderMode: 'SSR',
      meta: {
        routes: window.__remixManifest ? Object.keys(window.__remixManifest.routes || {}).length : null,
      },
    };
  });

  // ─── Astro ────────────────────────────────────────────────────────────────
  probe('Astro', function() {
    if (!document.querySelector('[data-astro-cid],[data-astro-source-file]') &&
        !document.querySelector('astro-island') && !window.__astro_component_registry) return null;
    return {
      framework: 'Astro',
      version: null,
      ssr: true,
      router: 'file-based',
      renderMode: 'MPA/Islands',
      meta: {
        islandCount: document.querySelectorAll('astro-island').length,
      },
    };
  });

  // ─── SvelteKit ────────────────────────────────────────────────────────────
  probe('SvelteKit', function() {
    if (!window.__sveltekit_dev && !window.__sveltekit_chunks &&
        !document.querySelector('[data-sveltekit-preload-data]') &&
        !document.getElementById('svelte') &&
        !document.querySelector('[data-sk-routeid]')) return null;
    return {
      framework: 'SvelteKit',
      version: null,
      ssr: true,
      router: 'SvelteKit router',
      renderMode: 'SSR/SSG',
      meta: {},
    };
  });

  // ─── Qwik ────────────────────────────────────────────────────────────────
  probe('Qwik', function() {
    if (!window.qwikJson && !document.querySelector('[q\\:container]')) return null;
    return {
      framework: 'Qwik',
      version: null,
      ssr: true,
      router: 'Qwik City',
      renderMode: 'Resumable',
      meta: {
        containerCount: document.querySelectorAll('[q\\:container]').length,
      },
    };
  });

  // ─── React (standalone) ──────────────────────────────────────────────────
  probe('React', function() {
    // Skip if already detected as Next/Remix (they also have React)
    if (results.length > 0) return null;
    var hasReact = !!(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__);
    if (!hasReact) {
      // Try fiber scan
      function hasFiber(el) {
        if (!el) return false;
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].startsWith('__reactFiber') || keys[i].startsWith('_reactFiber') ||
              keys[i].startsWith('__reactInternalInstance')) return true;
        }
        return false;
      }
      var root = document.getElementById('root') || document.getElementById('app') ||
                 document.querySelector('[data-reactroot]') || document.body;
      if (root && !hasFiber(root)) {
        var children = root.children;
        var found = false;
        for (var i = 0; i < Math.min(children.length, 5); i++) {
          if (hasFiber(children[i])) { found = true; break; }
        }
        if (!found) return null;
      }
    }
    var version = null;
    try { version = window.React && window.React.version || null; } catch(e) {}
    if (!version) {
      try {
        var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (hook && hook.renderers && hook.renderers.size > 0) {
          var r = hook.renderers.values().next().value;
          version = r && r.version || null;
        }
      } catch(e) {}
    }
    return {
      framework: 'React',
      version: version,
      ssr: !!(window.__REACT_SERVER_COMPONENT__),
      router: 'unknown',
      renderMode: 'CSR',
      meta: {},
    };
  });

  // ─── Vue ──────────────────────────────────────────────────────────────────
  probe('Vue', function() {
    if (results.length > 0) return null; // Skip if Nuxt already detected
    var hasVue = !!(window.Vue || window.__VUE__ || window.__VUE_HMR_RUNTIME__);
    if (!hasVue) {
      // Vue 3: check for __vueParentComponent on DOM
      var root = document.getElementById('app') || document.getElementById('root') || document.body;
      if (!root) return null;
      var keys = Object.keys(root);
      var found = keys.some(function(k){ return k.startsWith('__vue') || k.startsWith('_vei'); });
      if (!found) return null;
    }
    var version = null;
    try { version = window.Vue && window.Vue.version || null; } catch(e) {}
    if (!version && window.__VUE__) version = '3.x';
    return {
      framework: 'Vue',
      version: version,
      ssr: false,
      router: window.vueRouter ? 'Vue Router' : 'unknown',
      renderMode: 'CSR',
      meta: {},
    };
  });

  // ─── Angular ─────────────────────────────────────────────────────────────
  probe('Angular', function() {
    if (!window.ng && !window.getAllAngularRootElements && !document.querySelector('[ng-version]')) return null;
    var version = null;
    try {
      var vEl = document.querySelector('[ng-version]');
      if (vEl) version = vEl.getAttribute('ng-version');
    } catch(e) {}
    try {
      if (!version && window.ng && window.ng.probe) version = '2-8.x';
    } catch(e) {}
    return {
      framework: 'Angular',
      version: version,
      ssr: !!(window.platformServer),
      router: '@angular/router',
      renderMode: 'CSR',
      meta: {},
    };
  });

  // ─── Svelte (standalone) ──────────────────────────────────────────────────
  probe('Svelte', function() {
    if (results.length > 0) return null; // SvelteKit already found
    var hasSvelte = document.getElementById('svelte') ||
      document.querySelector('[class^="svelte-"]') ||
      document.querySelector('[class*=" svelte-"]') ||
      !!window.__svelte;
    if (!hasSvelte) return null;
    return {
      framework: 'Svelte',
      version: null,
      ssr: false,
      router: 'unknown',
      renderMode: 'CSR',
      meta: {},
    };
  });

  // ─── Solid.js ─────────────────────────────────────────────────────────────
  probe('Solid', function() {
    if (results.length > 0) return null;
    if (!window._$HY && !document.querySelector('script[data-solid-router]')) return null;
    return {
      framework: 'Solid',
      version: null,
      ssr: !!(window._$HY && window._$HY.r),
      router: 'Solid Router',
      renderMode: window._$HY ? 'SSR/Hydration' : 'CSR',
      meta: {},
    };
  });

  // If nothing found, try generic meta tags
  if (results.length === 0) {
    var generator = document.querySelector('meta[name="generator"]');
    if (generator) {
      var content = generator.getAttribute('content') || '';
      results.push({
        framework: content || 'Unknown',
        version: null, ssr: false, router: 'unknown', renderMode: 'unknown',
        meta: { generatorTag: content },
      });
    }
  }

  return results.length > 0 ? results : [{ framework: 'Unknown', version: null, ssr: false, router: 'unknown', renderMode: 'unknown', meta: {} }];
})()
`

export const detect_framework = defineXcTool({
  name: 'detect_framework',
  description:
    'Detect the frontend framework(s) used by the current page. ' +
    'Identifies React, Vue 2/3, Angular, Svelte, Next.js, Nuxt 2/3, Remix, SvelteKit, Astro, Qwik, Solid. ' +
    'Returns { framework, version, ssr, router, renderMode, meta } for each detected framework. ' +
    'Use this first when mapping an unknown site — knowing the framework lets the agent ' +
    'choose the right introspection strategy (react_get_tree for React, DOM inspection for others).',
  input: z.object({ page: pageParam }),
  output: z.object({
    primary: z.object({
      framework: z.string(),
      version: z.string().nullable(),
      ssr: z.boolean(),
      router: z.string(),
      renderMode: z.string(),
      meta: z.record(z.any()),
    }),
    all: z.array(z.any()),
  }),
  handler: async (args, ctx, response) => {
    const session = await ctx.browser.getSession(args.page)
    if (!session) { response.error(`No active session for page ${args.page}.`); return }

    const result = await session.Runtime.evaluate({
      expression: DETECT_JS,
      returnByValue: true,
      awaitPromise: false,
    })

    const all = (result.result?.value ?? []) as Array<{
      framework: string
      version: string | null
      ssr: boolean
      router: string
      renderMode: string
      meta: Record<string, unknown>
    }>

    const primary = all[0] ?? { framework: 'Unknown', version: null, ssr: false, router: 'unknown', renderMode: 'unknown', meta: {} }

    const lines = all.map((f) => {
      const ver = f.version ? ` v${f.version}` : ''
      const ssr = f.ssr ? ' [SSR]' : ' [CSR]'
      return `  • ${f.framework}${ver}${ssr} — router: ${f.router}, renderMode: ${f.renderMode}`
    })

    const strategy: string[] = []
    if (primary.framework === 'Next.js' || primary.framework === 'React' || primary.framework === 'Remix') {
      strategy.push('→ Use react_get_tree, react_inspect_component, react_get_suspense_boundaries')
    } else if (primary.framework === 'Vue' || primary.framework === 'Nuxt') {
      strategy.push('→ Use evaluate_script to inspect Vue component tree via $root.__vue_app__')
    } else if (primary.framework === 'Angular') {
      strategy.push('→ Use evaluate_script with window.getAllAngularRootElements() and ng.probe()')
    } else {
      strategy.push('→ Use take_snapshot + get_web_vitals for structural analysis')
    }

    response.text(
      `Framework detection result:\n${lines.join('\n')}\n\n${strategy.join('\n')}`,
    )
    response.data({ primary, all })
  },
})

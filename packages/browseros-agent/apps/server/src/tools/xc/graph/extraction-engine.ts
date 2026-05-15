/**
 * extraction-engine.ts — Shared extraction logic for the XC Intelligence Mapper.
 *
 * Pure function: takes a browser page ID + browser interface, runs 9 extraction
 * phases, returns PageSignals (raw facts, never interpretations).
 *
 * Refactored from processBfsPage in map-site-skill.ts. All hardcoded
 * interpretation functions (inferPageRole, isAuthWall, inferFormPurpose) removed.
 */

import type {
  EvaluateResult,
  FormResult,
  GetDomOptions,
  NewPageOptions,
  OverlayResult,
  PageLink,
  Phase1Result,
  RouteResult,
  SearchDomOptions,
  SearchDomResult,
  ServiceWorkerResult,
  WaitForNavigationOptions,
  WebWorkerResult,
} from './browser-context'
import {
  EXTRACT_API_SURFACE,
  EXTRACT_OVERLAY_TRIGGERS,
  EXTRACT_SERVICE_WORKER_SYNC,
  EXTRACT_WEB_WORKERS,
} from './eval-presets-extra'
import type {
  FieldSignals,
  FormSignals,
  LinkWithContext,
  OverlayTriggerSignals,
  PageSignals,
} from './page-signals'

export interface BrowserInterface {
  newPage: (url: string, opts?: NewPageOptions) => Promise<number>
  goto: (id: number, url: string) => Promise<void>
  evaluate: (id: number, script: string) => Promise<EvaluateResult>
  snapshot: (id: number) => Promise<string | undefined>
  enhancedSnapshot: (id: number) => Promise<string | undefined>
  getDom: (id: number, opts: GetDomOptions) => Promise<string | null>
  searchDom: (
    id: number,
    selector: string,
    opts?: SearchDomOptions,
  ) => Promise<SearchDomResult>
  getPageLinks: (id: number) => Promise<PageLink[]>
  fill?: (id: number, selector: string, value: string) => Promise<void>
  click?: (id: number, selector: string) => Promise<void>
  waitForNavigation?: (
    id: number,
    opts?: WaitForNavigationOptions,
  ) => Promise<void>
  closePage: (id: number) => Promise<void>
}

const TWO_PART_TLDS = new Set([
  'co.uk',
  'co.in',
  'co.jp',
  'co.nz',
  'co.za',
  'co.kr',
  'co.id',
  'com.au',
  'com.br',
  'com.mx',
  'com.ar',
  'com.sg',
  'com.hk',
  'org.uk',
  'net.au',
  'gov.uk',
  'ac.uk',
  'me.uk',
])

function getRootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.')
  if (parts.length <= 2) return hostname.toLowerCase()
  const lastTwo = parts.slice(-2).join('.')
  if (TWO_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

function isSameSite(href: string, rootDomain: string): boolean {
  try {
    const hostname = new URL(href).hostname.toLowerCase()
    return hostname === rootDomain || hostname.endsWith(`.${rootDomain}`)
  } catch {
    return false
  }
}

const PHASE1_EVAL = `(() => {
  const title = document.title || document.location.pathname
  const h1 = document.querySelector('h1')?.textContent?.trim() ?? ''
  const desc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? ''
  const hasPassword = !!document.querySelector('input[type="password"]')
  const passwordFieldCount = document.querySelectorAll('input[type="password"]').length
  const interactiveCount = document.querySelectorAll('input,button,select,textarea,a[href]').length
  const cookieCount = document.cookie ? document.cookie.split(';').length : 0

  const lsKeys = Object.keys(localStorage).slice(0, 30)
  const ssKeys = Object.keys(sessionStorage).slice(0, 30)

  const hasNextData = !!window.__NEXT_DATA__
  const hasReact = !!(window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__)
  const hasVue = !!(window.__VUE__ || window.Vue)
  const hasAngular = !!(window.ng || window.getAllAngularRootElements)
  let framework = ''
  if (hasNextData) framework = 'Next.js'
  else if (hasReact) framework = 'React'
  else if (hasVue) framework = 'Vue'
  else if (hasAngular) framework = 'Angular'

  let flags = {}
  let flagProviders = []
  try {
    if (window.__FEATURE_FLAGS__) { flags = { ...window.__FEATURE_FLAGS__ }; flagProviders.push('__FEATURE_FLAGS__') }
    else if (window.featureFlags) { flags = { ...window.featureFlags }; flagProviders.push('featureFlags') }
    else if (window.__FLAGS__) { flags = { ...window.__FLAGS__ }; flagProviders.push('__FLAGS__') }
  } catch {}

  const schemaBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map(el => { try { return JSON.parse(el.textContent ?? '{}') } catch { return null } })
    .filter(Boolean)
    .map(b => ({ type: b['@type'] ?? 'Unknown', summary: JSON.stringify(b).slice(0, 200) }))

  return { title, h1, desc, hasPassword, passwordFieldCount, interactiveCount, cookieCount,
           lsKeys, ssKeys, hasNextData, hasReact, hasVue, hasAngular, framework, flags, flagProviders, schemaBlocks }
})()`

const PHASE1B_ROUTE_EVAL = `(() => {
  const result = { framework: null, routes: [] };

  if (window.__NEXT_DATA__) {
    result.framework = 'Next.js';
    try {
      if (window.__BUILD_MANIFEST) {
        result.routes = Object.keys(window.__BUILD_MANIFEST.sortedPages || window.__BUILD_MANIFEST).slice(0, 500);
      }
    } catch(e) {}
    try {
      if (window.next && window.next.router) {
        result.routes.push(window.next.router.pathname);
      }
    } catch(e) {}
  }

  if (!result.framework) {
    try {
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
          const value = (node.memoizedState && node.memoizedState.element) || pending.value;
          if (value && value.router && value.router.routes) return value.router.routes;
          if (pending.routes) return pending.routes;
          node = node.return;
        }
        return null;
      }
      const routes = getFiberRoutes(document.getElementById('root') || document.body);
      if (routes) {
        result.framework = 'React Router';
        function flattenRoutes(routes, prefix) {
          const flat = [];
          for (const r of routes || []) {
            const path = (prefix + '/' + (r.path || '')).replace(/\\/+/g, '/');
            flat.push(path);
            flat.push(...flattenRoutes(r.children, path));
          }
          return flat;
        }
        result.routes = flattenRoutes(routes, '');
      }
    } catch(e) {}
  }

  if (!result.framework) {
    try {
      const vueApps = document.querySelectorAll('[data-v-app]');
      for (const el of vueApps) {
        const app = el._vei || el.__vue_app__;
        const router = app && (app.$router || (app.config && app.config.globalProperties && app.config.globalProperties.$router));
        if (router && router.options && router.options.routes) {
          result.framework = 'Vue Router';
          function flatVueRoutes(routes, prefix) {
            const flat = [];
            for (const r of routes || []) {
              const path = (prefix + '/' + (r.path || '')).replace(/\\/+/g, '/');
              flat.push(path);
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

  if (!result.framework && window.__sveltekit_data) {
    result.framework = 'SvelteKit';
  }

  if (!result.framework && (window.__routes || window.routes)) {
    result.framework = 'custom';
    result.routes = window.__routes || window.routes;
  }

  return result;
})()`

const PHASE4_FORM_EVAL = `(() => {
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
          ? Array.from(el.options).map(o => o.text).slice(0, 20)
          : [],
      }))
    const submitBtn = f.querySelector('[type="submit"],button[type="submit"],button:not([type])')
    const visibleFields = fields.filter(f => f.inputType !== 'hidden' && f.inputType !== 'submit')
    return {
      index: i,
      action: f.action || '',
      method: f.method || 'get',
      fieldCount: fields.length,
      submitLabel: submitBtn?.textContent?.trim() ?? '',
      fields,
      hasEmailField: fields.some(f => f.inputType === 'email' || /email/i.test(f.name + f.label)),
      hasPasswordField: fields.some(f => f.inputType === 'password'),
      hasPhoneField: fields.some(f => f.inputType === 'tel' || /phone|tel|mobile/i.test(f.name + f.label)),
      hasFileUpload: fields.some(f => f.inputType === 'file'),
      hasCreditCardField: fields.some(f => /card|credit|cc_num|card_number|ccv|cvv|cvc|expir/i.test(f.name + f.label + f.autocomplete)),
      hasSearchField: fields.some(f => f.inputType === 'search' || /search|query|q\b/i.test(f.name)),
      requiredFieldCount: visibleFields.filter(f => f.required).length,
      hiddenFieldCount: fields.filter(f => f.inputType === 'hidden').length,
    }
  })
})()`

const PHASE6_PERF_EVAL = `(() => {
  return performance.getEntriesByType('resource')
    .filter(e => {
      const url = e.name
      return (url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/')
        || url.includes('/graphql') || url.includes('/rest/')
        || e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')
    })
    .map(e => e.name)
    .slice(0, 30)
})()`

const PHASE6_FETCH_EVAL = `(() => {
  return (window.__xcFetchLog || []).slice(0, 30).map(e => e.url || e)
})()`

const PHASE7_LINK_CONTEXT_EVAL = `(() => {
  const links = Array.from(document.querySelectorAll('a[href]'));
  
  function getDomPosition(link) {
    let el = link;
    while (el && el !== document.body) {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role');
      const id = (el.id || '').toLowerCase();
      const classes = (el.className || '').toLowerCase();
      
      if (tag === 'nav' || role === 'navigation') return 'nav';
      if (id.includes('nav') || classes.includes('nav') || classes.includes('navbar')) return 'nav';
      
      if (tag === 'header' || role === 'banner') return 'header';
      
      if (tag === 'footer' || role === 'contentinfo') return 'footer';
      if (id.includes('footer') || classes.includes('footer')) return 'footer';
      
      if (tag === 'aside' || role === 'complementary') return 'aside';
      
      el = el.parentElement;
    }
    
    const href = link.href.toLowerCase();
    const text = (link.textContent || '').toLowerCase();
    if (href.includes('/api/') || href.includes('/graphql') || 
        text.includes('api') || text.includes('developers') ||
        text.includes('documentation') || link.closest('[class*="api"]')) {
      return 'api_related';
    }
    
    return 'unknown';
  }
  
  function getNearestLandmark(link) {
    for (const role of ['navigation', 'banner', 'main', 'contentinfo', 'complementary', 'search']) {
      const landmark = link.closest('[role="' + role + '"]');
      if (landmark) return role;
      const tagMap = { navigation: 'nav', banner: 'header', main: 'main', contentinfo: 'footer', complementary: 'aside' };
      if (tagMap[role] && link.closest(tagMap[role])) return role;
    }
    return null;
  }
  
  return links.map(link => ({
    href: link.href,
    domPosition: getDomPosition(link),
    nearestLandmark: getNearestLandmark(link),
    parentContext: (link.closest('[id]')?.id || link.closest('[class]')?.className?.split(' ')[0] || null)
  }));
})()`

const LANDMARK_ROLES = [
  'navigation',
  'banner',
  'main',
  'contentinfo',
  'complementary',
  'search',
]

export async function extractPageSignals(
  pageId: number,
  browser: BrowserInterface,
  rootDomain: string,
): Promise<PageSignals> {
  const emptySignals: PageSignals = {
    url: '',
    title: '',
    h1: '',
    metaDescription: '',
    urlPath: '',
    urlHostname: '',
    hasPasswordField: false,
    passwordFieldCount: 0,
    interactiveElementCount: 0,
    formCount: 0,
    forms: [],
    dialogCount: 0,
    overlayTriggers: [],
    frameworkDetected: null,
    hasNextData: false,
    hasReactDevtools: false,
    hasVueInstance: false,
    hasAngularElements: false,
    apiCallsObserved: [],
    fetchInitiatedCalls: [],
    localStorageKeys: [],
    sessionStorageKeys: [],
    cookieCount: 0,
    hasServiceWorker: false,
    serviceWorkerScope: null,
    serviceWorkerScriptUrl: null,
    serviceWorkerCacheNames: [],
    serviceWorkerCacheUrls: [],
    webWorkerScriptUrls: [],
    webWorkerCount: 0,
    schemaOrgBlocks: [],
    featureFlagKeys: [],
    featureFlagProviders: [],
    clientRoutesDiscovered: [],
    clientRouteFramework: null,
    sameDomainLinks: [],
    sameDomainLinksWithContext: [],
    crossDomainLinks: [],
    linkCount: 0,
    landmarkRoles: [],
    enhancedSnapshotAvailable: false,
  }

  let url = ''
  let urlPath = ''
  let urlHostname = ''
  try {
    const urlRes = await browser.evaluate(pageId, 'window.location.href')
    url = typeof urlRes.value === 'string' ? urlRes.value : ''
    try {
      const parsed = new URL(url)
      urlPath = parsed.pathname.toLowerCase()
      urlHostname = parsed.hostname.toLowerCase()
    } catch {}
  } catch {}

  // Phase 1
  let phase1: Phase1Result = {}
  try {
    const res = await browser.evaluate(pageId, PHASE1_EVAL)
    if (res.value && typeof res.value === 'object') {
      phase1 = res.value as Phase1Result
    }
  } catch {}

  const title = typeof phase1.title === 'string' ? phase1.title : url
  const h1 = typeof phase1.h1 === 'string' ? phase1.h1 : ''
  const metaDescription = typeof phase1.desc === 'string' ? phase1.desc : ''
  const hasPasswordField = phase1.hasPassword === true
  const passwordFieldCount =
    typeof phase1.passwordFieldCount === 'number'
      ? phase1.passwordFieldCount
      : hasPasswordField
        ? 1
        : 0
  const interactiveElementCount =
    typeof phase1.interactiveCount === 'number' ? phase1.interactiveCount : 0
  const cookieCount =
    typeof phase1.cookieCount === 'number' ? phase1.cookieCount : 0
  const localStorageKeys = Array.isArray(phase1.lsKeys)
    ? (phase1.lsKeys as string[])
    : []
  const sessionStorageKeys = Array.isArray(phase1.ssKeys)
    ? (phase1.ssKeys as string[])
    : []
  const framework = typeof phase1.framework === 'string' ? phase1.framework : ''
  const hasNextData = phase1.hasNextData === true
  const hasReactDevtools = phase1.hasReact === true
  const hasVueInstance = phase1.hasVue === true
  const hasAngularElements = phase1.hasAngular === true
  const featureFlags =
    typeof phase1.flags === 'object' && phase1.flags !== null
      ? phase1.flags
      : {}
  const featureFlagKeys = Object.keys(featureFlags)
  const featureFlagProviders = Array.isArray(phase1.flagProviders)
    ? (phase1.flagProviders as string[])
    : []
  const schemaOrgBlocks = Array.isArray(phase1.schemaBlocks)
    ? (phase1.schemaBlocks as Array<{ type: string; summary: string }>)
    : []
  const frameworkDetected = framework || null

  // Phase 1b: Client-side routes
  let clientRoutesDiscovered: string[] = []
  let clientRouteFramework: string | null = null
  try {
    const routeRes = await browser.evaluate(pageId, PHASE1B_ROUTE_EVAL)
    if (routeRes.value && typeof routeRes.value === 'object') {
      const rv = routeRes.value as RouteResult
      if (rv.framework) clientRouteFramework = String(rv.framework)
      if (Array.isArray(rv.routes)) {
        clientRoutesDiscovered = rv.routes
          .map((r) => {
            if (typeof r === 'string') return r
            if (typeof r === 'object' && r !== null && 'path' in r)
              return String(r.path)
            return ''
          })
          .filter(Boolean)
          .slice(0, 200)
      }
    }
  } catch {}

  // Phase 3: ARIA landmarks + dialogs
  let dialogCount = 0
  const landmarkRoles: string[] = []
  let enhancedSnapshotAvailable = false
  try {
    const dialogSearch = await browser.searchDom(
      pageId,
      '[role="dialog"],[role="alertdialog"],.modal,dialog',
      { limit: 10 },
    )
    dialogCount = dialogSearch.results.length
  } catch {}
  let enhancedSnapshotText = ''
  try {
    enhancedSnapshotText = (await browser.enhancedSnapshot(pageId)) ?? ''
    enhancedSnapshotAvailable = enhancedSnapshotText.length > 0
  } catch {}
  for (const role of LANDMARK_ROLES) {
    if (enhancedSnapshotText.toLowerCase().includes(role))
      landmarkRoles.push(role)
  }

  // Phase 4: Forms + field signals (NO purpose inference)
  let forms: FormSignals[] = []
  try {
    const formResult = await browser.evaluate(pageId, PHASE4_FORM_EVAL)
    if (Array.isArray(formResult.value)) {
      forms = (formResult.value as FormResult[]).map((f, i) => ({
        index: typeof f.index === 'number' ? f.index : i,
        action: typeof f.action === 'string' ? f.action : '',
        method: typeof f.method === 'string' ? f.method.toUpperCase() : 'GET',
        fieldCount: typeof f.fieldCount === 'number' ? f.fieldCount : 0,
        submitLabel: typeof f.submitLabel === 'string' ? f.submitLabel : '',
        fields: (Array.isArray(f.fields) ? f.fields : []).map((fld) => ({
          inputType: typeof fld.inputType === 'string' ? fld.inputType : 'text',
          name: typeof fld.name === 'string' ? fld.name : '',
          label: typeof fld.label === 'string' ? fld.label : '',
          placeholder:
            typeof fld.placeholder === 'string' ? fld.placeholder : '',
          required: fld.required === true,
          autocomplete:
            typeof fld.autocomplete === 'string' ? fld.autocomplete : '',
          options: Array.isArray(fld.options) ? (fld.options as string[]) : [],
        })),
        hasEmailField: f.hasEmailField === true,
        hasPasswordField: f.hasPasswordField === true,
        hasPhoneField: f.hasPhoneField === true,
        hasFileUpload: f.hasFileUpload === true,
        hasCreditCardField: f.hasCreditCardField === true,
        hasSearchField: f.hasSearchField === true,
        requiredFieldCount:
          typeof f.requiredFieldCount === 'number' ? f.requiredFieldCount : 0,
        hiddenFieldCount:
          typeof f.hiddenFieldCount === 'number' ? f.hiddenFieldCount : 0,
      }))
    }
  } catch {}

  // Phase 5: Overlay triggers
  let overlayTriggers: OverlayTriggerSignals[] = []
  try {
    const overlayRes = await browser.evaluate(pageId, EXTRACT_OVERLAY_TRIGGERS)
    if (overlayRes.value && typeof overlayRes.value === 'object') {
      const ov = overlayRes.value as OverlayResult
      if (Array.isArray(ov.triggers)) {
        overlayTriggers = ov.triggers.map((t) => ({
          selector: typeof t.selector === 'string' ? t.selector : '',
          role: typeof t.role === 'string' ? t.role : null,
          text: typeof t.text === 'string' ? t.text : '',
          triggerType:
            typeof t.triggerType === 'string'
              ? (t.triggerType as OverlayTriggerSignals['triggerType'])
              : 'unknown',
        }))
      }
    }
  } catch {}

  // Phase 6: API calls
  let apiCallsObserved: string[] = []
  try {
    const perfRes = await browser.evaluate(pageId, PHASE6_PERF_EVAL)
    if (Array.isArray(perfRes.value))
      apiCallsObserved = perfRes.value as string[]
  } catch {}

  let fetchInitiatedCalls: string[] = []
  try {
    const fetchRes = await browser.evaluate(pageId, PHASE6_FETCH_EVAL)
    if (Array.isArray(fetchRes.value))
      fetchInitiatedCalls = fetchRes.value as string[]
  } catch {}

  // Phase 7: Link discovery with DOM position context
  const sameDomainLinks: string[] = []
  const sameDomainLinksWithContext: LinkWithContext[] = []
  const crossDomainLinks: string[] = []
  try {
    const linkContextRes = await browser.evaluate(
      pageId,
      PHASE7_LINK_CONTEXT_EVAL,
    )
    if (Array.isArray(linkContextRes.value)) {
      const linkContexts = linkContextRes.value as Array<{
        href: string
        domPosition: string
        nearestLandmark: string | null
        parentContext: string | null
      }>
      for (const lc of linkContexts) {
        if (isSameSite(lc.href, rootDomain)) {
          if (!sameDomainLinks.includes(lc.href)) {
            sameDomainLinks.push(lc.href)
            sameDomainLinksWithContext.push({
              href: lc.href,
              domPosition: lc.domPosition as LinkWithContext['domPosition'],
              nearestLandmark: lc.nearestLandmark,
              parentContext: lc.parentContext,
            })
          }
        } else {
          if (!crossDomainLinks.includes(lc.href))
            crossDomainLinks.push(lc.href)
        }
      }
    }
  } catch {}

  // Phase 8: Service worker
  let hasServiceWorker = false
  let serviceWorkerScope: string | null = null
  let serviceWorkerScriptUrl: string | null = null
  let serviceWorkerCacheNames: string[] = []
  let serviceWorkerCacheUrls: string[] = []
  try {
    const swRes = await browser.evaluate(pageId, EXTRACT_SERVICE_WORKER_SYNC)
    if (swRes.value && typeof swRes.value === 'object') {
      const sw = swRes.value as ServiceWorkerResult
      hasServiceWorker = sw.hasServiceWorker === true
      serviceWorkerScope = typeof sw.scope === 'string' ? sw.scope : null
      serviceWorkerScriptUrl =
        typeof sw.scriptUrl === 'string' ? sw.scriptUrl : null
      serviceWorkerCacheNames = Array.isArray(sw.cacheNames)
        ? (sw.cacheNames as string[])
        : []
      serviceWorkerCacheUrls = Array.isArray(sw.cacheUrls)
        ? (sw.cacheUrls as string[])
        : []
    }
  } catch {}

  // Phase 9: Web workers
  let webWorkerScriptUrls: string[] = []
  let webWorkerCount = 0
  try {
    const wwRes = await browser.evaluate(pageId, EXTRACT_WEB_WORKERS)
    if (wwRes.value && typeof wwRes.value === 'object') {
      const ww = wwRes.value as WebWorkerResult
      webWorkerScriptUrls = Array.isArray(ww.workerScriptUrls)
        ? (ww.workerScriptUrls as string[])
        : []
      webWorkerCount =
        typeof ww.count === 'number' ? ww.count : webWorkerScriptUrls.length
    }
  } catch {}

  return {
    url,
    title,
    h1,
    metaDescription,
    urlPath,
    urlHostname,
    hasPasswordField,
    passwordFieldCount,
    interactiveElementCount,
    formCount: forms.length,
    forms,
    dialogCount,
    overlayTriggers,
    frameworkDetected,
    hasNextData,
    hasReactDevtools,
    hasVueInstance,
    hasAngularElements,
    apiCallsObserved,
    fetchInitiatedCalls,
    localStorageKeys,
    sessionStorageKeys,
    cookieCount,
    hasServiceWorker,
    serviceWorkerScope,
    serviceWorkerScriptUrl,
    serviceWorkerCacheNames,
    serviceWorkerCacheUrls,
    webWorkerScriptUrls,
    webWorkerCount,
    schemaOrgBlocks,
    featureFlagKeys,
    featureFlagProviders,
    clientRoutesDiscovered,
    clientRouteFramework,
    sameDomainLinks,
    sameDomainLinksWithContext,
    crossDomainLinks,
    linkCount: sameDomainLinks.length + crossDomainLinks.length,
    landmarkRoles,
    enhancedSnapshotAvailable,
  }
}

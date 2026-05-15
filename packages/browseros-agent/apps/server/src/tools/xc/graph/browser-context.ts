/**
 * browser-context.ts — Typed context objects for BrowserInterface.
 *
 * Replaces `Record<string, unknown>` and bare `unknown` in BrowserInterface
 * with structured types, eliminating all `as any` / `as Record<string, unknown>`
 * casts in extraction-engine.ts and browser-adapter.ts.
 */

// ─── NewPage options ───────────────────

export interface NewPageOptions {
  hidden?: boolean
  background?: boolean
  windowId?: number
}

// ─── GetDom options ────────────────────

export interface GetDomOptions {
  selector?: string
}

// ─── SearchDom options ─────────────────

export interface SearchDomOptions {
  limit?: number
}

// ─── SearchDom result ──────────────────

export interface DomAttribute {
  name: string
  value: string
}

export interface DomSearchResultItem {
  backendNodeId: number
  nodeId: number
  nodeName: string
  localName: string
  nodeType: number
  attributes?: DomAttribute[]
}

export interface SearchDomResult {
  results: DomSearchResultItem[]
  totalCount: number
}

// ─── WaitForNavigation options ─────────────────

export interface WaitForNavigationOptions {
  timeout?: number
}

// ─── Evaluate result ───────────────────

export interface EvaluateResult {
  value?: unknown
  error?: string
  description?: string
}

// ─── Phase 1 extraction result (evaluate script return shape) ──────────────────

export interface Phase1Result {
  flags?: Record<string, unknown>
  [key: string]: unknown
}

// ─── Route extraction result ───────────────────

export interface RouteEntry {
  path: string
  [key: string]: unknown
}

export interface RouteResult {
  routes?: RouteEntry[]
  [key: string]: unknown
}

// ─── Form extraction result ────────────────────

export interface FormFieldResult {
  name?: string
  type?: string
  placeholder?: string
  required?: boolean
  [key: string]: unknown
}

export interface FormResult {
  action?: string
  method?: string
  fields?: FormFieldResult[]
  [key: string]: unknown
}

// ─── Overlay trigger result ────────────────────

export interface OverlayTriggerResult {
  type?: string
  selector?: string
  text?: string
  [key: string]: unknown
}

export interface OverlayResult {
  triggers?: OverlayTriggerResult[]
  [key: string]: unknown
}

// ─── Service worker / web worker results ───────────────────────

export interface ServiceWorkerResult {
  [key: string]: unknown
}

export interface WebWorkerResult {
  [key: string]: unknown
}

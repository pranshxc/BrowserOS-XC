/**
 * BrowserOS-XC Knowledge Graph Schema — Phase 11
 *
 * Node type taxonomy (11 types):
 *   page         — A URL/route visited
 *   form         — A <form> element on a page
 *   field        — An <input>, <select>, <textarea> inside a form
 *   action       — A button / CTA / JS-triggered link
 *   api_call     — A network request intercepted or inferred
 *   popup        — A modal, dialog, sheet, tooltip, dropdown
 *   nav_region   — ARIA landmark / structural zone (header, nav, main, footer)
 *   content_block — A named content section (H2/H3 heading + body)
 *   error_state  — A validation error or failure state observed
 *   auth_gate    — A page/resource that requires authentication
 *   js_bundle    — Detected JS framework, global objects, feature flags
 *   local_storage — client-side key detected in localStorage / sessionStorage
 *   schema_org   — JSON-LD structured data block found on page
 *
 * Edge type taxonomy:
 *   navigates_to       — page → page
 *   contains           — page → form, page → popup, page → nav_region, form → field
 *   submits_to         — form → api_call
 *   triggers           — action → api_call, action → popup, action → page
 *   validates_via      — field → api_call (live validation on blur)
 *   redirects_to       — page → page (HTTP 30x or JS location)
 *   authenticates_with — page → api_call (login/auth flows)
 *   auth_gate          — page → auth_gate
 *   requires           — feature/workflow → feature
 *   calls_api          — feature → api_call
 *   part_of            — sub-node → parent node
 *   depends_on         — node → node
 *
 * ID conventions
 * ──────────────
 *   page:<url-slug>
 *   form:<page-slug>:<form-index>
 *   field:<form-id>:<field-name-or-index>
 *   action:<page-slug>:<label-slug>
 *   api:<METHOD>:<url-pattern-slug>
 *   popup:<page-slug>:<popup-index>
 *   nav_region:<page-slug>:<role>
 *   content_block:<page-slug>:<heading-slug>
 *   error_state:<page-slug>:<trigger-slug>
 *   auth_gate:<url-slug>
 *   js_bundle:<page-slug>:<framework>
 *   local_storage:<page-slug>:<key>
 *   schema_org:<page-slug>:<type>
 *   feature:<slugified-name>
 *   workflow:<slugified-name>
 */

export type NodeKind =
  | 'feature'
  | 'page'
  | 'api'
  | 'workflow'
  | 'form'
  | 'field'
  | 'action'
  | 'api_call'
  | 'popup'
  | 'nav_region'
  | 'content_block'
  | 'error_state'
  | 'auth_gate'
  | 'js_bundle'
  | 'local_storage'
  | 'schema_org'

export type EdgeType =
  | 'requires'
  | 'triggers'
  | 'navigates_to'
  | 'calls_api'
  | 'renders_on'
  | 'part_of'
  | 'guarded_by'
  | 'depends_on'
  | 'contains'
  | 'submits_to'
  | 'validates_via'
  | 'redirects_to'
  | 'authenticates_with'
  | 'auth_gate'

// ─────────────────────────────────────────────────────────────────────────────
// Existing node interfaces (preserved)
// ─────────────────────────────────────────────────────────────────────────────

/** A discrete capability or UI feature the website exposes. */
export interface FeatureNode {
  '@type': 'Feature'
  id: string
  name: string
  description: string
  pageUrl: string
  pageId?: string
  reactComponent?: string
  featureFlag?: string
  authRequired?: boolean
  discoveredAt?: string
  confidence?: number
  rawEvidence?: string[]
  tags?: string[]
}

/** A page / route the crawler visited. */
export interface PageNode {
  '@type': 'Page'
  id: string
  url: string
  title?: string
  statusCode?: number
  framework?: string
  loadTimeMs?: number
  hasAuth?: boolean
  interactiveElementCount?: number
  discoveredAt?: string
  // Phase 11 additions
  description?: string
  h1?: string
  pageRole?: 'landing' | 'login' | 'dashboard' | 'form' | 'docs' | 'pricing' | 'blog' | 'other'
  formCount?: number
  apiCallsObserved?: string[]
  schemaOrgTypes?: string[]
}

/** A single workflow step. */
export interface ActionStep {
  order: number
  action: 'navigate' | 'click' | 'fill' | 'submit' | 'observe' | 'eval'
  description: string
  selector?: string
  value?: string
  resultPageUrl?: string
  apiCallsTriggered?: string[]
}

/** A multi-step user journey through the site. */
export interface WorkflowNode {
  '@type': 'Workflow'
  id: string
  name: string
  description: string
  startPageId: string
  steps: ActionStep[]
  triggeredAPIs: string[]
  requiredFeatures?: string[]
  authRequired?: boolean
  discoveredAt?: string
}

/** An observed or inferred HTTP/WS API endpoint. */
export interface APIEndpointNode {
  '@type': 'APIEndpoint'
  id: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'WS' | 'SSE' | string
  urlPattern: string
  rawUrls?: string[]
  requestSchema?: Record<string, unknown>
  responseSchema?: Record<string, unknown>
  sampleRequest?: string
  sampleResponse?: string
  statusCodes?: number[]
  calledByFeatures?: string[]
  calledByWorkflows?: string[]
  authRequired?: boolean
  discoveredAt?: string
}

/** A directed edge connecting any two nodes. */
export interface DependencyEdge {
  id: string
  from: string
  to: string
  type: EdgeType
  label?: string
  weight?: number
  metadata?: Record<string, unknown>
  discoveredAt?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11 — New semantic node interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** A <form> element discovered on a page. */
export interface FormNode {
  '@type': 'Form'
  id: string
  parentPageId: string
  action: string
  method: string
  purpose?: string        // inferred: "Sign In", "Contact Us", "Search", etc.
  submitLabel?: string    // text of the submit button
  fieldCount?: number
  discoveredAt?: string
}

/** A form field: <input>, <select>, <textarea>. */
export interface FieldNode {
  '@type': 'Field'
  id: string
  parentFormId: string
  parentPageId: string
  inputType: string       // text, email, password, tel, hidden, select, checkbox, radio, etc.
  name?: string           // name attribute
  label?: string          // matched <label> text or aria-label
  placeholder?: string
  required?: boolean
  autocomplete?: string   // autocomplete attribute hint
  validationPattern?: string
  defaultValue?: string
  options?: string[]      // for <select>
  discoveredAt?: string
}

/** A button, CTA, or JS-triggered interactive element. */
export interface ActionNode {
  '@type': 'Action'
  id: string
  parentPageId: string
  label: string
  triggerType: 'click' | 'submit' | 'hover' | 'keydown' | 'other'
  selector?: string       // CSS selector for the element
  href?: string           // if it's a link
  jsHandler?: string      // inferred JS function name if readable
  navigatesTo?: string    // destination page URL if known
  discoveredAt?: string
}

/** A network request intercepted or inferred on a page. */
export interface ApiCallNode {
  '@type': 'ApiCall'
  id: string
  parentPageId: string
  method: string
  endpoint: string
  inferredPurpose?: string
  triggerSource?: string  // action/form node ID that fires this
  payloadKeys?: string[]
  discoveredAt?: string
}

/** A modal, dialog, sheet, tooltip, or dropdown. */
export interface PopupNode {
  '@type': 'Popup'
  id: string
  parentPageId: string
  triggerSelector?: string
  role?: string           // dialog, tooltip, menu, alertdialog, etc.
  content?: string        // brief description of popup content
  discoveredAt?: string
}

/** An ARIA landmark / structural zone (header, nav, main, footer, aside). */
export interface NavRegionNode {
  '@type': 'NavRegion'
  id: string
  parentPageId: string
  role: string            // navigation, banner, main, contentinfo, complementary, etc.
  label?: string          // aria-label if present
  linkCount?: number
  discoveredAt?: string
}

/** A named content section on the page (heading + body). */
export interface ContentBlockNode {
  '@type': 'ContentBlock'
  id: string
  parentPageId: string
  heading: string
  headingLevel?: number   // 1-6
  summary?: string
  discoveredAt?: string
}

/** A validation error or failure state observed during interaction. */
export interface ErrorStateNode {
  '@type': 'ErrorState'
  id: string
  parentPageId: string
  triggerDescription?: string
  errorMessage?: string
  affectedSelector?: string
  discoveredAt?: string
}

/** A page or resource that requires authentication to access. */
export interface AuthGateNode {
  '@type': 'AuthGate'
  id: string
  url: string
  redirectsTo?: string    // login page URL
  authMethod?: string     // cookie, bearer, basic, oauth, etc.
  discoveredAt?: string
}

/** A detected JS framework, global object, or feature flag bundle. */
export interface JsBundleNode {
  '@type': 'JsBundle'
  id: string
  parentPageId: string
  framework?: string      // React, Vue, Angular, Svelte, Next.js, etc.
  globals?: string[]      // detected window.* keys of interest
  featureFlags?: Record<string, unknown>
  hasNextData?: boolean
  hasVueInstance?: boolean
  hasReactDevTools?: boolean
  discoveredAt?: string
}

/** A key found in localStorage or sessionStorage. */
export interface LocalStorageNode {
  '@type': 'LocalStorage'
  id: string
  parentPageId: string
  storageType: 'localStorage' | 'sessionStorage'
  key: string
  valuePreview?: string   // first 100 chars only
  discoveredAt?: string
}

/** A JSON-LD schema.org block found on the page. */
export interface SchemaDotOrgNode {
  '@type': 'SchemaDotOrg'
  id: string
  parentPageId: string
  schemaType: string      // e.g. "Product", "Organization", "FAQPage"
  summary?: string
  discoveredAt?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph envelope (preserved + extended)
// ─────────────────────────────────────────────────────────────────────────────

export interface KnowledgeGraph {
  '@context': 'https://schema.org/'
  '@type': 'Dataset'
  name: string
  description: string
  targetUrl: string
  createdAt: string
  updatedAt: string
  version: number
  nodes: {
    features: Record<string, FeatureNode>
    pages: Record<string, PageNode>
    workflows: Record<string, WorkflowNode>
    apis: Record<string, APIEndpointNode>
    // Phase 11
    forms: Record<string, FormNode>
    fields: Record<string, FieldNode>
    actions: Record<string, ActionNode>
    api_calls: Record<string, ApiCallNode>
    popups: Record<string, PopupNode>
    nav_regions: Record<string, NavRegionNode>
    content_blocks: Record<string, ContentBlockNode>
    error_states: Record<string, ErrorStateNode>
    auth_gates: Record<string, AuthGateNode>
    js_bundles: Record<string, JsBundleNode>
    local_storage: Record<string, LocalStorageNode>
    schema_org: Record<string, SchemaDotOrgNode>
  }
  edges: Record<string, DependencyEdge>
  stats: GraphStats
}

export interface GraphStats {
  featureCount: number
  pageCount: number
  workflowCount: number
  apiCount: number
  edgeCount: number
  lastMutationAt: string
  crawlDepth: number
  urlsVisited: string[]
  // Phase 11
  formCount?: number
  fieldCount?: number
  actionCount?: number
  apiCallCount?: number
  popupCount?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// ID helpers (all preserved + new)
// ─────────────────────────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
}

export function featureId(name: string): string {
  return `feature:${slugify(name)}`
}

export function pageId(url: string): string {
  return `page:${slugify(url)}`
}

export function apiId(method: string, urlPattern: string): string {
  return `api:${method.toUpperCase()}:${slugify(urlPattern)}`
}

export function workflowId(name: string): string {
  return `workflow:${slugify(name)}`
}

export function edgeId(from: string, to: string, type: EdgeType): string {
  return `edge:${from}\u2192${to}:${type}`
}

export function formId(pageSlug: string, index: number): string {
  return `form:${pageSlug}:${index}`
}

export function fieldId(formSlug: string, nameOrIndex: string | number): string {
  return `field:${formSlug}:${slugify(String(nameOrIndex))}`
}

export function actionId(pageSlug: string, label: string): string {
  return `action:${pageSlug}:${slugify(label)}`
}

export function apiCallId(pageSlug: string, method: string, endpoint: string): string {
  return `api_call:${pageSlug}:${method.toUpperCase()}:${slugify(endpoint)}`
}

export function popupId(pageSlug: string, index: number): string {
  return `popup:${pageSlug}:${index}`
}

export function navRegionId(pageSlug: string, role: string): string {
  return `nav_region:${pageSlug}:${slugify(role)}`
}

export function contentBlockId(pageSlug: string, heading: string): string {
  return `content_block:${pageSlug}:${slugify(heading)}`
}

export function jsBundleId(pageSlug: string): string {
  return `js_bundle:${pageSlug}`
}

export function localStorageNodeId(pageSlug: string, key: string): string {
  return `local_storage:${pageSlug}:${slugify(key)}`
}

export function schemaDotOrgId(pageSlug: string, schemaType: string): string {
  return `schema_org:${pageSlug}:${slugify(schemaType)}`
}

export function nowISO(): string {
  return new Date().toISOString()
}

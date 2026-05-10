/**
 * XC Phase 10 — Knowledge Graph Schema
 *
 * This file defines the complete type system for the website intelligence graph.
 * Every tool from Phases 1–9 feeds into nodes and edges defined here.
 *
 * Design principles
 * ─────────────────
 * 1. Incrementality — every node has a `confidence` field (0.0–1.0) that
 *    increases as more evidence is collected. Nodes start at 0.3 (inferred)
 *    and reach 1.0 (verified by multiple methods).
 *
 * 2. Provenance — every node tracks which XC phase and tool discovered it,
 *    and when. This lets a reviewer trust or discount each piece of data.
 *
 * 3. Richness — nodes carry everything: the raw evidence (API calls, DOM
 *    selectors, JS expressions) alongside the inferred semantics (name,
 *    description, category). An AI can regenerate the semantics; the raw
 *    evidence is irreplaceable.
 *
 * 4. AI-readability — every node has a `summary` string that a language
 *    model can read without needing to parse the full object. This is the
 *    key field used by graph_query and graph_summary.
 *
 * Node types
 * ───────────
 *   PageNode        — a URL / route (the structural backbone)
 *   FeatureNode     — a user-facing capability inferred from the page
 *   WorkflowNode    — an ordered sequence of steps achieving a goal
 *   APIEndpointNode — a network endpoint (REST, GraphQL, WS, SSE)
 *   UIComponentNode — a React/Vue/Angular component or notable DOM region
 *   StorageNode     — a localStorage key, cookie, IndexedDB store, or cache
 *   WorkerNode      — a service worker or web worker
 *
 * Edge types
 * ──────────
 *   navigates_to    — page A links/redirects to page B
 *   requires        — feature/workflow requires another feature/auth/page
 *   triggers        — user action on A causes B to appear/happen
 *   calls_api       — page/feature calls an API endpoint
 *   renders         — page renders a UI component
 *   reads_storage   — page/feature reads a storage key
 *   writes_storage  — page/feature writes a storage key
 *   uses_worker     — page/feature delegates to a worker
 *   part_of         — workflow step is part of a workflow
 *   guarded_by      — feature is behind an auth check or feature flag
 */

// ── Provenance ─────────────────────────────────────────────────────────────────

export type XcPhase =
  | 'phase-1-navigation'
  | 'phase-2-refs'
  | 'phase-3-storage'
  | 'phase-4-frames'
  | 'phase-5-visual'
  | 'phase-6-framework'
  | 'phase-7-network'
  | 'phase-8-performance'
  | 'phase-9-eval'
  | 'phase-10-graph'
  | 'manual'

export interface Provenance {
  /** Which XC phase first detected this node */
  phase: XcPhase
  /** Tool name that created this node (e.g. 'snapshot_with_refs', 'list_captured_requests') */
  tool: string
  /** ISO timestamp when this node was first added */
  discoveredAt: string
  /** ISO timestamp of last update */
  updatedAt: string
  /** URL of the page being analyzed when this was discovered */
  sourceUrl: string
  /** Raw evidence snippets: DOM selectors, network log lines, JS expressions */
  evidence: string[]
}

// ── Base node ────────────────────────────────────────────────────────────────────

export interface BaseNode {
  /** Stable unique ID: deterministic hash of (type + primary key fields) */
  id: string
  /** Node type discriminant */
  type: NodeType
  /**
   * One-sentence summary readable by an LLM without parsing the full node.
   * Used by graph_query keyword search and graph_summary output.
   * Example: "Login page at /login — accepts email+password, calls POST /api/auth/login"
   */
  summary: string
  /** Confidence score 0.0–1.0. Starts 0.3 (inferred), grows with evidence */
  confidence: number
  /** Tags for categorization: 'auth', 'payment', 'navigation', 'data', etc. */
  tags: string[]
  /** Provenance tracking */
  provenance: Provenance
  /** Optional freeform notes added by the AI agent */
  notes?: string
}

export type NodeType =
  | 'page'
  | 'feature'
  | 'workflow'
  | 'api_endpoint'
  | 'ui_component'
  | 'storage'
  | 'worker'

// ── Node types ──────────────────────────────────────────────────────────────────

export interface PageNode extends BaseNode {
  type: 'page'
  /** Full URL of this page */
  url: string
  /** Normalized URL path (no query, no hash) for dedup */
  path: string
  /** Page title from <title> tag or document.title */
  title: string
  /** HTTP status code observed (200, 301, 404, etc.) */
  httpStatus?: number
  /** Is this page behind authentication? */
  requiresAuth: boolean
  /** Is this a dynamic route with params? e.g. '/user/:id' */
  isDynamic: boolean
  /** URL parameters extracted from path pattern */
  pathParams: string[]
  /** Query parameters observed on this page */
  queryParams: string[]
  /** All outbound links from this page (normalized paths) */
  outboundLinks: string[]
  /** Interactive elements found: buttons, forms, inputs */
  interactiveElements: InteractiveElement[]
  /** Framework-detected info */
  framework?: string
  /** Page load performance (ms) */
  loadTimeMs?: number
  /** Screenshot filename if taken */
  screenshotFile?: string
  /** Raw DOM snapshot hash for change detection */
  domHash?: string
}

export interface InteractiveElement {
  /** CSS selector or ref ID */
  selector: string
  /** Element type: button, input, form, link, select, textarea */
  elementType: string
  /** Visible label text */
  label: string
  /** What action does this element trigger? (inferred) */
  action?: string
  /** Does it require auth to use? */
  requiresAuth?: boolean
}

export interface FeatureNode extends BaseNode {
  type: 'feature'
  /** Human-readable feature name */
  name: string
  /** What this feature does for the user */
  description: string
  /** Which page(s) expose this feature */
  pageUrls: string[]
  /** React/Vue/Angular component name if detected */
  reactComponent?: string
  /** Feature flag key controlling this feature, if any */
  featureFlagKey?: string
  /** Is this feature currently enabled? */
  featureFlagEnabled?: boolean
  /** Is this feature hidden (built but not exposed in UI)? */
  isHidden: boolean
  /** Category: 'core', 'auth', 'payment', 'social', 'admin', 'analytics', etc. */
  category: string
  /** User roles that can access this feature */
  requiredRoles: string[]
  /** UI entry points (selectors or descriptions) */
  entryPoints: string[]
}

export interface ActionStep {
  /** Step number (1-based) */
  stepNumber: number
  /** Human description: "Click the Submit button" */
  description: string
  /** Page URL where this step happens */
  pageUrl: string
  /** Tool call that performs this step */
  toolCall?: string
  /** API endpoints triggered by this step */
  triggeredApis: string[]
  /** Storage operations: reads/writes */
  storageOps: string[]
  /** What the page looks like after this step (brief) */
  resultState?: string
}

export interface WorkflowNode extends BaseNode {
  type: 'workflow'
  /** Workflow name: "User Registration", "Checkout", "Password Reset" */
  name: string
  /** What the user achieves by completing this workflow */
  goal: string
  /** Ordered steps */
  steps: ActionStep[]
  /** All API endpoints called across all steps */
  triggeredAPIs: string[]
  /** Starting page URL */
  entryPageUrl: string
  /** Ending page URL */
  exitPageUrl?: string
  /** Can be completed without authentication? */
  requiresAuth: boolean
  /** Estimated step count */
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex'
  /** Has this workflow been fully traced? */
  isComplete: boolean
}

export interface APIEndpointNode extends BaseNode {
  type: 'api_endpoint'
  /** HTTP method: GET, POST, PUT, PATCH, DELETE, WS, SSE, GraphQL */
  method: string
  /** URL pattern with placeholders: /api/users/:id */
  urlPattern: string
  /** Full example URL observed */
  exampleUrl: string
  /** API type */
  apiType: 'rest' | 'graphql' | 'websocket' | 'sse' | 'grpc' | 'unknown'
  /** GraphQL operation name if applicable */
  graphqlOperation?: string
  /** GraphQL operation type: query / mutation / subscription */
  graphqlType?: 'query' | 'mutation' | 'subscription'
  /** Request content-type */
  requestContentType?: string
  /** Inferred request schema (field names observed in request body) */
  requestSchema?: Record<string, string>
  /** Inferred response schema (field names observed in response) */
  responseSchema?: Record<string, string>
  /** HTTP status codes observed */
  observedStatusCodes: number[]
  /** Authentication required (inferred from 401/403 or Authorization header) */
  requiresAuth: boolean
  /** Average response time in ms */
  avgResponseTimeMs?: number
  /** Pages/features that call this endpoint */
  calledBy: string[]
}

export interface UIComponentNode extends BaseNode {
  type: 'ui_component'
  /** Component name: "LoginForm", "CartSidebar", "PaymentModal" */
  name: string
  /** Framework: 'react', 'vue', 'angular', 'svelte', 'unknown' */
  framework: string
  /** File path hint from source maps */
  sourcePath?: string
  /** Props/inputs observed */
  props: string[]
  /** State variables */
  stateKeys: string[]
  /** Child component names */
  children: string[]
  /** Pages where this component appears */
  appearsOnPages: string[]
  /** Is this a lazy-loaded component? */
  isLazy: boolean
  /** Suspense boundary name if wrapped */
  suspenseBoundary?: string
}

export interface StorageNode extends BaseNode {
  type: 'storage'
  /** Storage type */
  storageType: 'localStorage' | 'sessionStorage' | 'cookie' | 'indexedDB' | 'cacheAPI' | 'serviceWorkerCache'
  /** Key or store name */
  key: string
  /** Inferred data type of value */
  valueType: string
  /** Example value (truncated) */
  exampleValue?: string
  /** Purpose inferred from key name + context */
  purpose?: string
  /** Is this a session token / auth credential? */
  isAuthRelated: boolean
  /** Pages that read this key */
  readByPages: string[]
  /** Pages that write this key */
  writtenByPages: string[]
}

export interface WorkerNode extends BaseNode {
  type: 'worker'
  /** Worker type */
  workerType: 'service_worker' | 'web_worker' | 'shared_worker'
  /** Script URL */
  scriptUrl: string
  /** Scope URL (service workers) */
  scope?: string
  /** Worker state */
  state: 'active' | 'waiting' | 'installing' | 'running' | 'stopped'
  /** Route patterns handled (service workers) */
  routePatterns: string[]
  /** Global variable names defined in this worker */
  globalNames: string[]
  /** Inferred purpose from script analysis */
  inferredPurpose?: string
  /** Features this worker implements */
  implementsFeatures: string[]
  /** Has push notification handler */
  hasPushHandler: boolean
  /** Has background sync handler */
  hasBackgroundSync: boolean
}

// ── Edges ──────────────────────────────────────────────────────────────────────────

export type EdgeType =
  | 'navigates_to'
  | 'requires'
  | 'triggers'
  | 'calls_api'
  | 'renders'
  | 'reads_storage'
  | 'writes_storage'
  | 'uses_worker'
  | 'part_of'
  | 'guarded_by'

export interface DependencyEdge {
  /** Stable edge ID: hash of (from + to + type) */
  id: string
  /** Source node ID */
  from: string
  /** Target node ID */
  to: string
  /** Relationship type */
  type: EdgeType
  /** Human description of this relationship */
  label: string
  /** How confident are we in this edge? 0.0–1.0 */
  confidence: number
  /** ISO timestamp when this edge was first observed */
  discoveredAt: string
  /** Tool that produced this edge */
  tool: string
  /** Additional properties for specific edge types */
  properties?: Record<string, unknown>
}

// ── Graph session ─────────────────────────────────────────────────────────────

export interface GraphSession {
  /** Session ID */
  id: string
  /** Target website root URL */
  targetUrl: string
  /** Session start timestamp */
  startedAt: string
  /** Session last update timestamp */
  updatedAt: string
  /** Optional human label */
  label?: string
  /** Map site mission status */
  status: 'idle' | 'mapping' | 'paused' | 'complete'
  /** BFS frontier: page URLs yet to be visited */
  frontier: string[]
  /** Already-visited page URLs */
  visited: Set<string>
  /** Pages that errored out */
  errors: Array<{ url: string; error: string; ts: string }>
  /** Mapping configuration */
  config: MappingConfig
}

export interface MappingConfig {
  /** Max pages to visit (default 50) */
  maxPages: number
  /** Max depth from root (default 5) */
  maxDepth: number
  /** Stay within this origin? (default true) */
  sameOriginOnly: boolean
  /** URL path patterns to skip */
  skipPatterns: string[]
  /** Include auth-required pages? */
  includeAuthPages: boolean
  /** Run network capture on each page? */
  captureNetwork: boolean
  /** Run eval presets on each page? */
  runEvalPresets: boolean
  /** Output directory for exports */
  outputDir?: string
}

export interface GraphStats {
  totalNodes: number
  totalEdges: number
  byType: Record<NodeType, number>
  byEdgeType: Record<EdgeType, number>
  avgConfidence: number
  /** Pages fully explored */
  pagesVisited: number
  /** Pages in frontier (not yet explored) */
  pagesRemaining: number
  /** Top 10 most connected node IDs and their degree */
  topConnected: Array<{ id: string; summary: string; degree: number }>
  /** Coverage score 0–100 */
  coverageScore: number
  /** Session duration in seconds */
  sessionDurationSec?: number
}

// ── Graph snapshot (what gets serialized) ─────────────────────────────────────

export type AnyNode = PageNode | FeatureNode | WorkflowNode | APIEndpointNode | UIComponentNode | StorageNode | WorkerNode

export interface GraphSnapshot {
  version: '1.0'
  exportedAt: string
  session: Omit<GraphSession, 'visited'> & { visited: string[] }
  nodes: AnyNode[]
  edges: DependencyEdge[]
  stats: GraphStats
}

// ── JSON-LD context ────────────────────────────────────────────────────────────────

export const JSON_LD_CONTEXT = {
  '@vocab': 'https://schema.browseros-xc.dev/graph#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  schema: 'https://schema.org/',
  id: '@id',
  type: '@type',
  from: { '@type': '@id' },
  to: { '@type': '@id' },
} as const

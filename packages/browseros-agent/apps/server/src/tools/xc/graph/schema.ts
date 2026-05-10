/**
 * BrowserOS-XC Phase 10 — Knowledge Graph Schema
 *
 * ID conventions
 * ──────────────
 *   feature:<slugified-name>            e.g. feature:submit-story
 *   page:<url-slug>                     e.g. page:news-ycombinator-com-submit
 *   api:<METHOD>:<url-pattern-slug>     e.g. api:POST:vote
 *   workflow:<slugified-name>           e.g. workflow:upvote-story
 *   edge:<from>→<to>:<type>
 */

export type NodeKind = 'feature' | 'page' | 'api' | 'workflow'

export type EdgeType =
  | 'requires'
  | 'triggers'
  | 'navigates_to'
  | 'calls_api'
  | 'renders_on'
  | 'part_of'
  | 'guarded_by'
  | 'depends_on'

// ─────────────────────────────────────────────────────────────────────────────
// Node interfaces
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
// Graph envelope
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
}

// ─────────────────────────────────────────────────────────────────────────────
// ID helpers
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
  return `edge:${from}→${to}:${type}`
}

export function nowISO(): string {
  return new Date().toISOString()
}

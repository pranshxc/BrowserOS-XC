/**
 * page-signals.ts — Raw signal types for the XC Intelligence Mapper.
 *
 * Every type here represents a FACT, never an INTERPRETATION.
 * No "this is a login page" — only "this page has a password field and 3 interactive elements."
 * The LLM agent reads these raw signals and decides what they mean.
 *
 * This replaces: inferPageRole(), isAuthWall(), inferFormPurpose()
 */

// ─── Page-level raw signals ────────────────────────────────────────────────────

export interface PageSignals {
  url: string
  title: string
  h1: string
  metaDescription: string
  urlPath: string
  urlHostname: string

  hasPasswordField: boolean
  passwordFieldCount: number
  interactiveElementCount: number
  formCount: number
  forms: FormSignals[]
  dialogCount: number
  overlayTriggers: OverlayTriggerSignals[]

  frameworkDetected: string | null
  hasNextData: boolean
  hasReactDevtools: boolean
  hasVueInstance: boolean
  hasAngularElements: boolean

  apiCallsObserved: string[]
  fetchInitiatedCalls: string[]

  localStorageKeys: string[]
  sessionStorageKeys: string[]
  cookieCount: number

  hasServiceWorker: boolean
  serviceWorkerScope: string | null
  serviceWorkerScriptUrl: string | null
  serviceWorkerCacheNames: string[]
  serviceWorkerCacheUrls: string[]
  webWorkerScriptUrls: string[]
  webWorkerCount: number

  schemaOrgBlocks: Array<{ type: string; summary: string }>
  featureFlagKeys: string[]
  featureFlagProviders: string[]

  clientRoutesDiscovered: string[]
  clientRouteFramework: string | null

  sameDomainLinks: string[]
  sameDomainLinksWithContext: LinkWithContext[]
  crossDomainLinks: string[]
  linkCount: number

  landmarkRoles: string[]
  enhancedSnapshotAvailable: boolean
}

// ─── Form raw signals ──────────────────────────────────────────────────────────

export interface FormSignals {
  index: number
  action: string
  method: string
  fieldCount: number
  submitLabel: string
  fields: FieldSignals[]

  hasEmailField: boolean
  hasPasswordField: boolean
  hasPhoneField: boolean
  hasFileUpload: boolean
  hasCreditCardField: boolean
  hasSearchField: boolean
  requiredFieldCount: number
  hiddenFieldCount: number
}

// ─── Field raw signals ─────────────────────────────────────────────────────────

export interface FieldSignals {
  inputType: string
  name: string
  label: string
  placeholder: string
  required: boolean
  autocomplete: string
  options: string[]
}

// ─── Link position context ────────────────────────────────────────────────────

export type DomPosition =
  | 'nav'
  | 'header'
  | 'main'
  | 'footer'
  | 'aside'
  | 'api_related'
  | 'unknown'

export interface LinkWithContext {
  href: string
  domPosition: DomPosition
  nearestLandmark: string | null
  parentContext: string | null
}

// ─── Overlay trigger signals ────────────────────────────────────────────────────

export interface OverlayTriggerSignals {
  selector: string
  role: string | null
  text: string
  triggerType: 'button' | 'link' | 'keyboard' | 'unknown'
}

// ─── Interaction result (state change after an action) ─────────────────────────

export interface InteractionResult {
  action: string
  target: string

  urlChanged: boolean
  newUrl: string | null
  networkCallsTriggered: string[]
  dialogsAppeared: string[]
  errorsObserved: string[]

  newLinksDiscovered: string[]
  newFormsDiscovered: number
  newApiCallsDiscovered: string[]

  authStateChange: 'none' | 'authenticated' | 'failed' | 'unknown'
  cookiesAfter: number
  localStorageKeysAfter: string[]

  postInteractionSignals: PageSignals | null
}

// ─── Issue detection output ────────────────────────────────────────────────────

export type XcActionType =
  | 'visit'
  | 'interact'
  | 'probe_form'
  | 'attempt_auth'
  | 'dismiss_overlay'
  | 'enqueue_routes'
  | 'inspect_background'
  | 'skip'

export interface MapperIssue {
  type: string
  description: string
  rawSignals: Record<string, unknown>
  possibleActions: Array<{
    action: XcActionType
    description: string
    requires?: string
  }>
  confidence: number
}

// ─── Frontier item ────────────────────────────────────────────────────────────

export interface FrontierItem {
  url: string
  suggestedScore: number
  reasoning: string
  assumptions: string[]
  signals: Record<string, unknown>
  discoveredAt: number
  sourceUrl: string
  type: 'route' | 'client_route' | 'api_endpoint' | 'asset'
}

// ─── Crawl Queue Types ───────────────────────────────────────────────────────────

export type CrawlTier = 'mustVisit' | 'checkOnce'

export type DiscoverySource =
  | 'link'
  | 'client_route'
  | 'sitemap'
  | 'robots'
  | 'auth_unblock'

export interface QueueItem extends FrontierItem {
  tier: CrawlTier
  discoverySource: DiscoverySource
}

// ─── Visit Tracker Types ─────────────────────────────────────────────────────────

export interface VisitRecord {
  url: string
  tier: CrawlTier
  visitedAt: number
  pagesVisitedSince: number
  urlCount: number
}

export interface StallStatus {
  isStalled: boolean
  consecutiveEmptyPages: number
  threshold: number
}

export interface SitemapDiscoveryResult {
  sitemapUrls: string[]
  robotsUrls: string[]
  sitemapError?: string
  robotsError?: string
}

// ─── Crawl Loop Types ───────────────────

export interface CrawlLoopState {
  /** Current phase: draining mustVisit, draining checkOnce, stalled, or done */
  phase: 'mustVisit' | 'checkOnce' | 'stalled' | 'done'
  /** Items remaining in mustVisit tier */
  mustVisitRemaining: number
  /** Items remaining in checkOnce tier */
  checkOnceRemaining: number
  /** Pages visited in this loop run */
  pagesVisited: number
  /** Consecutive pages that yielded zero new URLs */
  consecutiveEmptyPages: number
  /** Whether stall recovery has been attempted */
  stallRecoveryAttempted: boolean
  /** Number of times stall recovery has run */
  stallRecoveryCount: number
}

export interface CrawlLoopResult {
  /** Final state when loop exits */
  finalState: CrawlLoopState
  /** Total pages visited during the loop */
  totalPagesVisited: number
  /** Total new URLs discovered during the loop */
  totalUrlsDiscovered: number
  /** Reason the loop stopped */
  stopReason:
    | 'queue_exhausted'
    | 'max_pages_reached'
    | 'max_depth_reached'
    | 'stall_unrecoverable'
    | 'manual_stop'
  /** URLs discovered via stall recovery */
  stallRecoveryUrls: string[]
  /** Errors encountered (non-fatal) */
  errors: Array<{ url: string; message: string }>
}

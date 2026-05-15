// ─── Core disk-persistent graph tools (graph_add_node, graph_add_edge, etc.) ─

// ─── Browser wrapper ───────────────────────────────────────────────────────────
export { adaptBrowser, BrowserAdapter } from './browser-adapter'
export type {
  NewPageOptions,
  GetDomOptions,
  SearchDomOptions,
  SearchDomResult,
  WaitForNavigationOptions,
  EvaluateResult,
  Phase1Result,
  RouteResult,
  FormResult,
  FormFieldResult,
  OverlayResult,
  OverlayTriggerResult,
  ServiceWorkerResult,
  WebWorkerResult,
  PageLink,
} from './browser-context'
export type { CrawlErrorCode, CrawlErrorSeverity } from './crawl-error'
// ─── Structured error handling ────────────────────────────────────────────────
export {
  CrawlError,
  isCrawlError,
  SEVERITY_MAP,
  toCrawlError,
} from './crawl-error'
export { graph_add_edge } from './graph-add-edge'
export { graph_add_node } from './graph-add-node'
export { graph_export } from './graph-export'
export { graph_list } from './graph-list'
export { graph_load } from './graph-load'
export { graph_mermaid } from './graph-mermaid'
export { graph_query } from './graph-query'
export { graph_read } from './graph-read'
export { graph_reset } from './graph-reset'
// ─── New: explicit save-all-formats + read-back tools ────────────────────────
export { graph_save } from './graph-save'
export { graph_summary } from './graph-summary'
// ─── Legacy typed-node graph tools (graph_add_page / feature / api / workflow) ─
// These bridge into the disk-persistent store via graph-store.ts.
export {
  graph_add_api,
  graph_add_feature,
  graph_add_page,
  graph_add_relation,
  graph_add_workflow,
  graph_export_legacy,
  graph_query_legacy,
  graph_summary_legacy,
} from './graph-tools'
export type { MapperSessionCheckpoint } from './mapper-session'
// ─── Session recovery (crash recovery) ────────────────────────────────────────
export {
  deleteMapperCheckpoint,
  listCheckpoints,
  loadMapperCheckpoint,
  resumeMapperSession,
  saveMapperCheckpoint,
  tryResumeLastSession,
} from './mapper-session'
export type { StartMappingOptions } from './xc-bootstrap'
// ─── LLM-driven intelligence mapper (replaces map_site_start) ──────────────────
// The old map_site_start is replaced by step-level tools where the external LLM
// agent makes every decision. xc_bootstrap initializes a session, xc_step executes
// ONE action per call, xc_frontier views/modifies the priority queue.
export { startMapping, xc_bootstrap } from './xc-bootstrap'
export { xc_frontier } from './xc-frontier'
export { xc_step } from './xc-step'

// ─── Supporting modules (not exported as tools, used by xc_step internally) ────
// extraction-engine, page-signals, issue-detector, heuristic-scorer,
// mapper-session, post-interaction-capture, eval-presets-extra

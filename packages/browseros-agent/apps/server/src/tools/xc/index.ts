/**
 * XC Tool Barrel — index.ts
 *
 * Re-exports every tool, type, and utility from the XC tool modules,
 * organised by the phase they were introduced in.
 *
 * Import from this file instead of individual modules:
 *   import { get_network_requests, ref_click, diff_snapshot } from './xc'
 */

// ─── Phase 1 — Network Observation ────────────────────────────────────────────
export { get_network_requests } from './network-requests'
export { start_har_recording, stop_har_recording, get_har_summary } from './network-har'

// ─── Phase 2 — Ref-Stable Input ───────────────────────────────────────────────
export { RefStore, refStore } from './ref-store'
export type { RefEntry } from './ref-store'
export { snapshot_with_refs } from './snapshot-with-refs'
export { resolveRef } from './resolve-ref'
export { ref_click, ref_fill, ref_hover } from './ref-input'

// ─── Phase 3 — Diff & Comparison ──────────────────────────────────────────────
export { save_snapshot_baseline, diff_snapshot } from './diff-snapshot'
export { save_screenshot_baseline, diff_screenshot } from './diff-screenshot'
export { diff_url } from './diff-url'

// ─── Phase 4 — Frame Context Management ───────────────────────────────────────
export { list_frames, switch_to_frame, switch_to_main_frame, get_active_frame, FrameContext } from './frames'
export type { FrameInfo } from './frames'
export { snapshot_all_frames, snapshot_frame } from './frame-snapshot'

// ─── Phase 5 — Annotated Screenshot ───────────────────────────────────────────
export { annotated_screenshot, clear_visual_annotations } from './screenshot-annotated'

// ─── Phase 6 — JS Evaluation ──────────────────────────────────────────────────
export { evaluate_js, evaluate_js_file } from './eval'

// ─── Phase 6b — Framework Detection ──────────────────────────────────────────
export { detect_framework } from './framework-detect'

// ─── Phase 6c — React DevTools ────────────────────────────────────────────────
export { react_get_tree, react_inspect_component, react_get_renders, react_get_suspense_boundaries } from './react-devtools'

// ─── Phase 7 — Network Interception & Mocking ─────────────────────────────────
export {
  add_request_interception,
  list_interceptions,
  remove_interception,
  clear_interceptions,
  enable_network_intercept,
  disable_network_intercept,
} from './network-intercept'
export type { InterceptionRule } from './network-intercept'
export {
  mock_api_response,
  mock_network_error,
  mock_redirect,
  update_mock,
  list_mocks,
  clear_mocks,
} from './network-mock'
export {
  start_request_capture,
  stop_request_capture,
  list_captured_requests,
  replay_request,
  export_har,
  clear_captured_requests,
} from './request-replay'

// ─── Phase 8 — Service Workers ────────────────────────────────────────────────
export {
  list_service_workers,
  get_service_worker_script,
  get_service_worker_routes,
  unregister_service_worker,
  get_sw_cache_contents,
} from './service-workers'

// ─── Phase 9 — Init Scripts & Eval Presets ────────────────────────────────────
export {
  add_init_script,
  remove_init_script,
  list_init_scripts,
  clear_init_scripts,
  BUILTIN_INIT_SCRIPTS,
} from './init-scripts'
export {
  eval_preset,
  eval_extract_routes,
  eval_extract_flags,
  eval_extract_graphql,
  eval_extract_redux,
  eval_extract_i18n,
} from './eval-presets'

// ─── Phase 10 — Storage ───────────────────────────────────────────────────────
export * from './storage'
export * from './storage-snapshot'

// ─── Phase 11 — Cookies & Auth ────────────────────────────────────────────────
export {
  get_cookies,
  set_cookie,
  delete_cookie,
  clear_all_cookies,
  import_cookies_from_curl,
} from './cookies'
export { save_auth_state, load_auth_state, list_auth_states } from './auth-state'

// ─── Phase 12 — Dialogs ───────────────────────────────────────────────────────
export { get_dialog_status, dialog_accept, dialog_dismiss, configure_auto_dialog } from './dialogs'

// ─── Phase 13 — Web Workers ───────────────────────────────────────────────────
export * from './web-workers'

// ─── Phase 14 — Performance ───────────────────────────────────────────────────
export * from './profiler'
export * from './trace'
export * from './web-vitals'

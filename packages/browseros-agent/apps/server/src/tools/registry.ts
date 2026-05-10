import {
  create_bookmark,
  get_bookmarks,
  move_bookmark,
  remove_bookmark,
  search_bookmarks,
  update_bookmark,
} from './bookmarks'
import { browseros_info } from './browseros-info'
import { get_console_logs } from './console'
import { get_dom, search_dom } from './dom'
import {
  delete_history_range,
  delete_history_url,
  get_recent_history,
  search_history,
} from './history'
import {
  check,
  clear,
  click,
  click_at,
  drag,
  drag_at,
  fill,
  focus,
  handle_dialog,
  hover,
  hover_at,
  press_key,
  scroll,
  select_option,
  type_at,
  uncheck,
  upload_file,
} from './input'
import {
  close_page,
  get_active_page,
  list_pages,
  move_page,
  navigate_page,
  new_hidden_page,
  new_page,
  show_page,
  // biome-ignore lint/correctness/noUnusedImports: temporarily disabled
  wait_for,
} from './navigation'
import { suggest_app_connection, suggest_schedule } from './nudges'
import { download_file, save_pdf, save_screenshot } from './page-actions'
import {
  evaluate_script,
  get_page_content,
  get_page_links,
  take_enhanced_snapshot,
  take_screenshot,
  take_snapshot,
} from './snapshot'
import {
  close_tab_group,
  group_tabs,
  list_tab_groups,
  ungroup_tabs,
  update_tab_group,
} from './tab-groups'
import { createRegistry } from './tool-registry'
import {
  activate_window,
  close_window,
  create_hidden_window,
  create_window,
  list_windows,
} from './windows'
import {
  graph_add_api,
  graph_add_edge,
  graph_add_feature,
  graph_add_page,
  graph_add_workflow,
  graph_export,
  graph_query,
  graph_summary,
} from './xc/graph/graph-tools'
import {
  map_site_bfs_status,
  map_site_enqueue,
  map_site_start,
} from './xc/graph/map-site-skill'

// ── XC Phase 1 — Network Observation ─────────────────────────────────────────
import { get_network_requests } from './xc/network-requests'
import {
  get_har_summary,
  start_har_recording,
  stop_har_recording,
} from './xc/network-har'

// ── XC Phase 2 — Ref-Stable Input ────────────────────────────────────────────
import { snapshot_with_refs } from './xc/snapshot-with-refs'
import { ref_click, ref_fill, ref_hover } from './xc/ref-input'

// ── XC Phase 3 — Diff & Comparison ───────────────────────────────────────────
import {
  diff_snapshot,
  save_snapshot_baseline,
} from './xc/diff-snapshot'
import {
  diff_screenshot,
  save_screenshot_baseline,
} from './xc/diff-screenshot'
import { diff_url } from './xc/diff-url'

// ── XC Phase 4 — Frame Context Management ────────────────────────────────────
import {
  get_active_frame,
  list_frames,
  switch_to_frame,
  switch_to_main_frame,
} from './xc/frames'
import {
  snapshot_all_frames,
  snapshot_frame,
} from './xc/frame-snapshot'

// ── XC Phase 5 — Annotated Screenshot ────────────────────────────────────────
import {
  annotated_screenshot,
  clear_visual_annotations,
} from './xc/screenshot-annotated'

// ── XC Phase 6 — JS Evaluation ───────────────────────────────────────────────
import { evaluate_js, evaluate_js_file } from './xc/eval'

// ── XC Phase 6b — Framework Detection ────────────────────────────────────────
import { detect_framework } from './xc/framework-detect'

// ── XC Phase 6c — React DevTools ─────────────────────────────────────────────
import {
  react_get_renders,
  react_get_suspense_boundaries,
  react_get_tree,
  react_inspect_component,
} from './xc/react-devtools'

// ── XC Phase 7 — Network Interception & Mocking ──────────────────────────────
import {
  add_request_interception,
  clear_interceptions,
  disable_network_intercept,
  enable_network_intercept,
  list_interceptions,
  remove_interception,
} from './xc/network-intercept'
import {
  clear_mocks,
  list_mocks,
  mock_api_response,
  mock_network_error,
  mock_redirect,
  update_mock,
} from './xc/network-mock'
import {
  clear_captured_requests,
  export_har,
  list_captured_requests,
  replay_request,
  start_request_capture,
  stop_request_capture,
} from './xc/request-replay'

// ── XC Phase 8 — Service Workers ─────────────────────────────────────────────
import {
  get_service_worker_routes,
  get_service_worker_script,
  get_sw_cache_contents,
  list_service_workers,
  unregister_service_worker,
} from './xc/service-workers'

// ── XC Phase 9 — Init Scripts & Eval Presets ─────────────────────────────────
import {
  add_init_script,
  clear_init_scripts,
  list_init_scripts,
  remove_init_script,
} from './xc/init-scripts'
import {
  eval_extract_flags,
  eval_extract_graphql,
  eval_extract_i18n,
  eval_extract_redux,
  eval_extract_routes,
  eval_preset,
} from './xc/eval-presets'

// ── XC Phase 10 — Storage ─────────────────────────────────────────────────────
import {
  clear_local_storage,
  clear_session_storage,
  get_local_storage,
  get_session_storage,
  set_local_storage,
  set_session_storage,
} from './xc/storage'
import { full_storage_snapshot } from './xc/storage-snapshot'

// ── XC Phase 11 — Cookies & Auth ─────────────────────────────────────────────
import {
  clear_all_cookies,
  delete_cookie,
  get_cookies,
  import_cookies_from_curl,
  set_cookie,
} from './xc/cookies'
import {
  list_auth_states,
  load_auth_state,
  save_auth_state,
} from './xc/auth-state'

// ── XC Phase 12 — Dialogs ─────────────────────────────────────────────────────
import {
  configure_auto_dialog,
  dialog_accept,
  dialog_dismiss,
  get_dialog_status,
} from './xc/dialogs'

// ── XC Phase 13 — Web Workers ─────────────────────────────────────────────────
import {
  evaluate_in_worker,
  get_worker_globals,
  get_worker_source,
  list_web_workers,
} from './xc/web-workers'

// ── XC Phase 14 — Profiler ────────────────────────────────────────────────────
import {
  get_heap_snapshot,
  start_js_profiler,
  stop_js_profiler,
  summarize_profile,
} from './xc/profiler'

// ── XC Phase 14 — Trace ───────────────────────────────────────────────────────
import {
  analyze_trace,
  start_trace,
  stop_trace,
} from './xc/trace'

// ── XC Phase 14 — Web Vitals ──────────────────────────────────────────────────
import { get_web_vitals } from './xc/web-vitals'

export const registry = createRegistry([
  // Navigation (8)
  get_active_page,
  list_pages,
  navigate_page,
  new_page,
  new_hidden_page,
  show_page,
  move_page,
  close_page,
  // wait_for, // temporarily disabled

  // Observation (9)
  take_snapshot,
  take_enhanced_snapshot,
  get_page_content,
  get_page_links,
  get_dom,
  search_dom,
  take_screenshot,
  evaluate_script,
  get_console_logs,

  // Input (17)
  click,
  click_at,
  hover,
  hover_at,
  type_at,
  drag_at,
  focus,
  clear,
  fill,
  check,
  uncheck,
  upload_file,
  press_key,
  drag,
  scroll,
  handle_dialog,
  select_option,

  // Page Actions (3)
  save_pdf,
  save_screenshot,
  download_file,

  // Windows (5)
  list_windows,
  create_window,
  create_hidden_window,
  close_window,
  activate_window,

  // Bookmarks (6)
  get_bookmarks,
  create_bookmark,
  remove_bookmark,
  update_bookmark,
  move_bookmark,
  search_bookmarks,

  // History (4)
  search_history,
  get_recent_history,
  delete_history_url,
  delete_history_range,

  // Tab Groups (5)
  list_tab_groups,
  group_tabs,
  update_tab_group,
  ungroup_tabs,
  close_tab_group,

  // Info (1)
  browseros_info,

  // Nudges (2)
  suggest_schedule,
  suggest_app_connection,

  // Phase 10 — Knowledge Graph (8)
  graph_add_feature,
  graph_add_page,
  graph_add_api,
  graph_add_workflow,
  graph_add_edge,
  graph_query,
  graph_export,
  graph_summary,

  // Phase 10 — MapSite Orchestrator (3)
  map_site_start,
  map_site_bfs_status,
  map_site_enqueue,

  // XC Phase 1 — Network Observation (4)
  get_network_requests,
  start_har_recording,
  stop_har_recording,
  get_har_summary,

  // XC Phase 2 — Ref-Stable Input (4)
  snapshot_with_refs,
  ref_click,
  ref_fill,
  ref_hover,

  // XC Phase 3 — Diff & Comparison (5)
  save_snapshot_baseline,
  diff_snapshot,
  save_screenshot_baseline,
  diff_screenshot,
  diff_url,

  // XC Phase 4 — Frame Context Management (6)
  list_frames,
  switch_to_frame,
  switch_to_main_frame,
  get_active_frame,
  snapshot_all_frames,
  snapshot_frame,

  // XC Phase 5 — Annotated Screenshot (2)
  annotated_screenshot,
  clear_visual_annotations,

  // XC Phase 6 — JS Evaluation (2)
  evaluate_js,
  evaluate_js_file,

  // XC Phase 6b — Framework Detection (1)
  detect_framework,

  // XC Phase 6c — React DevTools (4)
  react_get_tree,
  react_inspect_component,
  react_get_renders,
  react_get_suspense_boundaries,

  // XC Phase 7 — Network Interception (6)
  enable_network_intercept,
  disable_network_intercept,
  add_request_interception,
  list_interceptions,
  remove_interception,
  clear_interceptions,

  // XC Phase 7 — Network Mocking (6)
  mock_api_response,
  mock_network_error,
  mock_redirect,
  update_mock,
  list_mocks,
  clear_mocks,

  // XC Phase 7 — Request Replay (6)
  start_request_capture,
  stop_request_capture,
  list_captured_requests,
  replay_request,
  export_har,
  clear_captured_requests,

  // XC Phase 8 — Service Workers (5)
  list_service_workers,
  get_service_worker_script,
  get_service_worker_routes,
  unregister_service_worker,
  get_sw_cache_contents,

  // XC Phase 9 — Init Scripts (4)
  add_init_script,
  remove_init_script,
  list_init_scripts,
  clear_init_scripts,

  // XC Phase 9 — Eval Presets (6)
  eval_preset,
  eval_extract_routes,
  eval_extract_flags,
  eval_extract_graphql,
  eval_extract_redux,
  eval_extract_i18n,

  // XC Phase 10 — Storage (6)
  get_local_storage,
  set_local_storage,
  clear_local_storage,
  get_session_storage,
  set_session_storage,
  clear_session_storage,

  // XC Phase 10 — Storage Snapshot (1)
  full_storage_snapshot,

  // XC Phase 11 — Cookies (5)
  get_cookies,
  set_cookie,
  delete_cookie,
  clear_all_cookies,
  import_cookies_from_curl,

  // XC Phase 11 — Auth State (3)
  save_auth_state,
  load_auth_state,
  list_auth_states,

  // XC Phase 12 — Dialogs (4)
  get_dialog_status,
  dialog_accept,
  dialog_dismiss,
  configure_auto_dialog,

  // XC Phase 13 — Web Workers (4)
  list_web_workers,
  evaluate_in_worker,
  get_worker_source,
  get_worker_globals,

  // XC Phase 14 — Profiler (4)
  start_js_profiler,
  stop_js_profiler,
  summarize_profile,
  get_heap_snapshot,

  // XC Phase 14 — Trace (3)
  start_trace,
  stop_trace,
  analyze_trace,

  // XC Phase 14 — Web Vitals (1)
  get_web_vitals,
])

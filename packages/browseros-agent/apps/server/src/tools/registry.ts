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
  graph_add_node,
  graph_add_edge,
  graph_summary,
  graph_query,
  graph_export,
  graph_mermaid,
  graph_list,
  graph_load,
  graph_reset,
} from './xc/graph'
import {
  graph_add_page,
  graph_add_feature,
  graph_add_api,
  graph_add_workflow,
} from './xc/graph/graph-tools'
import {
  map_site_start,
  map_site_resume,
  map_site_provide_credentials,
  map_site_bfs_status,
  map_site_enqueue,
} from './xc/graph/map-site-skill'
import {
  // Phase 1 — Network Observation
  get_network_requests,
  start_har_recording,
  stop_har_recording,
  get_har_summary,
  // Phase 2 — Ref-Stable Input
  snapshot_with_refs,
  ref_click,
  ref_fill,
  ref_hover,
  // Phase 3 — Diff & Comparison
  save_snapshot_baseline,
  diff_snapshot,
  save_screenshot_baseline,
  diff_screenshot,
  diff_url,
  // Phase 4 — Frame Context Management
  list_frames,
  switch_to_frame,
  switch_to_main_frame,
  get_active_frame,
  snapshot_all_frames,
  snapshot_frame,
  // Phase 5 — Annotated Screenshot
  annotated_screenshot,
  clear_visual_annotations,
  // Phase 6 — JS Evaluation
  evaluate_js,
  evaluate_js_file,
  // Phase 6b — Framework Detection
  detect_framework,
  // Phase 6c — React DevTools
  react_get_tree,
  react_inspect_component,
  react_get_renders,
  react_get_suspense_boundaries,
  // Phase 7 — Network Interception & Mocking
  enable_network_intercept,
  disable_network_intercept,
  add_request_interception,
  list_interceptions,
  remove_interception,
  clear_interceptions,
  mock_api_response,
  mock_network_error,
  mock_redirect,
  update_mock,
  list_mocks,
  clear_mocks,
  start_request_capture,
  stop_request_capture,
  list_captured_requests,
  replay_request,
  export_har,
  clear_captured_requests,
  // Phase 8 — Service Workers
  list_service_workers,
  get_service_worker_script,
  get_service_worker_routes,
  unregister_service_worker,
  get_sw_cache_contents,
  // Phase 9 — Init Scripts & Eval Presets
  add_init_script,
  remove_init_script,
  list_init_scripts,
  clear_init_scripts,
  eval_preset,
  eval_extract_routes,
  eval_extract_flags,
  eval_extract_graphql,
  eval_extract_redux,
  eval_extract_i18n,
  // Phase 10 — Storage
  get_local_storage,
  set_local_storage,
  clear_local_storage,
  get_session_storage,
  set_session_storage,
  clear_session_storage,
  full_storage_snapshot,
  // Phase 11 — Cookies & Auth
  get_cookies,
  set_cookie,
  delete_cookie,
  clear_all_cookies,
  import_cookies_from_curl,
  save_auth_state,
  load_auth_state,
  list_auth_states,
  // Phase 12 — Dialogs
  get_dialog_status,
  dialog_accept,
  dialog_dismiss,
  configure_auto_dialog,
  // Phase 13 — Web Workers
  list_web_workers,
  evaluate_in_worker,
  get_worker_source,
  get_worker_globals,
  // Phase 14 — Performance
  start_js_profiler,
  stop_js_profiler,
  summarize_profile,
  get_heap_snapshot,
  start_trace,
  stop_trace,
  analyze_trace,
  get_web_vitals,
} from './xc'

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

  // Graph — disk-persistent (9)
  graph_add_node,
  graph_add_edge,
  graph_summary,
  graph_query,
  graph_export,
  graph_mermaid,
  graph_list,
  graph_load,
  graph_reset,

  // Graph — in-memory node types (4)
  graph_add_page,
  graph_add_feature,
  graph_add_api,
  graph_add_workflow,

  // Site mapping — BFS crawler (5)
  map_site_start,
  map_site_resume,
  map_site_provide_credentials,
  map_site_bfs_status,
  map_site_enqueue,

  // Phase 1 — Network Observation (4)
  get_network_requests,
  start_har_recording,
  stop_har_recording,
  get_har_summary,

  // Phase 2 — Ref-Stable Input (4)
  snapshot_with_refs,
  ref_click,
  ref_fill,
  ref_hover,

  // Phase 3 — Diff & Comparison (5)
  save_snapshot_baseline,
  diff_snapshot,
  save_screenshot_baseline,
  diff_screenshot,
  diff_url,

  // Phase 4 — Frame Context Management (6)
  list_frames,
  switch_to_frame,
  switch_to_main_frame,
  get_active_frame,
  snapshot_all_frames,
  snapshot_frame,

  // Phase 5 — Annotated Screenshot (2)
  annotated_screenshot,
  clear_visual_annotations,

  // Phase 6 — JS Evaluation (2)
  evaluate_js,
  evaluate_js_file,

  // Phase 6b — Framework Detection (1)
  detect_framework,

  // Phase 6c — React DevTools (4)
  react_get_tree,
  react_inspect_component,
  react_get_renders,
  react_get_suspense_boundaries,

  // Phase 7 — Network Interception (6)
  enable_network_intercept,
  disable_network_intercept,
  add_request_interception,
  list_interceptions,
  remove_interception,
  clear_interceptions,

  // Phase 7 — Network Mocking (6)
  mock_api_response,
  mock_network_error,
  mock_redirect,
  update_mock,
  list_mocks,
  clear_mocks,

  // Phase 7 — Request Replay (6)
  start_request_capture,
  stop_request_capture,
  list_captured_requests,
  replay_request,
  export_har,
  clear_captured_requests,

  // Phase 8 — Service Workers (5)
  list_service_workers,
  get_service_worker_script,
  get_service_worker_routes,
  unregister_service_worker,
  get_sw_cache_contents,

  // Phase 9 — Init Scripts (4)
  add_init_script,
  remove_init_script,
  list_init_scripts,
  clear_init_scripts,

  // Phase 9 — Eval Presets (6)
  eval_preset,
  eval_extract_routes,
  eval_extract_flags,
  eval_extract_graphql,
  eval_extract_redux,
  eval_extract_i18n,

  // Phase 10 — Storage (7)
  get_local_storage,
  set_local_storage,
  clear_local_storage,
  get_session_storage,
  set_session_storage,
  clear_session_storage,
  full_storage_snapshot,

  // Phase 11 — Cookies (5)
  get_cookies,
  set_cookie,
  delete_cookie,
  clear_all_cookies,
  import_cookies_from_curl,

  // Phase 11 — Auth State (3)
  save_auth_state,
  load_auth_state,
  list_auth_states,

  // Phase 12 — Dialogs (4)
  get_dialog_status,
  dialog_accept,
  dialog_dismiss,
  configure_auto_dialog,

  // Phase 13 — Web Workers (4)
  list_web_workers,
  evaluate_in_worker,
  get_worker_source,
  get_worker_globals,

  // Phase 14 — Performance (8)
  start_js_profiler,
  stop_js_profiler,
  summarize_profile,
  get_heap_snapshot,
  start_trace,
  stop_trace,
  analyze_trace,
  get_web_vitals,
])

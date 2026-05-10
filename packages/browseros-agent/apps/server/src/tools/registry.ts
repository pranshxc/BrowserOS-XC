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
// XC Phase 2 — Element Ref System
import { ref_click, ref_fill, ref_hover } from './xc/ref-input'
import { snapshot_with_refs } from './xc/snapshot-with-refs'
// XC Phase 3 — Storage & Cookie Inspector
import {
  list_auth_states,
  load_auth_state,
  save_auth_state,
} from './xc/auth-state'
import {
  clear_all_cookies,
  delete_cookie,
  get_cookies,
  import_cookies_from_curl,
  set_cookie,
} from './xc/cookies'
import {
  clear_local_storage,
  clear_session_storage,
  get_local_storage,
  get_session_storage,
  set_local_storage,
  set_session_storage,
} from './xc/storage'
import { full_storage_snapshot } from './xc/storage-snapshot'
// XC Phase 4 — Dialog & Frame Handling
import {
  configure_auto_dialog,
  dialog_accept,
  dialog_dismiss,
  get_dialog_status,
} from './xc/dialogs'
import { snapshot_all_frames, snapshot_frame } from './xc/frame-snapshot'
import {
  get_active_frame,
  list_frames,
  switch_to_frame,
  switch_to_main_frame,
} from './xc/frames'
// XC Phase 5 — Visual Intelligence
import {
  annotated_screenshot,
  clear_visual_annotations,
} from './xc/screenshot-annotated'
import {
  diff_snapshot,
  save_snapshot_baseline,
} from './xc/diff-snapshot'
import {
  diff_screenshot,
  save_screenshot_baseline,
} from './xc/diff-screenshot'
import { diff_url } from './xc/diff-url'
// XC Phase 6 — React & Framework Introspection
import {
  react_get_renders,
  react_get_suspense_boundaries,
  react_get_tree,
  react_inspect_component,
} from './xc/react-devtools'
import { get_web_vitals } from './xc/web-vitals'
import { detect_framework } from './xc/framework-detect'
// XC Phase 7 — Network Interception & Mocking
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

  // XC Phase 2 — Element Ref System (4)
  snapshot_with_refs,
  ref_click,
  ref_fill,
  ref_hover,

  // XC Phase 3 — Storage & Cookie Inspector (15)
  get_cookies,
  set_cookie,
  delete_cookie,
  clear_all_cookies,
  import_cookies_from_curl,
  get_local_storage,
  set_local_storage,
  clear_local_storage,
  get_session_storage,
  set_session_storage,
  clear_session_storage,
  full_storage_snapshot,
  save_auth_state,
  load_auth_state,
  list_auth_states,

  // XC Phase 4 — Dialog & Frame Handling (10)
  get_dialog_status,
  dialog_accept,
  dialog_dismiss,
  configure_auto_dialog,
  list_frames,
  switch_to_frame,
  switch_to_main_frame,
  get_active_frame,
  snapshot_all_frames,
  snapshot_frame,

  // XC Phase 5 — Visual Intelligence (7)
  annotated_screenshot,
  clear_visual_annotations,
  save_snapshot_baseline,
  diff_snapshot,
  save_screenshot_baseline,
  diff_screenshot,
  diff_url,

  // XC Phase 6 — React & Framework Introspection (6)
  react_get_tree,
  react_inspect_component,
  react_get_renders,
  react_get_suspense_boundaries,
  get_web_vitals,
  detect_framework,

  // XC Phase 7 — Network Interception & Mocking (18)
  add_request_interception,
  list_interceptions,
  remove_interception,
  clear_interceptions,
  enable_network_intercept,
  disable_network_intercept,
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
])

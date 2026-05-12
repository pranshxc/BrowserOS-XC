# BrowserOS-XC Tool Reference

Ground-truth reference for all exported tools in `packages/browseros-agent/apps/server/src/tools/xc/`.
Derived directly from source code — every name, parameter, and return value is exact.

---

## Quick Lookup: Tool → Source File

| Tool | Source file | Phase |
|------|-------------|-------|
| `get_network_requests` | `network-requests.ts` | 1 |
| `start_har_recording`, `stop_har_recording`, `get_har_summary` | `network-har.ts` | 1 |
| `snapshot_with_refs` | `snapshot-with-refs.ts` | 2 |
| `ref_click`, `ref_fill`, `ref_hover` | `ref-input.ts` | 2 |
| `resolveRef` | `resolve-ref.ts` | 2 |
| `save_snapshot_baseline`, `diff_snapshot` | `diff-snapshot.ts` | 3 |
| `save_screenshot_baseline`, `diff_screenshot` | `diff-screenshot.ts` | 3 |
| `diff_url` | `diff-url.ts` | 3 |
| `list_frames`, `switch_to_frame`, `switch_to_main_frame`, `get_active_frame` | `frames.ts` | 4 |
| `snapshot_all_frames`, `snapshot_frame` | `frame-snapshot.ts` | 4 |
| `annotated_screenshot`, `clear_visual_annotations` | `screenshot-annotated.ts` | 5 |
| `evaluate_js`, `evaluate_js_file` | `eval.ts` | 6 |
| `detect_framework` | `framework-detect.ts` | 6b |
| `react_get_tree`, `react_inspect_component`, `react_get_renders`, `react_get_suspense_boundaries` | `react-devtools.ts` | 6c |
| `add_request_interception`, `list_interceptions`, `remove_interception`, `clear_interceptions`, `enable_network_intercept`, `disable_network_intercept` | `network-intercept.ts` | 7 |
| `mock_api_response`, `mock_network_error`, `mock_redirect`, `update_mock`, `list_mocks`, `clear_mocks` | `network-mock.ts` | 7 |
| `start_request_capture`, `stop_request_capture`, `list_captured_requests`, `replay_request`, `export_har`, `clear_captured_requests` | `request-replay.ts` | 7 |
| `list_service_workers`, `get_service_worker_script`, `get_service_worker_routes`, `unregister_service_worker`, `get_sw_cache_contents` | `service-workers.ts` | 8 |
| `add_init_script`, `remove_init_script`, `list_init_scripts`, `clear_init_scripts` | `init-scripts.ts` | 9 |
| `eval_preset`, `eval_extract_routes`, `eval_extract_flags`, `eval_extract_graphql`, `eval_extract_redux`, `eval_extract_i18n` | `eval-presets.ts` | 9 |
| `get_storage`, `set_storage`, `delete_storage`, `clear_storage` | `storage.ts` | 10 |
| `full_storage_snapshot` | `storage-snapshot.ts` | 10 |
| `get_cookies`, `set_cookie`, `delete_cookie`, `clear_all_cookies`, `import_cookies_from_curl` | `cookies.ts` | 11 |
| `save_auth_state`, `load_auth_state`, `list_auth_states` | `auth-state.ts` | 11 |
| `get_dialog_status`, `dialog_accept`, `dialog_dismiss`, `configure_auto_dialog` | `dialogs.ts` | 12 |
| `list_web_workers`, `evaluate_in_worker` | `web-workers.ts` | 13 |
| `start_profiler`, `stop_profiler` | `profiler.ts` | 14 |
| `start_trace`, `stop_trace` | `trace.ts` | 14 |
| `get_web_vitals` | `web-vitals.ts` | 14 |
| `graph_add_node` | `graph/graph-add-node.ts` | 15 |
| `graph_add_edge` | `graph/graph-add-edge.ts` | 15 |
| `graph_query` | `graph/graph-query.ts` | 15 |
| `graph_save` | `graph/graph-save.ts` | 15 |
| `graph_load` | `graph/graph-load.ts` | 15 |
| `graph_list` | `graph/graph-list.ts` | 15 |
| `graph_reset` | `graph/graph-reset.ts` | 15 |
| `graph_summary` | `graph/graph-summary.ts` | 15 |
| `graph_mermaid` | `graph/graph-mermaid.ts` | 15 |
| `graph_read` | `graph/graph-read.ts` | 15 |
| `graph_add_page`, `graph_add_feature`, `graph_add_api`, `graph_add_workflow`, `graph_add_relation`, `graph_query_legacy`, `graph_summary_legacy`, `graph_export_legacy` | `graph/graph-tools.ts` | 15-legacy |
| `map_site_start`, `map_site_bfs_status`, `map_site_enqueue` | `graph/map-site-skill.ts` | BFS |

---

## Critical Gotchas

### evaluate_js
- `page` parameter **must be a number** (integer), not a string. `{ page: 1 }` ✅ `{ page: "1" }` ❌
- Your IIFE **must have a return statement**. Without `return`, the result is `{}`.
- If you get `"No active session for page N"`, call `snapshot_with_refs({ page: N })` first to re-attach.
- Empty object `{}` returned in 1ms = the script ran but returned nothing — add `return` at the end.

### eval_extract_flags
- The tool name is **`eval_extract_flags`**, not `eval_extract_feature_flags`.
- Alternatively use `eval_preset({ page, preset: "extract_feature_flags" })`.

### graph_add_node vs graph_add_page/feature/api/workflow
- These write to **different stores**. `graph_add_node` is the Phase 11 semantic store.
- Do NOT mix: add nodes with `graph_add_node` then query with `graph_query_legacy` — they will not see each other.
- `graph_summary` reads Phase 11 store. `graph_summary_legacy` reads the legacy store.

### graph_export_legacy
- Returns **file paths only** — does not dump graph JSON into the LLM context.
- Use `graph_read(filePath)` to bring file contents into context.

### map_site_start
- Runs `eval_extract_routes`, `eval_extract_flags`, `detect_framework`, `snapshot_with_refs`, and `get_page_links` **internally** on every page.
- Do **not** repeat these calls for pages already visited by the BFS crawler.
- After BFS completes, the active tab CDP session may be detached. Call `snapshot_with_refs({ page: 1 })` before `evaluate_js`.

### add_init_script
- Only affects pages loaded **after** the script is registered.
- If the page is already loaded, call `navigate_page` to the same URL.
- Built-in names: `"navigation_logger"`, `"fetch_logger"`, `"error_capture"`, `"console_capture"`.

### configure_auto_dialog
- Must be called **before** any action that may trigger a browser alert/confirm dialog.
- Missing this causes the submit/click tool call to hang indefinitely.

---

## Node Type → Recommended meta fields

| type | Recommended meta fields |
|------|------------------------|
| `page` | `url`, `title`, `pageRole`, `framework`, `statusCode`, `hasAuth` |
| `form` | `parentPageId`, `action`, `method`, `purpose`, `submitLabel`, `fieldCount` |
| `field` | `parentFormId`, `inputType`, `name`, `label`, `required`, `options` |
| `action` | `parentPageId`, `label`, `triggerType`, `selector`, `href`, `navigatesTo` |
| `api_call` | `parentPageId`, `method`, `endpoint`, `inferredPurpose`, `payloadKeys` |
| `popup` | `parentPageId`, `role`, `triggerSelector`, `content` |
| `nav_region` | `parentPageId`, `role`, `label`, `linkCount` |
| `content_block` | `parentPageId`, `heading`, `headingLevel`, `summary` |
| `error_state` | `parentPageId`, `errorMessage`, `affectedSelector`, `triggerDescription` |
| `auth_gate` | `url`, `redirectsTo`, `authMethod` |
| `js_bundle` | `parentPageId`, `framework`, `globals`, `featureFlags`, `hasNextData` |
| `local_storage` | `parentPageId`, `storageType`, `key`, `valuePreview` |
| `schema_org` | `parentPageId`, `schemaType`, `summary` |

---

## init-scripts: What the logs contain

| builtin | window key | Contents |
|---------|-----------|----------|
| `navigation_logger` | `window.__xcNavLog` | `[{type, url, ts}]` — pushState/replaceState/popstate events |
| `fetch_logger` | `window.__xcFetchLog` | `[{url, method, status, durationMs, ts}]` — all fetch calls |
| `error_capture` | `window.__xcErrors` | `[{type, message, filename, lineno, ts}]` — uncaught errors |
| `console_capture` | `window.__xcConsoleLog` | `[{level, args[], ts}]` — all console output |

Retrieve after navigation: `evaluate_js({ page: 1, code: 'JSON.stringify(window.__xcFetchLog)' })`

---

## eval_preset keys

| preset key | Tool alias | What it finds |
|-----------|-----------|---------------|
| `extract_routes` | `eval_extract_routes` | Next.js, React Router v5/v6, Vue Router, TanStack Router, Angular, Remix, SvelteKit |
| `extract_feature_flags` | `eval_extract_flags` | LaunchDarkly, Statsig, Unleash, GrowthBook, Split.io, Optimizely, custom window.flags |
| `extract_graphql` | `eval_extract_graphql` | Apollo v2/v3 cache, queries, types; Relay; URQL; window.__schema |
| `extract_redux` | `eval_extract_redux` | Redux (window.store), Zustand, Jotai, MobX, Recoil |
| `extract_i18n` | `eval_extract_i18n` | i18next, vue-i18n, react-intl, window.translations |

---

## Graph node ID construction

All IDs are built with `slugify(text)` → lowercase, `[^a-z0-9]+` → `-`, max 96 chars.

```
graph_add_node({
  label: "https://app.example.com/dashboard",
  type: "page",
  meta: { url: "https://app.example.com/dashboard", pageRole: "dashboard" }
})
// → node_id: "page:app-example-com-dashboard"

graph_add_node({
  label: "Sign In",
  type: "action",
  meta: { parentPageId: "page:app-example-com-dashboard", triggerType: "click", selector: "#sign-in-btn" }
})
// → node_id: "action:sign-in"  (slugified from label)
```

Always check the returned `node_id` and use it exactly when adding edges.

---

*Auto-generated from source. See `packages/browseros-agent/apps/server/src/tools/xc/` for authoritative definitions.*

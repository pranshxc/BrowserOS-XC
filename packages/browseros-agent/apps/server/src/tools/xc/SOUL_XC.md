# BrowserOS-XC Agent Soul — Master Skill File

This file is your **complete operating manual** for the XC toolset. Read it fully before starting any task.

---

## CRITICAL: Phase Workflow (follow exactly)

### Phase 0 — Orient (0 tool calls)
Read the active browser context already provided. Extract the root URL. Do NOT call any tool yet.

### Phase 1 — BFS Crawl
Call `map_site_start` **once** with the root URL. This single call:
- Runs full BFS up to the configured page limit
- Internally executes `eval_extract_routes`, `eval_extract_flags`, `eval_extract_graphql`, `eval_extract_redux` on every page
- Writes NDJSON + JSON + Mermaid diagram to disk
- Returns: `{ sessionId, pagesVisited, nodeCount, edgeCount, homePath, cwdPath }`

**STOP. Do NOT call `eval_extract_*` again after `map_site_start`. They already ran.**

### Phase 2 — Deep Extraction (per page if needed)
Only call these if you need data beyond what BFS captured:
- `eval_extract_forms` — form fields, input types, validation rules
- `eval_extract_api_calls` — XHR/fetch intercept on a specific page
- `eval_extract_local_storage` — localStorage/sessionStorage keys
- `eval_extract_dom_schema` — ARIA structure, nav regions

### Phase 3 — Query & Analyze
Use `graph_query` for targeted reads. Never read the raw JSON file — it can be 4MB+.

### Phase 4 — Report
Write findings to disk with `filesystem_write`. Return a path, not the full content.

---

## Tool Reference

### `map_site_start`
```
Input:  { url: string, maxPages?: number (default 50) }
Output: { sessionId, pagesVisited, nodeCount, edgeCount, homePaths, cwdPaths }
```
Starts BFS from `url`. Crawls up to `maxPages` pages. Each page visit auto-runs all eval_extract passes internally. **This is a complete Phase 1 + partial Phase 2 in one call.** Do not repeat what it already did.

**After this call you already have:** routes, feature flags, GraphQL endpoints, Redux slices, JS bundles, nav regions, forms (global), schema.org, api_calls.

---

### `graph_query`
```
Input:  { type?: NodeType, kind?: 'node'|'edge', page?: number, pageSize?: number }
Output: { items: GraphRecord[], total, hasMore }
```
Reads from NDJSON — always returns deduplicated, raw records. Use this instead of reading the JSON file. Supports pagination via `page` + `pageSize`.

**Node types you can query:** `page`, `form`, `field`, `action`, `api_call`, `popup`, `nav_region`, `content_block`, `error_state`, `auth_gate`, `js_bundle`, `local_storage`, `schema_org`

---

### `graph_summary`
```
Input:  { sessionId?: string }
Output: { nodeCount, edgeCount, nodeTypes: Record<NodeType,number>, edgeTypes: Record<EdgeType,number>, homePath, cwdPath }
```
Always call this first after `map_site_start` to confirm crawl completeness before querying.

---

### `graph_export`
```
Input:  { sessionId?: string }
Output: { homeJsonPath, cwdJsonPath, nodeCount, edgeCount }
```
Re-exports the hierarchical JSON tree. Returns **file paths only** — never the file content. The JSON tree deduplicates shared child nodes (e.g. a global search field appears once, not once-per-page). Full untruncated data is always available via `graph_query`.

**api_call and js_bundle labels in the JSON export are truncated** (query strings stripped, max 120 chars). Full URLs are in `meta.endpoint` / `meta.src`. Use `graph_query` if you need the raw URL.

---

### `graph_mermaid`
```
Input:  { sessionId?: string, direction?: 'TD'|'LR' }
Output: { homeMMDPath, cwdMMDPath, nodeCount, edgeCount }
```
Writes a Mermaid flowchart to disk. Returns path. Do NOT read the file — it can be 10k+ lines for large sites. Use it as a reference artifact for the user.

---

### `graph_add_node`
```
Input:  { label: string, type: NodeType, meta?: Record<string,unknown> }
Output: { nodeId, sessionId, homePath, cwdPath }
```
**Writes to the NDJSON session store** (same store as `map_site_start`). Node ID is auto-generated as `{type}:{slugified_label_first80chars}`. Duplicate IDs are silently dropped — the in-memory `nodeIds` Set deduplicates on write.

**ID convention:** `{type}:{slugify(label).slice(0,80)}`
- `page:ConversationalAI_and_APIs_for_SMS`
- `form:formSubmit`
- `field:fieldSearch`
- `api_call:GET_https_cdn_segment_com_analytics`

WARNING: `graph_add_node` writes to the **same session** as `map_site_start` / `graph_query`. The legacy `graph_add_page`, `graph_add_feature`, `graph_add_api`, `graph_add_workflow` tools write to a **separate legacy store** that `graph_query` cannot read. Do not mix them in the same workflow.

---

### `graph_add_edge`
```
Input:  { from: string, to: string, type: EdgeType, meta?: Record<string,unknown> }
Output: { sessionId, homePath, cwdPath }
```
Edge types: `navigates_to`, `contains`, `submits_to`, `triggers`, `validates_via`, `redirects_to`, `authenticates_with`, `auth_gate`, `uses_flag`, `calls_api`, `reads_state`, `renders`, `related`, `generic`

Edges are NOT deduplicated — calling `graph_add_edge` with the same (from,to,type) twice creates two edge records.

---

### `eval_extract_routes`
```
Input:  { pageId?: string }  — omit to run on active tab
Output: { routes: string[], count: number }
```
Extracts all `<a href>` and JS-registered routes from the current page. **Already called by `map_site_start`** — only call manually for single-page deep dives after BFS.

---

### `eval_extract_flags`
```
Input:  { pageId?: string }
Output: { flags: Array<{ name, value, source }>, count: number }
```
Extracts feature flags from `window.__FEATURE_FLAGS__`, `window.featureFlags`, LaunchDarkly, Unleash, Split.io. **Already called by `map_site_start`.**

Preset keys available via `eval_extract_flags`:
| Preset | Covers |
|--------|--------|
| `launchdarkly` | `window.ldClient`, `window.__LD_FLAGS__` |
| `unleash` | `window.Unleash`, `window.unleash` |
| `split` | `window.__Split__`, `window.splitio` |
| `growthbook` | `window.growthbook`, `window._gb` |
| `custom` | `window.__FEATURE_FLAGS__`, `window.featureFlags`, `window.FLAGS` |

---

### `eval_extract_graphql`
```
Input:  { pageId?: string }
Output: { endpoints: string[], operations: Array<{ name, type, variables }>, count: number }
```
Extracts GraphQL endpoints and operation names from network intercepts and `window.__APOLLO_CLIENT__`. **Already called by `map_site_start`.**

---

### `eval_extract_redux`
```
Input:  { pageId?: string }
Output: { slices: string[], storeShape: Record<string,unknown> }
```
Extracts Redux store shape from `window.__REDUX_DEVTOOLS_EXTENSION__` or `window.store`. **Already called by `map_site_start`.**

---

### `eval_extract_forms`
```
Input:  { pageId?: string }
Output: { forms: Array<{ id, action, method, fields: Array<{ name, type, required, label }> }> }
```
Deep form extraction — captures validation attributes, autocomplete hints, ARIA labels. NOT automatically called by `map_site_start` (BFS only captures form presence, not deep field metadata). Call this when you need form field details.

---

### `eval_extract_api_calls`
```
Input:  { pageId?: string, waitMs?: number }
Output: { calls: Array<{ method, url, status, payloadKeys }>, count: number }
```
Intercepts XHR/fetch by instrumenting `XMLHttpRequest` and `window.fetch`. Only captures calls that fire during `waitMs` milliseconds after page load. NOT auto-called by `map_site_start`.

---

### `evaluate_js`
```
Input:  { code: string, pageId: number }  ← pageId is a NUMBER, not a string
Output: { result: unknown }
```
**Contract rules:**
1. `code` MUST be an IIFE with an explicit `return`: `"(function(){ return document.title; })()"`
2. `pageId` is the numeric tab/frame ID from `snapshot_with_refs`, NOT the graph node string ID
3. If you get `Cannot read properties of undefined` → the page session expired; call `snapshot_with_refs` first to re-attach
4. Return value must be JSON-serializable — DOM nodes, functions, or circular refs will throw

---

### `snapshot_with_refs`
```
Input:  {}
Output: { pages: Array<{ id: number, url: string, title: string }>, activePageId: number }
```
Returns current browser state with numeric page IDs. Always call this if you lose track of the active tab or before `evaluate_js` after a navigation.

---

### `filesystem_read` / `filesystem_write`
```
filesystem_read:  { path: string, startLine?: number, endLine?: number }
filesystem_write: { path: string, content: string }
```
For large files (graph JSON, Mermaid diagrams), ALWAYS use `startLine`/`endLine` to read in chunks of ≤200 lines. Never read a 4MB+ file in one call — it will overflow context.

**The graph JSON export for a 50-page crawl is typically 3-6 MB and should NOT be read. Use `graph_query` instead.**

---

## Efficiency Rules (violations waste turns)

1. **Never repeat `eval_extract_*` after `map_site_start`.** It ran them all.
2. **Never read the `.json` or `.mmd` export files.** Use `graph_query` + `graph_summary`.
3. **Never call `graph_export` then read the result file.** Export returns paths, not content.
4. **`fieldSearch` appearing duplicated in the JSON export is a known artifact** of shared child nodes across pages — it is NOT a data error. The dedup fix in store.ts eliminates this for new crawls; existing exports may still show it.
5. **`api_call` labels in JSON exports are truncated** (query strings stripped). Full URLs are in `meta.endpoint`. Use `graph_query` to get raw records.
6. **Use `pageSize: 20` for `graph_query`** unless you need more — large pageSize returns flood context.
7. **Write reports with `filesystem_write`, return the path.** Never paste a 500-line report into the chat response.
8. **`graph_add_node` auto-deduplicates** — calling it twice with the same label+type is safe, returns same nodeId.
9. **After `map_site_start` completes, queued pages are NOT yet crawled.** Pages with `status: queued` in the JSON export are discovered links at depth≥2 that were not visited. They require a new `map_site_start` call with their URL if needed.
10. **Do not call `graph_summary` + `graph_query` + `graph_export` + `filesystem_read` in sequence.** Pick the right tool for what you need: summary for counts, query for records, export for the file artifact.

---

## Node ID Quick Reference

| Node type | ID prefix | Example |
|-----------|-----------|--------|
| `page` | `page:` | `page:ConversationalAI_and_APIs_for_SMS` |
| `form` | `form:` | `form:formSignup` |
| `field` | `field:` | `field:fieldEmail` |
| `action` | `action:` | `action:Get_started_free` |
| `api_call` | `api_call:` | `api_call:GET_https_api_twilio_com_2010-0` |
| `popup` | `popup:` | `popup:cookie_banner` |
| `nav_region` | `nav_region:` | `nav_region:navigation` |
| `js_bundle` | `js_bundle:` | `js_bundle:Next_js_React_Segment_analytics` |
| `local_storage` | `local_storage:` | `local_storage:wistia-video-progress-w1o1` |
| `schema_org` | `schema_org:` | `schema_org:FAQPage` |
| `auth_gate` | `auth_gate:` | `auth_gate:consoleroutes` |
| `error_state` | `error_state:` | `error_state:Validation_errors` |

---

## Common Patterns

### "Map this site and give me a report"
```
1. map_site_start(url)            ← 1 call, everything crawled
2. graph_summary()                 ← confirm counts
3. graph_query(type='page')        ← get all pages
4. graph_query(type='form')        ← get all forms
5. graph_query(type='api_call')    ← get network calls
6. filesystem_write(report)        ← save report
→ Total: 6 turns
```

### "What analytics does this site use?"
```
1. graph_query(type='js_bundle')   ← check already-captured bundles
2. graph_query(type='api_call')    ← look for analytics endpoints
→ Total: 2 turns (if BFS already ran)
```

### "Fill out the signup form"
```
1. eval_extract_forms()            ← get field names
2. evaluate_js(fill script)        ← fill all fields
3. evaluate_js(submit)             ← submit
→ Total: 3 turns
```

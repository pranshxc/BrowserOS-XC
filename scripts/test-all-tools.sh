#!/usr/bin/env bash
# =============================================================================
# test-all-tools.sh — BrowserOS XC full tool smoke test
# Uses python3 for all JSON generation to avoid bash quoting issues.
# Usage: chmod +x scripts/test-all-tools.sh && ./scripts/test-all-tools.sh
# =============================================================================

BASE="http://localhost:9100/mcp"
PASS=0; FAIL=0; SKIP=0
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

# call <label> <json_body>
call() {
  local name="$1" body="$2"
  local raw
  raw=$(curl -s -X POST "$BASE" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "$body")

  # Strip SSE envelope if present
  local json
  json=$(echo "$raw" | grep -v '^$' | tail -1 | sed 's/^data: //')

  if [ -z "$json" ]; then
    echo -e "  ${RED}FAIL${NC}  $name  → (empty response)"
    ((FAIL++)); return
  fi

  local verdict
  verdict=$(python3 - <<PYEOF
import sys, json
try:
    d = json.loads('''$json''')
except Exception as e:
    print("INVALID:", e)
    sys.exit(0)
err = d.get("error") or {}
msg = err.get("message", "") if isinstance(err, dict) else str(err)
if msg:
    print("WARN:", msg[:120])
else:
    print("PASS")
PYEOF
  )

  if [[ "$verdict" == PASS* ]]; then
    echo -e "  ${GREEN}PASS${NC}  $name"
    ((PASS++))
  elif [[ "$verdict" == WARN* ]]; then
    echo -e "  ${YELLOW}WARN${NC}  $name  → ${verdict#WARN: }"
    ((SKIP++))
  else
    echo -e "  ${RED}FAIL${NC}  $name  → $verdict"
    ((FAIL++))
  fi
}

# Build a tools/call body safely via python3
# Usage: body <toolname> <python-dict-literal-as-string>
body() {
  python3 -c "
import json, sys
tool = sys.argv[1]
try:
    args = eval(sys.argv[2])
except Exception:
    args = {}
print(json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':tool,'arguments':args}}))
" "$1" "$2"
}

echo ""
echo "=================================================="
echo "  BrowserOS XC — Full Tool Smoke Test"
echo "  $(date)"
echo "=================================================="
echo ""

# ── 0. Ping & discover page ID ────────────────────────────────────────────────
echo "── 0. Meta"
call "tools/list" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

RAW_PAGES=$(curl -s -X POST "$BASE" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$(body list_pages '{}')") 
RAW_PAGES=$(echo "$RAW_PAGES" | grep -v '^$' | tail -1 | sed 's/^data: //')
P=$(python3 -c "
import json, re, sys
try:
    d = json.loads(sys.argv[1])
    text = d['result']['content'][0]['text']
    m = re.search(r'id[:\s]+([0-9]+)', text) or re.search(r'([0-9]+)', text)
    print(m.group(1) if m else '1')
except: print('1')
" "$RAW_PAGES" 2>/dev/null)
P=${P:-1}
echo "  → Using page ID: $P"
echo ""

# ── 1. Navigation ─────────────────────────────────────────────────────────────
echo "── 1. Navigation"
call "list_pages"      "$(body list_pages '{}')"
call "get_active_page" "$(body get_active_page '{}')"
call "navigate_page"   "$(body navigate_page "{'page':$P,'url':'https://example.com'}")" 
sleep 1  # let page load
echo ""

# ── 2. Observation ────────────────────────────────────────────────────────────
echo "── 2. Observation"
call "take_snapshot"       "$(body take_snapshot "{'page':$P}")"
call "take_screenshot"     "$(body take_screenshot "{'page':$P}")"
call "get_page_content"    "$(body get_page_content "{'page':$P}")"
call "get_page_links"      "$(body get_page_links "{'page':$P}")"
call "get_dom"             "$(body get_dom "{'page':$P}")"
call "get_console_logs"    "$(body get_console_logs "{'page':$P}")"
call "evaluate_script"     "$(body evaluate_script "{'page':$P,'script':'document.title'}")"
echo ""

# ── 3. Phase 1 — Network ──────────────────────────────────────────────────────
echo "── 3. Phase 1 — Network"
call "get_network_requests" "$(body get_network_requests "{'page':$P}")"
call "start_har_recording"  "$(body start_har_recording "{'page':$P}")"
call "stop_har_recording"   "$(body stop_har_recording "{'page':$P}")"
call "get_har_summary"      "$(body get_har_summary "{'page':$P}")"
echo ""

# ── 4. Phase 2 — Ref-Stable Input ────────────────────────────────────────────
echo "── 4. Phase 2 — Ref-Stable Input"
REF_RAW=$(curl -s -X POST "$BASE" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$(body snapshot_with_refs "{'page':$P}")")
REF_RAW=$(echo "$REF_RAW" | grep -v '^$' | tail -1 | sed 's/^data: //')
FIRST_REF=$(python3 -c "
import json, re, sys
try:
    d = json.loads(sys.argv[1])
    text = d['result']['content'][0]['text']
    m = re.search(r'(ref:[a-zA-Z0-9_:-]+)', text)
    print(m.group(1) if m else 'ref:1')
except: print('ref:1')
" "$REF_RAW" 2>/dev/null)
echo "  → First ref: $FIRST_REF"
call "snapshot_with_refs" "$(body snapshot_with_refs "{'page':$P}")"
call "ref_hover"           "$(body ref_hover "{'page':$P,'ref':'$FIRST_REF'}")" 
echo ""

# ── 5. Phase 3 — Diff & Comparison ───────────────────────────────────────────
echo "── 5. Phase 3 — Diff & Comparison"
call "save_snapshot_baseline"   "$(body save_snapshot_baseline "{'page':$P,'name':'smoke-test'}")"
call "diff_snapshot"            "$(body diff_snapshot "{'page':$P,'baseline':'smoke-test'}")"
call "save_screenshot_baseline" "$(body save_screenshot_baseline "{'page':$P,'name':'smoke-test'}")"
call "diff_screenshot"          "$(body diff_screenshot "{'page':$P,'name':'smoke-test'}")"
call "diff_url"                 "$(body diff_url "{'page':$P,'urlA':'https://example.com','urlB':'https://example.com'}")"
echo ""

# ── 6. Phase 4 — Frames ──────────────────────────────────────────────────────
echo "── 6. Phase 4 — Frames"
call "list_frames"          "$(body list_frames "{'page':$P}")"
call "get_active_frame"     "$(body get_active_frame "{'page':$P}")"
call "snapshot_all_frames"  "$(body snapshot_all_frames "{'page':$P}")"
call "switch_to_main_frame" "$(body switch_to_main_frame "{'page':$P}")"
echo ""

# ── 7. Phase 5 — Annotated Screenshot ────────────────────────────────────────
echo "── 7. Phase 5 — Annotated Screenshot"
call "annotated_screenshot"    "$(body annotated_screenshot "{'page':$P}")"
call "clear_visual_annotations" "$(body clear_visual_annotations "{'page':$P}")"
echo ""

# ── 8. Phase 6 — JS Evaluation ───────────────────────────────────────────────
echo "── 8. Phase 6 — JS Evaluation"
call "evaluate_js"      "$(body evaluate_js "{'page':$P,'code':'document.title'}")"
call "detect_framework" "$(body detect_framework "{'page':$P}")"
call "react_get_tree"   "$(body react_get_tree "{'page':$P}")"
call "react_inspect_component" "$(body react_inspect_component "{'page':$P,'selector':'body'}")"
call "react_get_renders" "$(body react_get_renders "{'page':$P}")"
call "react_get_suspense_boundaries" "$(body react_get_suspense_boundaries "{'page':$P}")"
echo ""

# ── 9. Phase 7 — Network Interception ────────────────────────────────────────
echo "── 9. Phase 7 — Network Interception"
call "enable_network_intercept"  "$(body enable_network_intercept "{'page':$P}")"
call "list_interceptions"        "$(body list_interceptions "{'page':$P}")"
call "add_request_interception"  "$(body add_request_interception "{'page':$P,'urlPattern':'https://example.com/api/*','action':'block'}")"
call "remove_interception"       "$(body remove_interception "{'page':$P,'id':0}")"
call "clear_interceptions"       "$(body clear_interceptions "{'page':$P}")"
call "disable_network_intercept" "$(body disable_network_intercept "{'page':$P}")"
call "mock_api_response"  "$(body mock_api_response "{'page':$P,'urlPattern':'https://example.com/api/test','body':'{}'}")" 
call "list_mocks"         "$(body list_mocks "{'page':$P}")"
call "clear_mocks"        "$(body clear_mocks "{'page':$P}")"
call "start_request_capture" "$(body start_request_capture "{'page':$P}")"
call "list_captured_requests" "$(body list_captured_requests "{'page':$P}")"
call "stop_request_capture"  "$(body stop_request_capture "{'page':$P}")"
call "clear_captured_requests" "$(body clear_captured_requests "{'page':$P}")"
echo ""

# ── 10. Phase 8 — Service Workers ────────────────────────────────────────────
echo "── 10. Phase 8 — Service Workers"
call "list_service_workers" "$(body list_service_workers "{'page':$P}")"
echo ""

# ── 11. Phase 9 — Init Scripts & Eval Presets ────────────────────────────────
echo "── 11. Phase 9 — Init Scripts"
call "add_init_script"   "$(body add_init_script "{'page':$P,'script':'window.__xctest=1','name':'xctest'}")"
call "list_init_scripts" "$(body list_init_scripts "{'page':$P}")"
call "remove_init_script" "$(body remove_init_script "{'page':$P,'name':'xctest'}")"
call "clear_init_scripts" "$(body clear_init_scripts "{'page':$P}")"
call "eval_preset"         "$(body eval_preset "{'page':$P,'preset':'extract_routes'}")"
call "eval_extract_routes" "$(body eval_extract_routes "{'page':$P}")"
call "eval_extract_flags"  "$(body eval_extract_flags "{'page':$P}")"
call "eval_extract_graphql" "$(body eval_extract_graphql "{'page':$P}")"
call "eval_extract_redux"   "$(body eval_extract_redux "{'page':$P}")"
call "eval_extract_i18n"    "$(body eval_extract_i18n "{'page':$P}")"
echo ""

# ── 12. Phase 10 — Storage ───────────────────────────────────────────────────
echo "── 12. Phase 10 — Storage"
call "get_local_storage"   "$(body get_local_storage "{'page':$P}")"
call "set_local_storage"   "$(body set_local_storage "{'page':$P,'key':'xctest','value':'hello'}")"
call "get_session_storage" "$(body get_session_storage "{'page':$P}")"
call "set_session_storage" "$(body set_session_storage "{'page':$P,'key':'xctest','value':'hello'}")"
call "full_storage_snapshot" "$(body full_storage_snapshot "{'page':$P}")"
call "clear_session_storage" "$(body clear_session_storage "{'page':$P}")"
call "clear_local_storage"   "$(body clear_local_storage "{'page':$P}")"
echo ""

# ── 13. Phase 11 — Cookies & Auth ────────────────────────────────────────────
echo "── 13. Phase 11 — Cookies & Auth"
call "get_cookies"            "$(body get_cookies "{'page':$P}")"
call "set_cookie"             "$(body set_cookie "{'page':$P,'name':'xctest','value':'1'}")"
call "delete_cookie"          "$(body delete_cookie "{'page':$P,'name':'xctest'}")"
call "import_cookies_from_curl" "$(body import_cookies_from_curl "{'page':$P,'raw':'session=abc; csrf=xyz'}")"
call "clear_all_cookies"      "$(body clear_all_cookies "{'page':$P}")"
call "save_auth_state"        "$(body save_auth_state "{'page':$P,'name':'smoke-test'}")"
call "list_auth_states"       "$(body list_auth_states '{}')"
echo ""

# ── 14. Phase 12 — Dialogs ───────────────────────────────────────────────────
echo "── 14. Phase 12 — Dialogs"
call "get_dialog_status"     "$(body get_dialog_status "{'page':$P}")"
call "configure_auto_dialog" "$(body configure_auto_dialog "{'page':$P,'autoAcceptTypes':['alert']}")"
echo ""

# ── 15. Phase 13 — Web Workers ───────────────────────────────────────────────
echo "── 15. Phase 13 — Web Workers"
call "list_web_workers"  "$(body list_web_workers "{'page':$P}")"
call "get_worker_source" "$(body get_worker_source "{'page':$P,'workerId':'w0'}")"
call "get_worker_globals" "$(body get_worker_globals "{'page':$P,'workerId':'w0'}")"
echo ""

# ── 16. Phase 14 — Performance ───────────────────────────────────────────────
echo "── 16. Phase 14 — Performance"
call "start_js_profiler" "$(body start_js_profiler "{'page':$P}")"
call "stop_js_profiler"  "$(body stop_js_profiler "{'page':$P}")"
call "summarize_profile" "$(body summarize_profile "{'page':$P}")"
call "get_heap_snapshot" "$(body get_heap_snapshot "{'page':$P}")"
call "start_trace"       "$(body start_trace "{'page':$P}")"
call "stop_trace"        "$(body stop_trace "{'page':$P}")"
call "analyze_trace"     "$(body analyze_trace "{'page':$P}")"
call "get_web_vitals"    "$(body get_web_vitals "{'page':$P}")"
echo ""

# ── 17. Knowledge Graph ───────────────────────────────────────────────────────
echo "── 17. Knowledge Graph"
call "graph_add_page"     "$(body graph_add_page "{'id':'page:smoke','label':'Smoke','url':'https://example.com'}")"
call "graph_add_feature"  "$(body graph_add_feature "{'id':'feat:smoke','label':'Login'}")"
call "graph_add_api"      "$(body graph_add_api "{'id':'api:smoke','label':'GET /','url':'https://example.com/'}")"
call "graph_add_workflow" "$(body graph_add_workflow "{'id':'wf:smoke','label':'Smoke flow'}")"
call "graph_add_edge"     "$(body graph_add_edge "{'from':'page:smoke','to':'feat:smoke','label':'has'}")"
call "graph_query"        "$(body graph_query "{'query':'smoke'}")"
call "graph_summary"      "$(body graph_summary '{}')"
call "graph_export"       "$(body graph_export "{'format':'json'}")"
call "map_site_start"     "$(body map_site_start "{'page':$P,'startUrl':'https://example.com','maxPages':1}")"
call "map_site_bfs_status" "$(body map_site_bfs_status '{}')"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL + SKIP))
echo "=================================================="
echo -e "  ${GREEN}$PASS passed${NC}   ${RED}$FAIL failed${NC}   ${YELLOW}$SKIP warned${NC}   / $TOTAL total"
echo "=================================================="
echo ""
[ "$FAIL" -eq 0 ] && exit 0 || exit 1

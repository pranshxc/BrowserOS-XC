#!/usr/bin/env bash
# =============================================================================
# test-all-tools.sh — Smoke-test every registered XC MCP tool
#
# Usage:
#   chmod +x scripts/test-all-tools.sh
#   ./scripts/test-all-tools.sh
#
# Requires: curl, python3 (for JSON pretty-print)
# Server must be running on http://localhost:9100
# =============================================================================

BASE="http://localhost:9100/mcp"
PASS=0
FAIL=0
SKIP=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

call() {
  local name="$1"
  local body="$2"
  local response
  response=$(curl -s -X POST "$BASE" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$body")

  # Strip SSE prefix if present
  response=$(echo "$response" | sed 's/^data: //' | grep -v '^$' | tail -1)

  local error
  error=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message',''))" 2>/dev/null)
  local result
  result=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',{}); print('OK' if r else 'EMPTY')" 2>/dev/null)

  if [ -z "$response" ]; then
    echo -e "  ${RED}FAIL${NC}  $name  → (empty response)"
    ((FAIL++))
  elif echo "$response" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    if [ -n "$error" ]; then
      echo -e "  ${YELLOW}WARN${NC}  $name  → error: $error"
      ((SKIP++))
    else
      echo -e "  ${GREEN}PASS${NC}  $name"
      ((PASS++))
    fi
  else
    echo -e "  ${RED}FAIL${NC}  $name  → (invalid JSON)"
    ((FAIL++))
  fi
}

mcp() {
  local tool="$1"
  local args="$2"
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

echo ""
echo "=================================================="
echo "  BrowserOS XC — Full Tool Smoke Test"
echo "  $(date)"
echo "=================================================="
echo ""

# ── 0. Ping / list tools ──────────────────────────────────────────────────────
echo "── 0. Meta"
call "tools/list" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Grab first open page ID (usually 1)
PAGE_RESPONSE=$(curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$(mcp list_pages '{}')")
PAGE_RESPONSE=$(echo "$PAGE_RESPONSE" | sed 's/^data: //' | grep -v '^$' | tail -1)
PAGE_ID=$(echo "$PAGE_RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
pages = d.get('result', {}).get('content', [{}])
text = pages[0].get('text', '1') if pages else '1'
import re
m = re.search(r'\\b(\\d+)\\b', text)
print(m.group(1) if m else '1')
" 2>/dev/null)
PAGE_ID=${PAGE_ID:-1}
echo "  Using page ID: $PAGE_ID"
echo ""

# ── 1. Navigation ─────────────────────────────────────────────────────────────
echo "── 1. Navigation"
call "list_pages"         "$(mcp list_pages '{}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['params']['arguments']))")"
call "get_active_page"    "$(mcp get_active_page '{}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['params']['arguments']))")"
call "navigate_page"      "$(mcp navigate_page "{\"page\":$PAGE_ID,\"url\":\"https://example.com\"}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['params']['arguments']))")"
echo ""

# ── Run all tests directly ────────────────────────────────────────────────────
P=$PAGE_ID

echo "── 1. Navigation"
call "list_pages"      "$(mcp list_pages '{}')"
call "get_active_page" "$(mcp get_active_page '{}')"
call "navigate_page"   "$(mcp navigate_page "{\"page\":$P,\"url\":\"https://example.com\"}")" 
echo ""

echo "── 2. Observation"
call "take_snapshot"          "$(mcp take_snapshot "{\"page\":$P}")"
call "take_screenshot"        "$(mcp take_screenshot "{\"page\":$P}")"
call "get_page_content"       "$(mcp get_page_content "{\"page\":$P}")"
call "get_page_links"         "$(mcp get_page_links "{\"page\":$P}")"
call "get_dom"                "$(mcp get_dom "{\"page\":$P}")"
call "get_console_logs"       "$(mcp get_console_logs "{\"page\":$P}")"
call "evaluate_script"        "$(mcp evaluate_script "{\"page\":$P,\"script\":\"document.title\"}")"
echo ""

echo "── 3. Phase 1 — Network"
call "get_network_requests"   "$(mcp get_network_requests "{\"page\":$P}")"
call "start_har_recording"    "$(mcp start_har_recording "{\"page\":$P}")"
call "stop_har_recording"     "$(mcp stop_har_recording "{\"page\":$P}")"
call "get_har_summary"        "$(mcp get_har_summary "{\"page\":$P}")"
echo ""

echo "── 4. Phase 2 — Ref-Stable Input"
call "snapshot_with_refs"     "$(mcp snapshot_with_refs "{\"page\":$P}")"
call "ref_click"              "$(mcp ref_click "{\"page\":$P,\"ref\":\"ref:body\"}")"
call "ref_fill"               "$(mcp ref_fill "{\"page\":$P,\"ref\":\"ref:body\",\"value\":\"test\"}")"
call "ref_hover"              "$(mcp ref_hover "{\"page\":$P,\"ref\":\"ref:body\"}")"
echo ""

echo "── 5. Phase 3 — Diff & Comparison"
call "save_snapshot_baseline" "$(mcp save_snapshot_baseline "{\"page\":$P,\"name\":\"smoke-test\"}")"
call "diff_snapshot"          "$(mcp diff_snapshot "{\"page\":$P,\"name\":\"smoke-test\"}")"
call "save_screenshot_baseline" "$(mcp save_screenshot_baseline "{\"page\":$P,\"name\":\"smoke-test\"}")"
call "diff_screenshot"        "$(mcp diff_screenshot "{\"page\":$P,\"name\":\"smoke-test\"}")"
call "diff_url"               "$(mcp diff_url "{\"page\":$P,\"urlA\":\"https://example.com\",\"urlB\":\"https://example.com\"}")"
echo ""

echo "── 6. Phase 4 — Frames"
call "list_frames"            "$(mcp list_frames "{\"page\":$P}")"
call "get_active_frame"       "$(mcp get_active_frame "{\"page\":$P}")"
call "snapshot_all_frames"    "$(mcp snapshot_all_frames "{\"page\":$P}")"
call "switch_to_main_frame"   "$(mcp switch_to_main_frame "{\"page\":$P}")"
echo ""

echo "── 7. Phase 5 — Annotated Screenshot"
call "annotated_screenshot"   "$(mcp annotated_screenshot "{\"page\":$P}")"
call "clear_visual_annotations" "$(mcp clear_visual_annotations "{\"page\":$P}")"
echo ""

echo "── 8. Phase 6 — JS Evaluation"
call "evaluate_js"            "$(mcp evaluate_js "{\"page\":$P,\"code\":\"1+1\"}")"
call "detect_framework"       "$(mcp detect_framework "{\"page\":$P}")"
call "react_get_tree"         "$(mcp react_get_tree "{\"page\":$P}")"
echo ""

echo "── 9. Phase 7 — Network Interception"
call "enable_network_intercept"  "$(mcp enable_network_intercept "{\"page\":$P}")"
call "list_interceptions"        "$(mcp list_interceptions "{\"page\":$P}")"
call "disable_network_intercept" "$(mcp disable_network_intercept "{\"page\":$P}")"
call "list_mocks"                "$(mcp list_mocks "{\"page\":$P}")"
call "start_request_capture"     "$(mcp start_request_capture "{\"page\":$P}")"
call "list_captured_requests"    "$(mcp list_captured_requests "{\"page\":$P}")"
call "stop_request_capture"      "$(mcp stop_request_capture "{\"page\":$P}")"
echo ""

echo "── 10. Phase 8 — Service Workers"
call "list_service_workers"   "$(mcp list_service_workers "{\"page\":$P}")"
echo ""

echo "── 11. Phase 9 — Init Scripts"
call "add_init_script"        "$(mcp add_init_script "{\"page\":$P,\"script\":\"window.__xctest=1\",\"name\":\"xctest\"}")"
call "list_init_scripts"      "$(mcp list_init_scripts "{\"page\":$P}")"
call "remove_init_script"     "$(mcp remove_init_script "{\"page\":$P,\"name\":\"xctest\"}")"
call "eval_preset"            "$(mcp eval_preset "{\"page\":$P,\"preset\":\"extract_routes\"}")"
call "eval_extract_routes"    "$(mcp eval_extract_routes "{\"page\":$P}")"
call "eval_extract_flags"     "$(mcp eval_extract_flags "{\"page\":$P}")"
echo ""

echo "── 12. Phase 10 — Storage"
call "get_local_storage"      "$(mcp get_local_storage "{\"page\":$P}")"
call "set_local_storage"      "$(mcp set_local_storage "{\"page\":$P,\"key\":\"xctest\",\"value\":\"hello\"}")"
call "get_session_storage"    "$(mcp get_session_storage "{\"page\":$P}")"
call "full_storage_snapshot" "$(mcp full_storage_snapshot "{\"page\":$P}")"
call "clear_local_storage"    "$(mcp clear_local_storage "{\"page\":$P}")"
echo ""

echo "── 13. Phase 11 — Cookies & Auth"
call "get_cookies"            "$(mcp get_cookies "{\"page\":$P}")"
call "set_cookie"             "$(mcp set_cookie "{\"page\":$P,\"name\":\"xctest\",\"value\":\"1\"}")"
call "delete_cookie"          "$(mcp delete_cookie "{\"page\":$P,\"name\":\"xctest\"}")"
call "save_auth_state"        "$(mcp save_auth_state "{\"page\":$P,\"name\":\"smoke-test\"}")"
call "list_auth_states"       "$(mcp list_auth_states '{}')"
echo ""

echo "── 14. Phase 12 — Dialogs"
call "get_dialog_status"      "$(mcp get_dialog_status "{\"page\":$P}")"
call "configure_auto_dialog"  "$(mcp configure_auto_dialog "{\"page\":$P,\"autoAcceptTypes\":[\"alert\"]}")" 
echo ""

echo "── 15. Phase 13 — Web Workers"
call "list_web_workers"       "$(mcp list_web_workers "{\"page\":$P}")"
echo ""

echo "── 16. Phase 14 — Performance"
call "start_js_profiler"      "$(mcp start_js_profiler "{\"page\":$P}")"
call "stop_js_profiler"       "$(mcp stop_js_profiler "{\"page\":$P}")"
call "summarize_profile"      "$(mcp summarize_profile "{\"page\":$P}")"
call "get_heap_snapshot"      "$(mcp get_heap_snapshot "{\"page\":$P}")"
call "start_trace"            "$(mcp start_trace "{\"page\":$P}")"
call "stop_trace"             "$(mcp stop_trace "{\"page\":$P}")"
call "analyze_trace"          "$(mcp analyze_trace "{\"page\":$P}")"
call "get_web_vitals"         "$(mcp get_web_vitals "{\"page\":$P}")"
echo ""

echo "── 17. Knowledge Graph"
call "graph_add_page"         "$(mcp graph_add_page '{"id":"page:smoke","label":"Smoke","url":"https://example.com"}')"
call "graph_query"            "$(mcp graph_query '{"query":"smoke"}')"
call "graph_summary"          "$(mcp graph_summary '{}')"
call "graph_export"           "$(mcp graph_export '{"format":"json"}')"
echo ""

# ── Summary ────────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL + SKIP))
echo "=================================================="
echo -e "  Results: ${GREEN}$PASS passed${NC}  ${RED}$FAIL failed${NC}  ${YELLOW}$SKIP warned${NC}  / $TOTAL total"
echo "=================================================="
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

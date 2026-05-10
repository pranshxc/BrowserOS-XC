#!/usr/bin/env python3
"""
BrowserOS XC — Full Tool Smoke Test
Usage: python3 scripts/test.py [--base http://localhost:9100]
"""

import json
import sys
import time
import argparse
from urllib.request import urlopen, Request
from urllib.error import URLError

parser = argparse.ArgumentParser()
parser.add_argument("--base", default="http://localhost:9100/mcp")
args = parser.parse_args()
BASE = args.base

PASS, FAIL, WARN = 0, 0, 0
RESULTS = []

GREEN  = "\033[0;32m"
RED    = "\033[0;31m"
YELLOW = "\033[1;33m"
NC     = "\033[0m"


def call(name: str, tool: str, arguments: dict) -> dict | None:
    global PASS, FAIL, WARN
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }).encode()
    req = Request(
        BASE,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=15) as resp:
            raw = resp.read().decode()
    except URLError as e:
        print(f"  {RED}FAIL{NC}  {name}  → connection error: {e}")
        FAIL += 1
        RESULTS.append(("FAIL", name, str(e)))
        return None

    # Strip SSE envelope
    lines = [l for l in raw.splitlines() if l.strip()]
    json_line = lines[-1] if lines else ""
    if json_line.startswith("data: "):
        json_line = json_line[6:]

    try:
        d = json.loads(json_line)
    except Exception as e:
        print(f"  {RED}FAIL{NC}  {name}  → invalid JSON: {e}")
        FAIL += 1
        RESULTS.append(("FAIL", name, f"invalid JSON: {e}"))
        return None

    err = d.get("error")
    if err:
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        print(f"  {YELLOW}WARN{NC}  {name}  → {msg[:100]}")
        WARN += 1
        RESULTS.append(("WARN", name, msg[:100]))
        return d

    print(f"  {GREEN}PASS{NC}  {name}")
    PASS += 1
    RESULTS.append(("PASS", name, ""))
    return d


def list_tools() -> None:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).encode()
    req = Request(BASE, data=body, headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}, method="POST")
    global PASS, FAIL
    try:
        with urlopen(req, timeout=10) as resp:
            raw = resp.read().decode()
        lines = [l for l in raw.splitlines() if l.strip()]
        json_line = lines[-1] if lines else ""
        if json_line.startswith("data: "): json_line = json_line[6:]
        d = json.loads(json_line)
        tools = d.get("result", {}).get("tools", [])
        print(f"  {GREEN}PASS{NC}  tools/list  → {len(tools)} tools registered")
        PASS += 1
    except Exception as e:
        print(f"  {RED}FAIL{NC}  tools/list  → {e}")
        FAIL += 1


def get_page_id() -> int:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_pages", "arguments": {}}}).encode()
    req = Request(BASE, data=body, headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}, method="POST")
    try:
        with urlopen(req, timeout=10) as resp:
            raw = resp.read().decode()
        lines = [l for l in raw.splitlines() if l.strip()]
        json_line = lines[-1] if lines else ""
        if json_line.startswith("data: "): json_line = json_line[6:]
        d = json.loads(json_line)
        content = d.get("result", {}).get("content", [])
        text = content[0].get("text", "") if content else ""
        import re
        m = re.search(r"(?:id|page)[:\s]+([0-9]+)", text, re.I) or re.search(r"([0-9]+)", text)
        return int(m.group(1)) if m else 1
    except Exception:
        return 1


def section(title: str) -> None:
    print(f"\n\u2500\u2500 {title}")


# ─────────────────────────────────────────────────────────────────────────────
import datetime
print("")
print("==================================================")
print("  BrowserOS XC \u2014 Full Tool Smoke Test")
print(f"  {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print("==================================================")

section("0. Meta")
list_tools()

P = get_page_id()
print(f"  \u2192 Using page ID: {P}")

section("1. Navigation")
call("list_pages",      "list_pages",      {})
call("get_active_page", "get_active_page", {})
call("navigate_page",   "navigate_page",   {"page": P, "url": "https://example.com"})
time.sleep(1.5)

section("2. Observation")
call("take_snapshot",     "take_snapshot",     {"page": P})
call("take_screenshot",   "take_screenshot",   {"page": P})
call("get_page_content",  "get_page_content",  {"page": P})
call("get_page_links",    "get_page_links",    {"page": P})
call("get_dom",           "get_dom",           {"page": P})
call("get_console_logs",  "get_console_logs",  {"page": P})
call("evaluate_script",   "evaluate_script",   {"page": P, "script": "document.title"})

section("3. Phase 1 \u2014 Network")
call("get_network_requests", "get_network_requests", {"page": P})
call("start_har_recording",  "start_har_recording",  {"page": P})
call("stop_har_recording",   "stop_har_recording",   {"page": P})
call("get_har_summary",      "get_har_summary",      {"page": P})

section("4. Phase 2 \u2014 Ref-Stable Input")
result = call("snapshot_with_refs", "snapshot_with_refs", {"page": P})
import re
first_ref = "ref:1"
try:
    text = result["result"]["content"][0]["text"]
    m = re.search(r"(ref:[a-zA-Z0-9_:\-]+)", text)
    if m: first_ref = m.group(1)
except Exception:
    pass
print(f"  \u2192 First ref: {first_ref}")
call("ref_hover", "ref_hover", {"page": P, "ref": first_ref})

section("5. Phase 3 \u2014 Diff & Comparison")
call("save_snapshot_baseline",   "save_snapshot_baseline",   {"page": P, "name": "smoke-test"})
call("diff_snapshot",            "diff_snapshot",            {"page": P, "baseline": "smoke-test"})
call("save_screenshot_baseline", "save_screenshot_baseline", {"page": P, "name": "smoke-test"})
call("diff_screenshot",          "diff_screenshot",          {"page": P, "name": "smoke-test"})
call("diff_url",                 "diff_url",                 {"page": P, "urlA": "https://example.com", "urlB": "https://example.com"})

section("6. Phase 4 \u2014 Frames")
call("list_frames",          "list_frames",          {"page": P})
call("get_active_frame",     "get_active_frame",     {"page": P})
call("snapshot_all_frames",  "snapshot_all_frames",  {"page": P})
call("switch_to_main_frame", "switch_to_main_frame", {"page": P})

section("7. Phase 5 \u2014 Annotated Screenshot")
call("annotated_screenshot",     "annotated_screenshot",     {"page": P})
call("clear_visual_annotations", "clear_visual_annotations", {"page": P})

section("8. Phase 6 \u2014 JS Evaluation")
call("evaluate_js",                   "evaluate_js",                   {"page": P, "code": "document.title"})
call("detect_framework",              "detect_framework",              {"page": P})
call("react_get_tree",                "react_get_tree",                {"page": P})
call("react_inspect_component",       "react_inspect_component",       {"page": P, "selector": "body"})
call("react_get_renders",             "react_get_renders",             {"page": P})
call("react_get_suspense_boundaries", "react_get_suspense_boundaries", {"page": P})

section("9. Phase 7 \u2014 Network Interception")
call("enable_network_intercept",  "enable_network_intercept",  {"page": P})
call("list_interceptions",        "list_interceptions",        {"page": P})
call("add_request_interception",  "add_request_interception",  {"page": P, "urlPattern": "https://example.com/api/*", "action": "block"})
call("remove_interception",       "remove_interception",       {"page": P, "id": 0})
call("clear_interceptions",       "clear_interceptions",       {"page": P})
call("disable_network_intercept", "disable_network_intercept", {"page": P})
call("mock_api_response",         "mock_api_response",         {"page": P, "urlPattern": "https://example.com/api/test", "body": "{}"})
call("list_mocks",                "list_mocks",                {"page": P})
call("clear_mocks",               "clear_mocks",               {"page": P})
call("start_request_capture",     "start_request_capture",     {"page": P})
call("list_captured_requests",    "list_captured_requests",    {"page": P})
call("stop_request_capture",      "stop_request_capture",      {"page": P})
call("clear_captured_requests",   "clear_captured_requests",   {"page": P})

section("10. Phase 8 \u2014 Service Workers")
call("list_service_workers", "list_service_workers", {"page": P})

section("11. Phase 9 \u2014 Init Scripts & Eval Presets")
call("add_init_script",     "add_init_script",     {"page": P, "script": "window.__xctest=1", "name": "xctest"})
call("list_init_scripts",   "list_init_scripts",   {"page": P})
call("remove_init_script",  "remove_init_script",  {"page": P, "name": "xctest"})
call("clear_init_scripts",  "clear_init_scripts",  {"page": P})
call("eval_preset",          "eval_preset",          {"page": P, "preset": "extract_routes"})
call("eval_extract_routes",  "eval_extract_routes",  {"page": P})
call("eval_extract_flags",   "eval_extract_flags",   {"page": P})
call("eval_extract_graphql", "eval_extract_graphql", {"page": P})
call("eval_extract_redux",   "eval_extract_redux",   {"page": P})
call("eval_extract_i18n",    "eval_extract_i18n",    {"page": P})

section("12. Phase 10 \u2014 Storage")
call("get_local_storage",    "get_local_storage",    {"page": P})
call("set_local_storage",    "set_local_storage",    {"page": P, "key": "xctest", "value": "hello"})
call("get_session_storage",  "get_session_storage",  {"page": P})
call("set_session_storage",  "set_session_storage",  {"page": P, "key": "xctest", "value": "hello"})
call("full_storage_snapshot", "full_storage_snapshot", {"page": P})
call("clear_session_storage", "clear_session_storage", {"page": P})
call("clear_local_storage",   "clear_local_storage",   {"page": P})

section("13. Phase 11 \u2014 Cookies & Auth")
call("get_cookies",              "get_cookies",              {"page": P})
call("set_cookie",               "set_cookie",               {"page": P, "name": "xctest", "value": "1"})
call("delete_cookie",            "delete_cookie",            {"page": P, "name": "xctest"})
call("import_cookies_from_curl", "import_cookies_from_curl", {"page": P, "raw": "session=abc; csrf=xyz"})
call("clear_all_cookies",        "clear_all_cookies",        {"page": P})
call("save_auth_state",          "save_auth_state",          {"page": P, "name": "smoke-test"})
call("list_auth_states",         "list_auth_states",         {})

section("14. Phase 12 \u2014 Dialogs")
call("get_dialog_status",     "get_dialog_status",     {"page": P})
call("configure_auto_dialog", "configure_auto_dialog", {"page": P, "autoAcceptTypes": ["alert"]})

section("15. Phase 13 \u2014 Web Workers")
call("list_web_workers",   "list_web_workers",   {"page": P})
call("get_worker_source",  "get_worker_source",  {"page": P, "workerId": "w0"})
call("get_worker_globals", "get_worker_globals", {"page": P, "workerId": "w0"})

section("16. Phase 14 \u2014 Performance")
call("start_js_profiler", "start_js_profiler", {"page": P})
call("stop_js_profiler",  "stop_js_profiler",  {"page": P})
call("summarize_profile", "summarize_profile", {"page": P})
call("get_heap_snapshot", "get_heap_snapshot", {"page": P})
call("start_trace",       "start_trace",       {"page": P})
call("stop_trace",        "stop_trace",        {"page": P})
call("analyze_trace",     "analyze_trace",     {"page": P})
call("get_web_vitals",    "get_web_vitals",    {"page": P})

section("17. Knowledge Graph")
call("graph_add_page",     "graph_add_page",     {"id": "page:smoke", "label": "Smoke", "url": "https://example.com"})
call("graph_add_feature",  "graph_add_feature",  {"id": "feat:smoke", "label": "Login"})
call("graph_add_api",      "graph_add_api",      {"id": "api:smoke",  "label": "GET /", "url": "https://example.com/"})
call("graph_add_workflow", "graph_add_workflow", {"id": "wf:smoke",   "label": "Smoke flow"})
call("graph_add_edge",     "graph_add_edge",     {"from": "page:smoke", "to": "feat:smoke", "label": "has"})
call("graph_query",        "graph_query",        {"query": "smoke"})
call("graph_summary",      "graph_summary",      {})
call("graph_export",       "graph_export",       {"format": "json"})
call("map_site_start",     "map_site_start",     {"page": P, "startUrl": "https://example.com", "maxPages": 1})
call("map_site_bfs_status", "map_site_bfs_status", {})

# ── Summary ───────────────────────────────────────────────────────────────────
total = PASS + FAIL + WARN
print("")
print("==================================================")
print(f"  {GREEN}{PASS} passed{NC}   {RED}{FAIL} failed{NC}   {YELLOW}{WARN} warned{NC}   / {total} total")
print("==================================================")

if WARN > 0:
    print(f"\n{YELLOW}Warned tools (tool responded but returned an error):{NC}")
    for status, name, msg in RESULTS:
        if status == "WARN":
            print(f"  {name}: {msg}")

if FAIL > 0:
    print(f"\n{RED}Failed tools (no response or invalid JSON):{NC}")
    for status, name, msg in RESULTS:
        if status == "FAIL":
            print(f"  {name}: {msg}")

print("")
sys.exit(0 if FAIL == 0 else 1)

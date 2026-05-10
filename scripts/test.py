#!/usr/bin/env python3
"""
BrowserOS XC — Full Tool Smoke Test
Usage: python3 scripts/test.py [--base http://localhost:9100/mcp] [--verbose]
Compatible with Python 3.9+
"""

from __future__ import annotations

import datetime
import http.client
import json
import re
import sys
import time
import argparse
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument("--base", default="http://localhost:9100/mcp")
parser.add_argument("--verbose", "-v", action="store_true",
                    help="Print a snippet of each tool's response as proof")
parser.add_argument("--timeout", type=int, default=30,
                    help="Default request timeout in seconds (default 30)")
args = parser.parse_args()

_parsed = urlparse(args.base)
HOST    = _parsed.hostname or "localhost"
PORT    = _parsed.port or 9100
PATH    = _parsed.path or "/mcp"
VERBOSE = args.verbose
TIMEOUT = args.timeout

# Tools that are known to be slow (heap dump, trace, screenshot, etc.)
SLOW_TOOLS = {
    "get_heap_snapshot", "start_trace", "stop_trace", "analyze_trace",
    "take_screenshot", "annotated_screenshot", "diff_url", "diff_screenshot",
    "map_site_start",
}

PASS, FAIL, WARN = 0, 0, 0
RESULTS: list = []

GREEN  = "\033[0;32m"
RED    = "\033[0;31m"
YELLOW = "\033[1;33m"
DIM    = "\033[2m"
NC     = "\033[0m"


def _extract_proof(d: dict) -> str:
    """Pull a short human-readable snippet from a successful tool response."""
    try:
        contents = d["result"]["content"]
        for item in contents:
            if item.get("type") == "text":
                text = item["text"].strip().replace("\n", " ")
                return text[:120]
            if item.get("type") == "image":
                return f"[image {item.get('mimeType','?')} {len(item.get('data',''))} b64 chars]"
        return repr(d["result"])[:120]
    except Exception:
        return repr(d)[:120]


def _post(body_dict: dict, timeout: int = TIMEOUT) -> dict:
    body = json.dumps(body_dict).encode()
    try:
        conn = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
        conn.request(
            "POST", PATH, body=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Content-Length": str(len(body)),
            },
        )
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", errors="replace")
        conn.close()
    except Exception as e:
        return {"__connection_error__": str(e)}

    # Find the last JSON object line (strips SSE "data: " prefix)
    for line in reversed(raw.splitlines()):
        line = line.strip()
        if not line:
            continue
        if line.startswith("data: "):
            line = line[6:]
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception as e:
                return {"__json_error__": str(e), "__raw__": line[:300]}

    return {"__empty__": True, "__raw__": raw[:300]}


def initialize() -> bool:
    """
    Send the MCP `initialize` handshake required by StreamableHTTPServerTransport
    (MCP SDK 1.26+). Every request is stateless/per-connection on this server,
    so we must initialize before each tools/list or tools/call.
    Returns True if the server accepted the handshake.
    """
    d = _post({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "smoke-test", "version": "1.0"},
        },
    })
    if "result" in d:
        return True
    print(f"  {RED}FATAL{NC}  initialize handshake failed: {d}")
    return False


def _rpc(body_dict: dict, timeout: int = TIMEOUT) -> dict:
    """Initialize then POST — required because the server is stateless per-request."""
    initialize()
    return _post(body_dict, timeout=timeout)


def call(name: str, tool: str, arguments: dict) -> dict:
    global PASS, FAIL, WARN
    timeout = 90 if tool in SLOW_TOOLS else TIMEOUT
    d = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": tool, "arguments": arguments}},
             timeout=timeout)

    if "__connection_error__" in d:
        msg = d["__connection_error__"]
        print(f"  {RED}FAIL{NC}  {name}  \u2192 connection: {msg}")
        FAIL += 1; RESULTS.append(("FAIL", name, msg)); return d

    if "__json_error__" in d or "__empty__" in d:
        raw = d.get("__raw__", "")
        msg = d.get("__json_error__", "empty response")
        print(f"  {RED}FAIL{NC}  {name}  \u2192 {msg} | raw: {raw[:80]}")
        FAIL += 1; RESULTS.append(("FAIL", name, msg)); return d

    err = d.get("error")
    if err:
        msg = (err.get("message", str(err)) if isinstance(err, dict) else str(err))[:120]
        print(f"  {YELLOW}WARN{NC}  {name}  \u2192 {msg}")
        WARN += 1; RESULTS.append(("WARN", name, msg)); return d

    proof = _extract_proof(d)
    if VERBOSE:
        print(f"  {GREEN}PASS{NC}  {name}")
        print(f"        {DIM}{proof}{NC}")
    else:
        print(f"  {GREEN}PASS{NC}  {name}  {DIM}({proof[:80]}){NC}")
    PASS += 1; RESULTS.append(("PASS", name, proof)); return d


def list_tools() -> None:
    global PASS, FAIL
    initialize()
    d = _post({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    if "result" in d:
        tools = d["result"].get("tools", [])
        n = len(tools)
        names = ", ".join(t["name"] for t in tools[:5])
        print(f"  {GREEN}PASS{NC}  tools/list  \u2192 {n} tools registered")
        if VERBOSE and tools:
            print(f"        {DIM}First 5: {names}...{NC}")
        PASS += 1
    else:
        print(f"  {RED}FAIL{NC}  tools/list  \u2192 {d}")
        FAIL += 1


def get_page_id() -> int:
    d = _rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": "list_pages", "arguments": {}}})
    try:
        text = d["result"]["content"][0]["text"]
        m = re.search(r"(?:id|page)[:\s]+([0-9]+)", text, re.I) or re.search(r"([0-9]+)", text)
        return int(m.group(1)) if m else 1
    except Exception:
        return 1


def section(title: str) -> None:
    print(f"\n\u2500\u2500 {title}")


print("")
print("==================================================")
print("  BrowserOS XC \u2014 Full Tool Smoke Test")
print(f"  {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print(f"  Endpoint: http://{HOST}:{PORT}{PATH}  |  timeout: {TIMEOUT}s")
print(f"  Mode: {'verbose (with proof snippets)' if VERBOSE else 'compact  (use -v for proof snippets)'}")
print("==================================================")

# Verify server is reachable and initialize handshake works
print("")
if not initialize():
    print(f"{RED}Server handshake failed — is the server running at http://{HOST}:{PORT}{PATH} ?{NC}")
    sys.exit(1)
print(f"  {GREEN}OK{NC}    MCP initialize handshake successful")

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
call("take_snapshot",    "take_snapshot",    {"page": P})
call("take_screenshot",  "take_screenshot",  {"page": P})
call("get_page_content", "get_page_content", {"page": P})
call("get_page_links",   "get_page_links",   {"page": P})
call("get_dom",          "get_dom",          {"page": P})
call("get_console_logs", "get_console_logs", {"page": P})
call("evaluate_script",  "evaluate_script",  {"page": P, "script": "document.title"})

section("3. Phase 1 \u2014 Network")
call("get_network_requests", "get_network_requests", {"page": P})
call("start_har_recording",  "start_har_recording",  {"page": P})
call("stop_har_recording",   "stop_har_recording",   {"page": P})
call("get_har_summary",      "get_har_summary",      {"page": P})

section("4. Phase 2 \u2014 Ref-Stable Input")
result = call("snapshot_with_refs", "snapshot_with_refs", {"page": P})
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
call("add_init_script",      "add_init_script",      {"page": P, "script": "window.__xctest=1", "name": "xctest"})
call("list_init_scripts",    "list_init_scripts",    {"page": P})
call("remove_init_script",   "remove_init_script",   {"page": P, "name": "xctest"})
call("clear_init_scripts",   "clear_init_scripts",   {"page": P})
call("eval_preset",          "eval_preset",          {"page": P, "preset": "extract_routes"})
call("eval_extract_routes",  "eval_extract_routes",  {"page": P})
call("eval_extract_flags",   "eval_extract_flags",   {"page": P})
call("eval_extract_graphql", "eval_extract_graphql", {"page": P})
call("eval_extract_redux",   "eval_extract_redux",   {"page": P})
call("eval_extract_i18n",    "eval_extract_i18n",    {"page": P})

section("12. Phase 10 \u2014 Storage")
call("get_local_storage",     "get_local_storage",     {"page": P})
call("set_local_storage",     "set_local_storage",     {"page": P, "key": "xctest", "value": "hello"})
call("get_session_storage",   "get_session_storage",   {"page": P})
call("set_session_storage",   "set_session_storage",   {"page": P, "key": "xctest", "value": "hello"})
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
call("get_heap_snapshot", "get_heap_snapshot", {"page": P})  # slow: 90s timeout
call("start_trace",       "start_trace",       {"page": P})
call("stop_trace",        "stop_trace",        {"page": P})
call("analyze_trace",     "analyze_trace",     {"page": P})
call("get_web_vitals",    "get_web_vitals",    {"page": P})

section("17. Knowledge Graph")
call("graph_add_page",      "graph_add_page",      {"id": "page:smoke", "label": "Smoke", "url": "https://example.com"})
call("graph_add_feature",   "graph_add_feature",   {"id": "feat:smoke", "label": "Login"})
call("graph_add_api",       "graph_add_api",       {"id": "api:smoke",  "label": "GET /", "url": "https://example.com/"})
call("graph_add_workflow",  "graph_add_workflow",  {"id": "wf:smoke",   "label": "Smoke flow"})
call("graph_add_edge",      "graph_add_edge",      {"from": "page:smoke", "to": "feat:smoke", "label": "has"})
call("graph_query",         "graph_query",         {"query": "smoke"})
call("graph_summary",       "graph_summary",       {})
call("graph_export",        "graph_export",        {"format": "json"})
call("map_site_start",      "map_site_start",      {"page": P, "startUrl": "https://example.com", "maxPages": 1})
call("map_site_bfs_status", "map_site_bfs_status", {})

# ── Summary ─────────────────────────────────────────────────────────────────
total = PASS + FAIL + WARN
print("")
print("==================================================")
print(f"  {GREEN}{PASS} passed{NC}   {RED}{FAIL} failed{NC}   {YELLOW}{WARN} warned{NC}   / {total} total")
print("==================================================")

if WARN > 0:
    print(f"\n{YELLOW}Warned tools:{NC}")
    for status, name, msg in RESULTS:
        if status == "WARN":
            print(f"  {name}: {msg}")

if FAIL > 0:
    print(f"\n{RED}Failed tools:{NC}")
    for status, name, msg in RESULTS:
        if status == "FAIL":
            print(f"  {name}: {msg}")

print("")
sys.exit(0 if FAIL == 0 else 1)

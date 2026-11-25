# AIyako — Delivery Plan (Target Architecture)

## Goal
Migrate agent brain from on-device Node/QVAC to Python + Deep Agents (LangGraph) served by a model server, keep the Node chat-first UI, add fallbacks, package as APK.

## Phases

### Phase 1 — Model Server (stand up) — IMPLEMENTED
- Load Qwen3.5-9B, expose OpenAI-compatible endpoint (QVAC/vLLM/llama.cpp).
- Implemented in `services/model-server/` using QVAC. Defaults to `models/Qwen3.5-4B-Q4_K_M.gguf` with Qwen3-0.6B fallback; set `MODEL_PATH`/`MODEL_NAME` to use 9B on a larger machine.
- Env: `MODEL_BASE_URL`, `MODEL_NAME`, `FALLBACK_MODEL=qwen3-0.6b-local`.

### Phase 2 — Deep Agents Service (Python) — IMPLEMENTED
- Scaffold: `services/deep-agents/` (FastAPI). See `app/main.py`.
- Implement chat endpoint with tool loop, checkpointers, streaming.
- Port tools: save_note, search_notes, create_task, list_tasks, mark_task_done, web_search.
- Max agent steps hard limit (8–10). Retry once on transient failure.
- Implemented: `app/main.py` runs a 10-step tool loop with one retry, primary→fallback switching, and duplicated-call protection. All six tools are ported in `tools/local_tools.py`.

### Phase 3 — Connect Node UI — IMPLEMENTED
- Node server (`src/ui/server.js`) gains `KIOO_AGENT_URL` env; when set, proxy chat to Python service instead of local loop.
- Keep local QVAC path as fallback (offline/private mode).
- Add clear offline/error states in UI.
- Implemented: proxied chat persists messages locally and falls back to the QVAC loop if the remote service fails. UI status shows remote mode, loading, or offline.

### Phase 4 — Sessions + Goals — PENDING
- Python checkpointer persists sessions; reuse Node SQLite goals/artifacts via API or migrate.
- Current state: Node SQLite persists sessions/goals; Python service reuses the same DB file and has an optional LangGraph checkpointer.

### Phase 5 — APK Packaging — PENDING
- Wrap web UI (Capacitor) once backend stable.

## Fallbacks (design early)
1. Connectivity: offline state, exponential backoff retry, local message queue.
2. Model: primary → fallback model → graceful message.
3. Agent/tool: tool timeout → continue partial; max steps → stop; surface status.
4. Device/APK: min Android version, lighter UI mode, recovery screen.
5. Privacy: keep on-device path optional.
6. Capacity: queue/rate-limit, auto-downgrade.
## Minimal early additions

- Request timeout + 1 retry
- Max agent steps hard limit (already 10 in agent.js)
- Clear offline/error states
- Local message queue on client

## Expanded delivery plan (A–E)

### Phase A — Foundation — IMPLEMENTED
- A1 model: Qwen3.5-4B Q4_K_M installed and configured as primary; Qwen3-0.6B fallback. 9B deferred until more free RAM is available.
- A2 `create_react_agent` + checkpointer: `services/deep-agents/app/agent_graph.py` with SQLite/Memory saver and fallback loop.
- A3 formal tool schemas: `services/deep-agents/tools/registry.py` with family and risk metadata.
- A4 status events: `/chat` returns tool/status events; Node proxy forwards them to the UI.
- A5 streaming: `/chat/stream` forwards LangGraph token/tool events (or chunks final reply as fallback).

### Phase B — Tool expansion — IMPLEMENTED
- Research: `browse_page`, `summarize_url`; improved `web_search`.
- Work: `create_goal`, `list_goals`, `update_goal`, `save_artifact`, `list_artifacts`.
- System: `set_reminder`, `list_reminders`, `get_preferences`, `set_preference`.
- Tool registry and user-visible tool activity in the UI are in place.

### Phase C — MCP Gateway — IMPLEMENTED
- `services/mcp-gateway/` registers connectors, aggregates tools, checks scopes, stores obfuscated tokens, and writes an audit log.
- Deep Agents discovers MCP tools via `MCP_GATEWAY_URL` and invokes them through the gateway.

### Phase D — First connectors — IMPLEMENTED (starter data)
- Email, Calendar, WhatsApp, and Meetings connectors live in `services/mcp-gateway/connectors.py`.
- Read-heavy tools use in-memory demo data; write tools are present but require real provider adapters and credentials.

### Phase E — Sandbox + safety — IMPLEMENTED
- `services/deep-agents/sandbox.py` provides isolated command/file tools (Docker mode optional).
- High-risk tools return `waiting_approval`; Node proxy persists approvals and resumes after user approval.
- Rate limits are enforced in the tool registry; audit log records every gateway call.

See `docs/MCP_CONNECTORS.md` for the connector interface, auth, and approval rules.

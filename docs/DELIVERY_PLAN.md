# Kioo AI — Delivery Plan (Target Architecture)

## Goal
Migrate agent brain from on-device Node/QVAC to Python + Deep Agents (LangGraph) served by a model server, keep the Node chat-first UI, add fallbacks, package as APK.

## Phases

### Phase 1 — Model Server (stand up)
- Load Qwen3.5-9B, expose OpenAI-compatible endpoint (QVAC/vLLM/llama.cpp).
- Env: `MODEL_BASE_URL`, `MODEL_NAME`, `FALLBACK_MODEL=Qwen3.5-4B`.

### Phase 2 — Deep Agents Service (Python)
- Scaffold: `services/deep-agents/` (FastAPI). See `app/main.py`.
- Implement chat endpoint with tool loop, checkpointers, streaming.
- Port tools: save_note, search_notes, create_task, list_tasks, mark_task_done, web_search.
- Max agent steps hard limit (8–10). Retry once on transient failure.

### Phase 3 — Connect Node UI
- Node server (`src/ui/server.js`) gains `KIOO_AGENT_URL` env; when set, proxy chat to Python service instead of local loop.
- Keep local QVAC path as fallback (offline/private mode).
- Add clear offline/error states in UI.

### Phase 4 — Sessions + Goals
- Python checkpointer persists sessions; reuse Node SQLite goals/artifacts via API or migrate.

### Phase 5 — APK Packaging
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

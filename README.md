# AIyako

A local AI assistant that runs entirely offline on your device. Built with the [QVAC SDK](https://docs.qvac.tether.io) for local LLM inference.

## Mission

AIyako gives you a private, offline AI assistant that can answer questions, manage notes and tasks, and work without an internet connection. No cloud, no tracking — your data stays on your device.

## Features

- **Offline by default** — Local inference and notes/tasks need no internet; optional `web_search` uses a local SearXNG instance
- **Local inference** — Runs on-device via QVAC SDK (llama.cpp)
- **Note management** — Save and search notes with natural language
- **Task tracking** — Create, list, and complete tasks
- **Self-hosted web search** — Query current information through a local SearXNG instance
- **Persistent sessions** — Conversation history survives restarts, scoped per session
- **Goals & artifacts** — Task-driven goals are extracted from tool results
- **Approval gate** — Require explicit approval before sensitive tools run
- **Hybrid routing** — Escalates complex and web-search turns to an optional larger local model
- **Remote agent stack** — Optional OpenAI-compatible model server + Python Deep Agents service, with local fallback
- **MCP Gateway** — Register connectors, expose their tools, enforce scopes, and audit every call
- **Connector starters** — Email, Calendar, WhatsApp, and Meetings tool families behind one interface
- **Sandbox + approvals** — Isolated command/file tools; high-risk actions require user confirmation
- **Web UI** — Responsive browser interface for laptop browsers
- **CLI mode** — Direct terminal access to the agent
- **Type-safe tools** — Zod schema validation on all tool inputs

## Prerequisites

- **Node.js** >= 22.21 (tested with v22.23.4 via nvm)
- **npm** >= 10.9
- **Ubuntu 22+** (or compatible Linux distro)
- **14 GiB RAM** (6+ GiB available for model + OS)
- **GPU recommended** for faster inference (tested with 1 GPU device)
- **5+ GB free disk space** for model weights

## Setup

### 1. Install Node.js 22

```bash
# Using nvm
nvm install 22
nvm use 22

# Verify
node --version  # v22.x.x
```

### 2. Install dependencies

```bash
npm install @qvac/sdk zod
```

### 3. Model weights

The primary model is already installed at
`models/Qwen3.5-4B-Q4_K_M.gguf` (2.74 GB). It loads through QVAC with tool
calling enabled, and thinking tags are stripped before replies reach the UI.
The smaller `models/qwen3-0.6b-q4_0.gguf` remains as the automatic fallback.

To re-download the primary model:

```bash
mkdir -p models
curl -L --fail --retry 5 -C - -o models/Qwen3.5-4B-Q4_K_M.gguf \
  https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf
```

The 9B Q4 build is ~5.7 GB and needs more free RAM than this machine currently
has, so 4B is the configured default. Set `MODEL_PATH`/`MODEL_NAME` to use 9B
on a larger machine.

### 4. Create config

```bash
cp .env.example .env.local
```

The `qvac.config.json` is already configured for offline operation:

```json
{
  "loggerLevel": "info",
  "httpDownloadConcurrency": 3
}
```

### Optional: self-hosted web search

The `web_search` tool uses a local [SearXNG](https://docs.searxng.org/) instance.
No API keys or cloud search services are required.

```bash
docker compose up -d searxng
```

This starts SearXNG at `http://localhost:8080` with JSON output enabled via
`searxng/settings.yml`. Point the agent at a different instance with
`SEARXNG_URL`. If SearXNG is not running, `web_search` returns an error but the
rest of AIyako continues to work offline.

### Optional: remote agent stack (phases 1–3)

Start the OpenAI-compatible model server, the Python Deep Agents service, and the Node UI together:

```bash
MODEL_DIR=/path/to/gguf-models docker compose up -d
```

The model server defaults to the bundled Qwen3.5-4B GGUF when `MODEL_DIR` is
mounted, with Qwen3-0.6B as fallback. To use `Qwen3.5-9B` instead, mount its
GGUF and set `MODEL_PATH`, `MODEL_NAME`, and `FALLBACK_MODEL_PATH`.

When `KIOO_AGENT_URL` is set, `src/ui/server.js` proxies chat to the Python
service, which runs a 10-step tool loop with one retry and primary→fallback
model switching. If that service is unavailable, the Node server falls back to
the local QVAC loop. Leave `KIOO_AGENT_URL` unset for fully local/offline mode.

## Usage

### CLI Mode

```bash
QVAC_CONFIG_PATH=./qvac.config.json node src/agent.js "Save a note that my budget is KES 4,000"
```

### Server Mode (Web UI)

```bash
QVAC_CONFIG_PATH=./qvac.config.json npm run server
```

Then open http://localhost:3000 in your browser.

The web UI keeps the active session in `localStorage` and sends each turn to
`POST /sessions/:id/chat`. Sessions, messages, goals, and artifacts are persisted
in SQLite, so reloading the page restores the conversation. The header switches
between sessions or starts a new chat, live status streams via SSE, goals can be
added and edited inline, and the Library separates notes from artifacts.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `QVAC_CONFIG_PATH` | — | Path to QVAC config (`./qvac.config.json`) |
| `QVAC_MODEL_PATH` | `models/Qwen3.5-4B-Q4_K_M.gguf` | Local GGUF for the primary model |
| `KIOO_ESCALATION_MODEL_PATH` | Llama-3.2-1B | Optional larger local GGUF for complex turns |
| `MODEL_BASE_URL` | `http://localhost:8000/v1` | Model server endpoint used by Deep Agents |
| `MODEL_NAME` | `qwen3.5-4b-local` | Model name served by the model server |
| `MODEL_PATH` | `models/Qwen3.5-4B-Q4_K_M.gguf` | GGUF loaded by the model server |
| `FALLBACK_MODEL_PATH` | `models/qwen3-0.6b-q4_0.gguf` | GGUF used when the primary fails |
| `FALLBACK_MODEL` | `qwen3-0.6b-local` | Name served for the fallback model |
| `KIOO_AGENT_URL` | unset | Python Deep Agents base URL; enables remote mode |
| `KIOO_AGENT_TIMEOUT_MS` | `300000` | Timeout for proxied chat requests |
| `MODEL_TIMEOUT_SECONDS` | `300` | Timeout for local model inference calls in Deep Agents |
| `KIOO_MAX_STEPS` | `10` | Hard step limit in the Python tool loop |
| `MCP_GATEWAY_URL` | unset | MCP Gateway base URL; tools are discovered from it |
| `MCP_GATEWAY_SECRET` | `kioo-dev-secret` | Token obfuscation secret for connector credentials |
| `KIOO_USE_LANGGRAPH` | `1` | Use LangGraph when installed; `0` forces the fallback loop |
| `KIOO_SANDBOX_DOCKER` | unset | Set to `1` to run sandbox commands in Docker |
| `SEARXNG_URL` | `http://localhost:8080` | Local SearXNG base URL for `web_search` |
| `KIOO_APPROVAL_TOOLS` | unset | Comma-separated tools requiring approval |
| `KIOO_SKIP_MODEL` | unset | Set to `1` to run the server without loading a model |
| `KIOO_PROMPT_PATH` | bundled prompt | Optional override for the shared system prompt file |
| `KIOO_AUTH_ENABLED` | `1` | Gate the UI and agent APIs behind sign-in |
| `KIOO_ACCESS_TTL_MS` | `900000` | Access token lifetime |
| `KIOO_REFRESH_TTL_MS` | `2592000000` | Refresh token lifetime |
| `KIOO_RESET_TTL_MS` | `3600000` | Password reset token lifetime |
| `KIOO_DEV_RESET_TOKENS` | `0` | Return reset links for local development |
| `KIOO_COOKIE_SECURE` | `0` | Add `Secure` to auth cookies when serving HTTPS |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Enable Google Sign-In when both are set |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/auth/google/callback` | OAuth callback URL |
| `PORT` / `HOST` | `3000` / `localhost` | HTTP server binding |

### Runtime API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server + model status |
| `GET` | `/auth/config` | Auth providers and gate status |
| `POST` | `/auth/register` | Create an account and session |
| `POST` | `/auth/login` | Sign in with email/password |
| `POST` | `/auth/refresh` | Rotate access and refresh tokens |
| `POST` | `/auth/logout` | Revoke the current session |
| `POST` | `/auth/forgot`, `/auth/reset` | Password recovery |
| `GET` | `/auth/google`, `/auth/google/callback` | Google Sign-In flow |
| `GET` / `PUT` | `/profile` | View or update account `user.md` |
| `DELETE` | `/auth/account` | Delete account and user data |
| `POST` | `/sessions` | Create a session |
| `GET` | `/sessions` | List sessions |
| `GET` | `/sessions/:id` | Session with messages, goals, artifacts |
| `PATCH` | `/sessions/:id` | Rename a session |
| `DELETE` | `/sessions/:id` | Delete a session and its data |
| `POST` | `/sessions/:id/chat` | Run a turn in a session |
| `GET` | `/sessions/:id/events` | Server-sent status events for a session |
| `GET`/`POST` | `/sessions/:id/goals` | List or create goals |
| `PATCH` | `/goals/:id` | Update a goal |
| `GET` | `/sessions/:id/approvals` | List approvals for a session |
| `POST` | `/sessions/:id/approvals/:approvalId` | Approve or reject a pending tool call |
| `GET` | `/notes`, `/tasks` | List notes and tasks |
| `GET` | `/mcp/tools`, `/mcp/audit`, `/mcp/connectors` | MCP Gateway views proxied through the UI server |
| `POST` | `/chat` | Legacy single-turn endpoint (auto-creates a session) |

### Running tests

```bash
npm test
```

## Architecture

- **QVAC SDK** — Local LLM inference engine (llama.cpp backend)
- **Shared prompt** (`prompts/kioo-system.txt`) — One system prompt for the model server, local agent, and Deep Agents; live tool lists are appended at runtime
- **Model server** (`services/model-server/`) — OpenAI-compatible `/v1/chat/completions` over QVAC, with optional fallback model
- **Deep Agents** (`services/deep-agents/`) — LangGraph agent with checkpointer, fallback loop, 10-step cap, tool families
- **MCP Gateway** (`services/mcp-gateway/`) — Connector registry, auth/scope checks, audit log, dynamic tools
- **Auth + Profile** (`src/auth/`) — Email/password and Google sessions, refresh tokens, account `user.md`
- **Sandbox** (`services/deep-agents/sandbox.py`) — Isolated command and file tools
- **SQLite** (`node:sqlite`, built into Node 22) — Local persistence for notes, tasks, sessions, messages, goals, and artifacts
- **Runtime Layer** — Owns session lifecycle, message history, status events, goals, approvals, and hybrid routing; `runTurn()` wraps the QVAC tool loop
- **Agent Tools** — `save_note`, `search_notes`, `create_task`, `list_tasks`, `mark_task_done`, `web_search`
- **Web Server** — Built-in HTTP server with static file serving + API endpoints
- **Offline-first** — All data and compute stays on-device

### Project Structure

| Path | Description |
|------|-------------|
| `prompts/kioo-system.txt` | Shared system prompt used by every runtime path |
| `src/systemPrompt.js` | Loads the shared prompt and appends the live tool list |
| `src/agent.js` | Agent orchestration with tool calling loop |
| `src/tools/` | Tool implementations with Zod validation |
| `src/tools/index.js` | Tool registry and dispatcher |
| `src/runtime/` | Session manager, status events, goals, approvals, router, and multi-turn runner |
| `src/db/database.js` | SQLite database layer (singleton pattern) |
| `src/auth/` | Auth sessions, password hashing, profile storage, account deletion |
| `src/ui/server.js` | HTTP server for web interface and auth/profile APIs |
| `src/ui/public/` | Static frontend assets (HTML, CSS, JS) |
| `src/types/index.ts` | TypeScript type definitions |
| `services/model-server/` | OpenAI-compatible local model server |
| `services/deep-agents/` | Python FastAPI agent service with tool registry, sandbox, streaming |
| `services/mcp-gateway/` | MCP Gateway with connectors, auth hooks, and audit log |
| `docs/AUTH.md` | Auth, session, and `user.md` product rules |
| `docs/MCP_CONNECTORS.md` | Connector interface, auth, and approval design |
| `docker-compose.yml` / `searxng/` | Model server, Deep Agents, MCP Gateway, SearXNG, and UI containers |
| `tests/` | Test suite (109 tests) |

## Available Tools

| Tool | Input | Description |
|------|-------|-------------|
| `save_note` | `{ text: string }` | Save a note for later recall |
| `search_notes` | `{ query: string, limit?: number }` | Search notes by content |
| `create_task` | `{ title: string, due_date?: string }` | Create a task ("tomorrow" parsed automatically) |
| `list_tasks` | `{ completed?: boolean }` | List tasks, optional completion filter |
| `mark_task_done` | `{ id: number }` | Mark a task as completed |
| `web_search` | `{ query: string, num_results?: number }` | Search the web via local SearXNG (cached 5 min) |

## Security

- Model path must be a **local file path** — cloud URLs are rejected at startup
- All SQL queries use **parameterized statements** — no string interpolation
- **No dangerous tools** — `shell_exec`, `sql_exec`, `file_write`, `file_read` are not available
- Tool registry enforces a **whitelist** — unknown tools are rejected
- **No cloud fallback** — inference runs entirely on-device via QVAC

## Test Results

```
# tests 100
# pass 100
# fail 0
```

Test coverage includes:
- Tool input validation (valid/invalid inputs)
- Tool execution success/failure paths
- Unknown tool rejection
- SQL injection resistance
- Data persistence across process restarts
- Task completion and filtering

## Model Information

- **Model**: Qwen3-600M Q4_0
- **Size**: 365 MB
- **SHA256**: `33bcc57074ec7b6eada5a90651ee546ec0c2b271002c22baf9f1b2dd1e8f75cb`
- **Quantization**: Q4_0 (4-bit)
- **License**: Check upstream model license before distribution

### Measured Performance

| Metric | Value |
|--------|-------|
| Model load time | ~5 seconds |
| First inference time | ~11 seconds |
| Subsequent inference | ~5-15 seconds |
| VRAM usage | ~29 GPU layers |

## Known Limitations

- **Multi-step planning**: Qwen3-600M may not reliably chain multiple tool calls in a single turn (e.g., "list tasks and mark #1 done"). Workarounds: use explicit tool calls in the UI.
- **Tool use reliability**: ~80% of requests result in correct tool invocation. When tools fail, the agent falls back to a generic response.
- **Duplicated tool calls**: The small model occasionally repeats an identical tool call. The agent short-circuits repeats to prevent duplicate side effects, but you may see a "already completed" reply.
- **Web search**: `web_search` requires a reachable SearXNG instance and outbound network access from that instance. Results are cached for 5 minutes.
- **GPU only**: Tested on GPU; CPU-only fallback not verified.

## License

Apache-2.0

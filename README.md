# Kioo AI — AI Yako

A local AI assistant that runs entirely offline on your device. Built with the [QVAC SDK](https://docs.qvac.tether.io) for local LLM inference.

## Mission

Kioo AI gives you a private, offline AI assistant that can answer questions, manage notes and tasks, and work without an internet connection. No cloud, no tracking — your data stays on your device.

## Features

- **Fully offline** — No internet required after initial setup
- **Local inference** — Runs on-device via QVAC SDK (llama.cpp)
- **Note management** — Save and search notes with natural language
- **Task tracking** — Create, list, and complete tasks
- **Persistent sessions** — Conversation history survives restarts, scoped per session
- **Goals & artifacts** — Task-driven goals are extracted from tool results
- **Approval gate** — Require explicit approval before sensitive tools run
- **Hybrid routing** — Escalates complex turns to an optional larger local model
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

### 3. Download model weights

Download the Qwen3-0.6B Q4_0 model (365 MB):

```bash
mkdir -p models
# Model file: qwen3-0.6b-q4_0.gguf
# SHA256: 33bcc57074ec7b6eada5a90651ee546ec0c2b271002c22baf9f1b2dd1e8f75cb
```

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

The web UI keeps a session ID in `localStorage` and sends each turn to
`POST /sessions/:id/chat`. Sessions, messages, goals, and artifacts are persisted
in SQLite, so reloading the page restores the conversation.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `QVAC_CONFIG_PATH` | — | Path to QVAC config (`./qvac.config.json`) |
| `QVAC_MODEL_PATH` | Qwen3-600M | Local GGUF for the primary model |
| `KIOO_ESCALATION_MODEL_PATH` | unset | Optional larger local GGUF for complex turns |
| `KIOO_APPROVAL_TOOLS` | unset | Comma-separated tools requiring approval |
| `KIOO_SKIP_MODEL` | unset | Set to `1` to run the server without loading a model |
| `PORT` / `HOST` | `3000` / `localhost` | HTTP server binding |

### Runtime API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server + model status |
| `POST` | `/sessions` | Create a session |
| `GET` | `/sessions` | List sessions |
| `GET` | `/sessions/:id` | Session with messages, goals, artifacts |
| `DELETE` | `/sessions/:id` | Delete a session and its data |
| `POST` | `/sessions/:id/chat` | Run a turn in a session |
| `GET`/`POST` | `/sessions/:id/goals` | List or create goals |
| `PATCH` | `/goals/:id` | Update a goal |
| `GET` | `/sessions/:id/approvals` | List approvals for a session |
| `POST` | `/sessions/:id/approvals/:approvalId` | Approve or reject a pending tool call |
| `GET` | `/notes`, `/tasks` | List notes and tasks |
| `POST` | `/chat` | Legacy single-turn endpoint (auto-creates a session) |

### Running tests

```bash
npm test
```

## Architecture

- **QVAC SDK** — Local LLM inference engine (llama.cpp backend)
- **SQLite** (`node:sqlite`, built into Node 22) — Local persistence for notes, tasks, sessions, messages, goals, and artifacts
- **Runtime Layer** — Owns session lifecycle, message history, status events, goals, approvals, and hybrid routing; `runTurn()` wraps the QVAC tool loop
- **Agent Tools** — `save_note`, `search_notes`, `create_task`, `list_tasks`, `mark_task_done`
- **Web Server** — Built-in HTTP server with static file serving + API endpoints
- **Offline-first** — All data and compute stays on-device

### Project Structure

| Path | Description |
|------|-------------|
| `src/agent.js` | Agent orchestration with tool calling loop |
| `src/tools/` | Tool implementations with Zod validation |
| `src/tools/index.js` | Tool registry and dispatcher |
| `src/runtime/` | Session manager, status events, goals, approvals, router, and multi-turn runner |
| `src/db/database.js` | SQLite database layer (singleton pattern) |
| `src/ui/server.js` | HTTP server for web interface |
| `src/ui/public/` | Static frontend assets (HTML, CSS, JS) |
| `src/types/index.ts` | TypeScript type definitions |
| `tests/` | Test suite (79 tests) |

## Available Tools

| Tool | Input | Description |
|------|-------|-------------|
| `save_note` | `{ text: string }` | Save a note for later recall |
| `search_notes` | `{ query: string, limit?: number }` | Search notes by content |
| `create_task` | `{ title: string, due_date?: string }` | Create a task ("tomorrow" parsed automatically) |
| `list_tasks` | `{ completed?: boolean }` | List tasks, optional completion filter |
| `mark_task_done` | `{ id: number }` | Mark a task as completed |

## Security

- Model path must be a **local file path** — cloud URLs are rejected at startup
- All SQL queries use **parameterized statements** — no string interpolation
- **No dangerous tools** — `shell_exec`, `sql_exec`, `file_write`, `file_read` are not available
- Tool registry enforces a **whitelist** — unknown tools are rejected
- **No cloud fallback** — inference runs entirely on-device via QVAC

## Test Results

```
# tests 79
# pass 79
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
- **GPU only**: Tested on GPU; CPU-only fallback not verified.

## License

Apache-2.0

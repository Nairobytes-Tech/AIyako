# Kioo AI — AI Yako

A local AI assistant that runs entirely offline on your device. Built with the [QVAC SDK](https://docs.qvac.tether.io) for local LLM inference.

## Mission

Kioo AI gives you a private, offline AI assistant that can answer questions, manage notes and tasks, and work without an internet connection. No cloud, no tracking — your data stays on your device.

## Features

- **Fully offline** — No internet required after initial setup
- **Local inference** — Runs on-device via QVAC SDK (llama.cpp)
- **Note management** — Save and search notes with natural language
- **Task tracking** — Create, list, and complete tasks
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

### Running tests

```bash
npm test
```

## Architecture

- **QVAC SDK** — Local LLM inference engine (llama.cpp backend)
- **SQLite** (`node:sqlite`, built into Node 22) — Local persistence for notes and tasks
- **Agent Tools** — `save_note`, `search_notes`, `create_task`, `list_tasks`, `mark_task_done`
- **Web Server** — Built-in HTTP server with static file serving + API endpoints
- **Offline-first** — All data and compute stays on-device

### Project Structure

| Path | Description |
|------|-------------|
| `src/agent.js` | Agent orchestration with tool calling loop |
| `src/tools/` | Tool implementations with Zod validation |
| `src/tools/index.js` | Tool registry and dispatcher |
| `src/db/database.js` | SQLite database layer (singleton pattern) |
| `src/ui/server.js` | HTTP server for web interface |
| `src/ui/public/` | Static frontend assets (HTML, CSS, JS) |
| `src/types/index.ts` | TypeScript type definitions |
| `tests/` | Test suite (39 tests) |

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
# tests 39
# pass 39
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
- **No session persistence**: Each chat request is independent — there's no server-side conversation history between requests.
- **GPU only**: Tested on GPU; CPU-only fallback not verified.

## License

Apache-2.0

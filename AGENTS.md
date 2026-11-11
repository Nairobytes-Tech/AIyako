# AGENTS.md — Kioo AI (AI Yako)

## Project Overview

Kioo AI is a local, offline AI assistant built on the QVAC SDK. It runs entirely on-device with no cloud dependencies for inference.

## Quick Start

```bash
# Prerequisites: Node.js >= 22 (use nvm), QVAC SDK, model weights
nvm use 22

# Run CLI agent
npm start

# Run web server + UI
npm run server
# Then open http://localhost:3000

# Run tests
npm test
```

## Commands Reference

| Command | What it does | Allowed tools |
|---------|-------------|---------------|
| `npm test` | Run test suite | `node --test --test-concurrency=1 "tests/**/*.test.js"` |
| `docker compose up -d searxng` | Start local SearXNG for `web_search` | Docker |
| `npm run server` | Start web server | Node.js v22 |
| `npm run start` | Run CLI agent | Node.js v22 |

## Environment

- **Node**: v22.23.4 (required for `node:sqlite`)
- **Model**: Qwen3-600M Q4_0 (365MB) at `/home/lulwanda/projects/kioo-ai/models/qwen3-0.6b-q4_0.gguf`
- **Config**: `QVAC_CONFIG_PATH=./qvac.config.json` must be set
- **DB**: SQLite via `node:sqlite`, stored in `data/kioo.db`
- **Search**: self-hosted SearXNG at `SEARXNG_URL` (default `http://localhost:8080`)

## Testing Policy

- Tests use Node 22's built-in `node:test` (no external test framework needed)
- Run: `npm test` (94 tests, must all pass before committing; requires Node 22)
- Do NOT commit `data/kioo.db` (gitignored)
- Do NOT commit model weights (gitignored)

## Commit Guidelines

1. Keep commits logical (one feature/test/fix per commit)
2. All tests must pass before committing
3. Update README.md if user-facing changes
4. Keep commits under 10 lines of description for the body

## Architecture

- `src/agent.js` — Agent loop with tool calling via QVAC SDK
- `src/tools/` — 6 tools with Zod validation: save_note, search_notes, create_task, list_tasks, mark_task_done, web_search
- `src/runtime/` — session manager, status events, goals, approvals, hybrid router, and `runTurn()` wrapping the agent loop
- `src/db/database.js` — SQLite singleton for notes, tasks, sessions, messages, goals, artifacts, approvals
- `src/ui/server.js` — HTTP server for web interface
- `src/ui/public/` — Static frontend assets
- `src/types/index.ts` — TypeScript type definitions
- `tests/` — Test suite (94 tests)

## Approval Gate

Set `KIOO_APPROVAL_TOOLS` to a comma-separated list of tool names (e.g. `save_note,create_task`) to require user approval before those tools execute. Pending approvals are exposed via `/sessions/:id` and `GET /sessions/:id/approvals`, and resolved with `POST /sessions/:id/approvals/:approvalId`. The agent resumes after resolution and short-circuits duplicate tool calls to avoid repeated side effects.

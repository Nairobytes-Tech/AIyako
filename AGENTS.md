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
| `npm test` | Run test suite | `node --test tests/` |
| `npm run server` | Start web server | Node.js v22 |
| `npm run start` | Run CLI agent | Node.js v22 |

## Environment

- **Node**: v22.23.4 (required for `node:sqlite`)
- **Model**: Qwen3-600M Q4_0 (365MB) at `/home/lulwanda/projects/kioo-ai/models/qwen3-0.6b-q4_0.gguf`
- **Config**: `QVAC_CONFIG_PATH=./qvac.config.json` must be set
- **DB**: SQLite via `node:sqlite`, stored in `data/kioo.db`

## Testing Policy

- Tests use Node 22's built-in `node:test` (no external test framework needed)
- Run: `npm test` (39 tests, must all pass before committing)
- Do NOT commit `data/kioo.db` (gitignored)
- Do NOT commit model weights (gitignored)

## Commit Guidelines

1. Keep commits logical (one feature/test/fix per commit)
2. All tests must pass before committing
3. Update README.md if user-facing changes
4. Keep commits under 10 lines of description for the body

## Architecture

- `src/agent.js` — Agent loop with tool calling via QVAC SDK
- `src/tools/` — 5 tools with Zod validation: save_note, search_notes, create_task, list_tasks, mark_task_done
- `src/db/database.js` — SQLite singleton for notes and tasks
- `src/ui/server.js` — HTTP server for web interface
- `src/ui/public/` — Static frontend assets
- `src/types/index.ts` — TypeScript type definitions
- `tests/` — Test suite (39 tests)

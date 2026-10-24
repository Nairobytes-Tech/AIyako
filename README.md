# Kioo AI — AI Yako

A local AI assistant that runs entirely offline on your device. Built with the [QVAC SDK](https://docs.qvac.tether.io) for local LLM inference.

## Mission

Kioo AI gives you a private, offline AI assistant that can answer questions, manage notes and tasks, and work without an internet connection. No cloud, no tracking — your data stays on your device.

## Quick Start

### Prerequisites

- Node.js >= 22.21
- npm >= 10.9
- Ubuntu 22+ (or compatible Linux distro)
- 4+ GB RAM (6+ GB recommended)
- 5+ GB free disk space for model weights

### Setup

```bash
# Install dependencies
npm install @qvac/sdk

# Create a config file (copy from example)
cp .env.example .env.local
```

### Running

```bash
# Run the agent (with offline config)
QVAC_CONFIG_PATH=./qvac.config.json node src/agent.js
```

## Architecture

- **QVAC SDK** — Local LLM inference engine (llama.cpp backend)
- **SQLite** — Local persistence for notes, tasks, and conversation history
- **Agent Tools** — `save_note`, `search_notes`, `create_task`
- **Offline-first** — All data and compute stays on-device

## What's Inside

| Component | Description |
|-----------|-------------|
| `src/` | Application source code |
| `src/agent.js` | Main agent orchestration |
| `src/tools/` | Local tool implementations |
| `src/db/` | SQLite database layer |
| `models/` | Downloaded model weights (gitignored) |
| `docs/` | Documentation and test records |
| `tests/` | Test suites |

## License

Apache-2.0

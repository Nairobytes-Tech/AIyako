# Offline Test Record

## Date: Saturday, 24 October 2026

## Test Results

### Environment

| Component | Value |
|-----------|-------|
| OS | Ubuntu 24.04.5 LTS |
| Node.js | v22.23.4 (via nvm) |
| npm | 10.9.9 |
| QVAC SDK | 0.22.0 |
| Model | Qwen3-0.6B Q4_0 |
| Model size | 365 MB |
| Memory | 14Gi total, 6.4Gi available |

### Model Performance

| Metric | Value |
|--------|-------|
| Model load time | ~5 seconds |
| First inference time | ~5.4 seconds |
| Quantization | Q4_0 |

### Offline Verification

1. [x] Download all required model assets — Qwen3-600M Q4_0 (365MB), SHA256 verified
2. [x] Disconnected Wi-Fi and mobile data — verified no external network calls (QVAC runs local llama.cpp server)
3. [x] Started the app and asked a multi-tool request
4. [x] Saved a note and created a task
5. [x] Closed and reopened the app (fresh process, new DB connection)
6. [x] Verified records remain accessible in SQLite (`data/kioo.db`)
7. [x] All steps completed successfully — no failures

### Test Details

**Agent workflow test:**
```
Input: "Save a note that my transport budget is KES 4,000. Then find my transport budget and create a task to review it tomorrow."

1. save_note → {"success":true, "data":{"id":1, "content":"Transport budget is KES 4,000"}}
2. search_notes → {"success":true, "data":{"results":[...]}}
3. create_task → {"success":true, "data":{"title":"Review transport budget", "due_date":"2026-10-25"}}

Result: All 3 tools executed successfully, 0 errors.
```

**Unit test results:**
```
npm test → 12 tests, 12 pass, 0 fail
- save_note: 3 tests (save valid, reject empty, reject missing)
- search_notes: 2 tests (find matches, empty results)
- create_task: 2 tests (with due_date, without due_date)
- list_tasks: 3 tests (empty, with tasks, filter by status)
- mark_task_done: 2 tests (complete task, error on missing)
```

### Tools Available

| Tool | Description |
|------|-------------|
| `save_note` | Persist a note to local storage |
| `search_notes` | Search notes by content (exact + keyword) |
| `create_task` | Create a task with optional due date |
| `list_tasks` | List tasks, optional filter by completion status |
| `mark_task_done` | Mark a task as completed by ID |

### Failures

None recorded.

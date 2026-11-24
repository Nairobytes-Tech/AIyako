import os
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List

import httpx

from . import extended_tools
from .local_tools import (
    create_task as create_task_fn,
    list_tasks as list_tasks_fn,
    mark_task_done as mark_task_done_fn,
    save_note as save_note_fn,
    search_notes as search_notes_fn,
    web_search as web_search_fn,
)
from sandbox import read_file, run_command, write_file

DB_PATH = os.getenv("KIOO_DB_PATH", "data/kioo.db")
MCP_GATEWAY_URL = os.getenv("MCP_GATEWAY_URL", "").rstrip("/")
RATE_LIMIT = min(max(int(os.getenv("KIOO_TOOL_RATE_LIMIT", "30")), 1), 600)


@dataclass
class ToolSpec:
    name: str
    family: str
    risk: str
    schema: Dict[str, Any]
    handler: Callable[[Dict[str, Any]], Dict[str, Any]]


def _schema(name: str, description: str, properties: Dict[str, Any], required: List[str] | None = None):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required or []},
        },
    }


def _audit(tool: str, status: str, detail: str = ""):
    directory = os.path.dirname(DB_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.execute(
        "CREATE TABLE IF NOT EXISTS tool_audit ("
        "id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL, "
        "detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.execute(
        "INSERT INTO tool_audit (id, tool, status, detail) VALUES (?, ?, ?, ?)",
        (uuid.uuid4().hex, tool, status, detail[:1000]),
    )
    connection.commit()
    connection.close()


REGISTRY: Dict[str, ToolSpec] = {
    spec.name: spec
    for spec in [
        ToolSpec("save_note", "memory", "medium", _schema("save_note", "Save information for future reference", {"text": {"type": "string"}}, ["text"]), save_note_fn),
        ToolSpec("search_notes", "memory", "low", _schema("search_notes", "Find previously saved notes", {"query": {"type": "string"}, "limit": {"type": "number"}}, ["query"]), search_notes_fn),
        ToolSpec("create_task", "memory", "medium", _schema("create_task", "Create a task", {"title": {"type": "string"}, "due_date": {"type": "string"}}, ["title"]), create_task_fn),
        ToolSpec("list_tasks", "memory", "low", _schema("list_tasks", "List tasks", {"completed": {"type": "boolean"}}), list_tasks_fn),
        ToolSpec("mark_task_done", "memory", "medium", _schema("mark_task_done", "Mark a task complete", {"id": {"type": "number"}}, ["id"]), mark_task_done_fn),
        ToolSpec("web_search", "research", "low", _schema("web_search", "Search the web via SearXNG", {"query": {"type": "string"}, "num_results": {"type": "number"}}, ["query"]), web_search_fn),
        ToolSpec("browse_page", "research", "low", _schema("browse_page", "Fetch and read a web page", {"url": {"type": "string"}, "max_chars": {"type": "number"}}, ["url"]), extended_tools.browse_page),
        ToolSpec("summarize_url", "research", "low", _schema("summarize_url", "Summarize a web page", {"url": {"type": "string"}}, ["url"]), extended_tools.summarize_url),
        ToolSpec("create_goal", "work", "medium", _schema("create_goal", "Create a goal for a session", {"session_id": {"type": "string"}, "title": {"type": "string"}}, ["title"]), extended_tools.create_goal),
        ToolSpec("list_goals", "work", "low", _schema("list_goals", "List session goals", {"session_id": {"type": "string"}}), extended_tools.list_goals),
        ToolSpec("update_goal", "work", "medium", _schema("update_goal", "Update a goal", {"id": {"type": "string"}, "status": {"type": "string"}, "progress": {"type": "string"}}, ["id"]), extended_tools.update_goal),
        ToolSpec("save_artifact", "work", "medium", _schema("save_artifact", "Save an artifact", {"session_id": {"type": "string"}, "type": {"type": "string"}, "title": {"type": "string"}, "content": {"type": "string"}}, ["content"]), extended_tools.save_artifact),
        ToolSpec("list_artifacts", "work", "low", _schema("list_artifacts", "List session artifacts", {"session_id": {"type": "string"}}), extended_tools.list_artifacts),
        ToolSpec("set_reminder", "system", "medium", _schema("set_reminder", "Set a local reminder", {"message": {"type": "string"}, "due_at": {"type": "string"}}, ["message"]), extended_tools.set_reminder),
        ToolSpec("list_reminders", "system", "low", _schema("list_reminders", "List reminders", {}), extended_tools.list_reminders),
        ToolSpec("get_preferences", "system", "low", _schema("get_preferences", "Get user preferences", {}), extended_tools.get_preferences),
        ToolSpec("set_preference", "system", "medium", _schema("set_preference", "Set a user preference", {"key": {"type": "string"}, "value": {"type": "string"}}, ["key", "value"]), extended_tools.set_preference),
        ToolSpec("execute_command", "execution", "high", _schema("execute_command", "Run a command in an isolated sandbox", {"command": {"type": "string"}}, ["command"]), run_command),
        ToolSpec("write_file", "execution", "high", _schema("write_file", "Write a file in the sandbox", {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]), write_file),
        ToolSpec("read_file", "execution", "low", _schema("read_file", "Read a sandbox file", {"path": {"type": "string"}}, ["path"]), read_file),
    ]
}

_rate_state: Dict[str, tuple] = {}


def tool_specs() -> List[ToolSpec]:
    return list(REGISTRY.values())


def tool_schemas() -> List[Dict[str, Any]]:
    return [spec.schema for spec in REGISTRY.values()]


def get_spec(name: str):
    return REGISTRY.get(name)


def refresh_mcp_tools() -> int:
    if not MCP_GATEWAY_URL:
        return 0
    try:
        response = httpx.get(f"{MCP_GATEWAY_URL}/tools", timeout=5.0)
        response.raise_for_status()
        tools = response.json().get("tools", [])
    except Exception:
        return 0

    added = 0
    for schema in tools:
        name = schema.get("function", {}).get("name")
        if not name or name in REGISTRY:
            continue

        def make_handler(tool_name):
            def handler(args):
                result = httpx.post(
                    f"{MCP_GATEWAY_URL}/tools/{tool_name}/invoke",
                    json={"arguments": args},
                    timeout=30.0,
                )
                result.raise_for_status()
                return result.json()
            return handler

        REGISTRY[name] = ToolSpec(
            name=name,
            family=schema.get("family", "mcp"),
            risk=schema.get("risk", "high"),
            schema=schema,
            handler=make_handler(name),
        )
        added += 1
    return added


def invoke(name: str, args: Dict[str, Any], approved_keys: List[str] | None = None) -> Dict[str, Any]:
    spec = REGISTRY.get(name)
    if not spec:
        return {"success": False, "error": f"Unknown tool: {name}", "risk": "unknown"}

    key = f"{name}:{__import__('json').dumps(args, sort_keys=True)}"
    if spec.risk in ("high", "critical") and key not in (approved_keys or []):
        _audit(name, "pending_approval", key)
        return {
            "success": False,
            "error": "approval_required",
            "risk": spec.risk,
            "approval_key": key,
            "arguments": args,
        }

    now = time.time()
    count, window = _rate_state.get(name, (0, now))
    if now - window >= 60:
        count, window = 0, now
    count += 1
    _rate_state[name] = (count, window)
    if count > RATE_LIMIT:
        _audit(name, "rate_limited")
        return {"success": False, "error": f"Rate limit exceeded for {name}"}

    try:
        result = spec.handler(args)
    except Exception as exc:
        _audit(name, "error", str(exc))
        return {"success": False, "error": str(exc)}

    status = "ok" if result.get("success") else "failed"
    _audit(name, status)
    return result

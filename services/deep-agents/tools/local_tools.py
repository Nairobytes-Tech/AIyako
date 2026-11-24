import json
import os
import sqlite3
from typing import Any, Dict

import httpx

DB_PATH = os.getenv("KIOO_DB_PATH", "data/kioo.db")
SEARXNG_URL = os.getenv("SEARXNG_URL", "http://localhost:8080").rstrip("/")


def _connect():
    directory = os.path.dirname(DB_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute(
        "CREATE TABLE IF NOT EXISTS notes ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, "
        "created_at TEXT NOT NULL DEFAULT (datetime('now')), "
        "updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS tasks ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, due_date TEXT, "
        "completed INTEGER NOT NULL DEFAULT 0, "
        "created_at TEXT NOT NULL DEFAULT (datetime('now')), "
        "updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.commit()
    return connection


def save_note(args: Dict[str, Any]) -> Dict[str, Any]:
    text = str(args.get("text") or "").strip()
    if not text:
        return {"success": False, "error": "text is required"}
    with _connect() as connection:
        cursor = connection.execute("INSERT INTO notes (content) VALUES (?)", (text,))
        note_id = cursor.lastrowid
    return {"success": True, "data": {"id": note_id, "content": text}}


def search_notes(args: Dict[str, Any]) -> Dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if not query:
        return {"success": False, "error": "query is required"}
    limit = min(max(int(args.get("limit", 10)), 1), 50)
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, content, created_at FROM notes "
            "WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?",
            (f"%{query}%", limit),
        ).fetchall()
    return {
        "success": True,
        "data": {"results": [dict(row) for row in rows]},
    }


def create_task(args: Dict[str, Any]) -> Dict[str, Any]:
    title = str(args.get("title") or "").strip()
    if not title:
        return {"success": False, "error": "title is required"}
    due_date = args.get("due_date")
    with _connect() as connection:
        cursor = connection.execute(
            "INSERT INTO tasks (title, due_date) VALUES (?, ?)",
            (title, due_date),
        )
        task_id = cursor.lastrowid
    return {
        "success": True,
        "data": {"id": task_id, "title": title, "due_date": due_date, "completed": False},
    }


def list_tasks(args: Dict[str, Any]) -> Dict[str, Any]:
    completed = args.get("completed")
    query = "SELECT id, title, due_date, completed, created_at FROM tasks"
    params = ()
    if isinstance(completed, bool):
        query += " WHERE completed = ?"
        params = (int(completed),)
    query += " ORDER BY created_at DESC"
    with _connect() as connection:
        rows = connection.execute(query, params).fetchall()
    return {"success": True, "data": {"tasks": [dict(row) for row in rows]}}


def mark_task_done(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        task_id = int(args.get("id"))
    except (TypeError, ValueError):
        return {"success": False, "error": "id must be a number"}
    with _connect() as connection:
        cursor = connection.execute(
            "UPDATE tasks SET completed = 1, updated_at = datetime('now') WHERE id = ?",
            (task_id,),
        )
        if cursor.rowcount == 0:
            return {"success": False, "error": f"Task {task_id} not found"}
    return {"success": True, "data": {"id": task_id, "completed": True}}


def web_search(args: Dict[str, Any]) -> Dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if not query:
        return {"success": False, "error": "query is required"}
    limit = min(max(int(args.get("num_results", 8)), 1), 20)
    try:
        response = httpx.get(
            f"{SEARXNG_URL}/search",
            params={"q": query, "format": "json", "language": "all", "safesearch": 1},
            timeout=10.0,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        return {"success": False, "error": f"SearXNG request failed: {exc}"}

    results = []
    seen = set()
    for item in payload.get("results", []):
        url = item.get("url")
        if not url or url in seen:
            continue
        seen.add(url)
        results.append({
            "title": item.get("title") or "",
            "url": url,
            "snippet": item.get("content") or "",
        })
        if len(results) >= limit:
            break
    return {"success": True, "data": {"query": query, "results": results}}


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "save_note",
            "description": "Save information for future reference",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_notes",
            "description": "Find previously saved notes",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "number"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_task",
            "description": "Create a task with an optional due date",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "due_date": {"type": "string"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tasks",
            "description": "List tasks, optionally filtered by completion",
            "parameters": {
                "type": "object",
                "properties": {"completed": {"type": "boolean"}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mark_task_done",
            "description": "Mark a task as completed by its ID",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "number"}},
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web via local SearXNG for current information",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "num_results": {"type": "number"},
                },
                "required": ["query"],
            },
        },
    },
]

TOOL_HANDLERS = {
    "save_note": save_note,
    "search_notes": search_notes,
    "create_task": create_task,
    "list_tasks": list_tasks,
    "mark_task_done": mark_task_done,
    "web_search": web_search,
}


def execute_tool(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return {"success": False, "error": f"Unknown tool: {name}"}
    return handler(args)


def format_tool_result(name: str, result: Dict[str, Any], args: Dict[str, Any]) -> str:
    if not result or result.get("success") is not True:
        error = result.get("error") if result else "Unknown error"
        return f"Tool {name} failed: {error}"
    if name != "web_search":
        return json.dumps(result)
    data = result.get("data") or {}
    query = args.get("query") or data.get("query") or ""
    results = data.get("results") or []
    if not results:
        return f'Web search returned no results for "{query}".'
    lines = [f'Web search results for "{query}":']
    for index, item in enumerate(results, start=1):
        url = str(item.get("url") or "(no url)")
        snippet = str(item.get("snippet") or "")
        lines.append(f"{index}. {str(item.get('title') or '(untitled)')[:200]}")
        lines.append(f"   URL: {url[:300]}")
        if snippet:
            lines.append(f"   {snippet[:800]}")
    text = "\n".join(lines)
    max_chars = 6000
    if len(text) > max_chars:
        return text[:max_chars] + f"\n[truncated to {max_chars} chars to fit model context]"
    return text

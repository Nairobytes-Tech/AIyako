import os
import re
import sqlite3
import uuid
from typing import Any, Dict

import httpx

DB_PATH = os.getenv("KIOO_DB_PATH", "data/kioo.db")


def _connect():
    directory = os.path.dirname(DB_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute(
        "CREATE TABLE IF NOT EXISTS goals ("
        "id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, "
        "status TEXT NOT NULL DEFAULT 'active', progress TEXT, "
        "created_at TEXT NOT NULL DEFAULT (datetime('now')), "
        "updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS artifacts ("
        "id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, "
        "title TEXT, content TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS reminders ("
        "id TEXT PRIMARY KEY, message TEXT NOT NULL, due_at TEXT, "
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS preferences ("
        "key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.commit()
    return connection


def browse_page(args: Dict[str, Any]) -> Dict[str, Any]:
    url = str(args.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return {"success": False, "error": "url must start with http:// or https://"}
    max_chars = min(max(int(args.get("max_chars", 4000)), 200), 20000)
    try:
        response = httpx.get(url, follow_redirects=True, timeout=10.0)
        response.raise_for_status()
    except Exception as exc:
        return {"success": False, "error": f"Could not fetch page: {exc}"}
    html = response.text
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    title = re.sub(r"<[^>]+>", "", title_match.group(1)).strip() if title_match else ""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return {
        "success": True,
        "data": {"url": str(response.url), "title": title, "text": text[:max_chars]},
    }


def summarize_url(args: Dict[str, Any]) -> Dict[str, Any]:
    result = browse_page(args)
    if not result.get("success"):
        return result
    text = result["data"]["text"]
    sentences = re.split(r"(?<=[.!?])\s+", text)
    summary = " ".join(sentences[:5])[:1200]
    return {
        "success": True,
        "data": {"url": result["data"]["url"], "title": result["data"]["title"], "summary": summary},
    }


def create_goal(args: Dict[str, Any]) -> Dict[str, Any]:
    session_id = str(args.get("session_id") or "default")
    title = str(args.get("title") or "").strip()
    if not title:
        return {"success": False, "error": "title is required"}
    goal_id = uuid.uuid4().hex
    with _connect() as connection:
        connection.execute(
            "INSERT INTO goals (id, session_id, title) VALUES (?, ?, ?)",
            (goal_id, session_id, title),
        )
    return {"success": True, "data": {"id": goal_id, "session_id": session_id, "title": title, "status": "active"}}


def list_goals(args: Dict[str, Any]) -> Dict[str, Any]:
    session_id = str(args.get("session_id") or "default")
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, title, status, progress FROM goals WHERE session_id = ? ORDER BY created_at",
            (session_id,),
        ).fetchall()
    return {"success": True, "data": {"goals": [dict(row) for row in rows]}}


def update_goal(args: Dict[str, Any]) -> Dict[str, Any]:
    goal_id = str(args.get("id") or "")
    fields = []
    values = []
    for key in ("status", "progress"):
        if key in args:
            fields.append(f"{key} = ?")
            values.append(args[key])
    if not fields:
        return {"success": False, "error": "status or progress is required"}
    values.extend([goal_id])
    with _connect() as connection:
        cursor = connection.execute(
            f"UPDATE goals SET {', '.join(fields)}, updated_at = datetime('now') WHERE id = ?",
            values,
        )
        if cursor.rowcount == 0:
            return {"success": False, "error": "Goal not found"}
    return {"success": True, "data": {"id": goal_id, **{k: args[k] for k in ("status", "progress") if k in args}}}


def save_artifact(args: Dict[str, Any]) -> Dict[str, Any]:
    session_id = str(args.get("session_id") or "default")
    artifact_type = str(args.get("type") or "note")
    content = str(args.get("content") or "")
    if not content:
        return {"success": False, "error": "content is required"}
    artifact_id = uuid.uuid4().hex
    with _connect() as connection:
        connection.execute(
            "INSERT INTO artifacts (id, session_id, type, title, content) VALUES (?, ?, ?, ?, ?)",
            (artifact_id, session_id, artifact_type, args.get("title"), content),
        )
    return {"success": True, "data": {"id": artifact_id, "session_id": session_id, "type": artifact_type}}


def list_artifacts(args: Dict[str, Any]) -> Dict[str, Any]:
    session_id = str(args.get("session_id") or "default")
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, type, title, content FROM artifacts WHERE session_id = ? ORDER BY created_at",
            (session_id,),
        ).fetchall()
    return {"success": True, "data": {"artifacts": [dict(row) for row in rows]}}


def set_reminder(args: Dict[str, Any]) -> Dict[str, Any]:
    message = str(args.get("message") or "").strip()
    if not message:
        return {"success": False, "error": "message is required"}
    reminder_id = uuid.uuid4().hex
    with _connect() as connection:
        connection.execute(
            "INSERT INTO reminders (id, message, due_at) VALUES (?, ?, ?)",
            (reminder_id, message, args.get("due_at")),
        )
    return {"success": True, "data": {"id": reminder_id, "message": message}}


def list_reminders(args: Dict[str, Any]) -> Dict[str, Any]:
    with _connect() as connection:
        rows = connection.execute(
            "SELECT id, message, due_at FROM reminders ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
    return {"success": True, "data": {"reminders": [dict(row) for row in rows]}}


def get_preferences(args: Dict[str, Any]) -> Dict[str, Any]:
    with _connect() as connection:
        rows = connection.execute("SELECT key, value FROM preferences").fetchall()
    return {"success": True, "data": {"preferences": {row["key"]: row["value"] for row in rows}}}


def set_preference(args: Dict[str, Any]) -> Dict[str, Any]:
    key = str(args.get("key") or "").strip()
    value = str(args.get("value") or "").strip()
    if not key:
        return {"success": False, "error": "key is required"}
    with _connect() as connection:
        connection.execute(
            "INSERT INTO preferences (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            (key, value),
        )
    return {"success": True, "data": {"key": key, "value": value}}

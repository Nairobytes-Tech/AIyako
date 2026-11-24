import base64
import json
import os
import sqlite3
import uuid
from typing import Any, Dict

from fastapi import FastAPI
from pydantic import BaseModel

from connector import RemoteConnector
from connectors import LocalConnector

DB_PATH = os.getenv("MCP_GATEWAY_DB", "data/mcp.db")
SECRET = os.getenv("MCP_GATEWAY_SECRET", "kioo-dev-secret")

app = FastAPI(title="Kioo MCP Gateway")
connectors = {"local": LocalConnector()}


class RegisterConnector(BaseModel):
    name: str
    url: str
    token: str = ""
    scopes: list[str] = []


class InvokeRequest(BaseModel):
    arguments: Dict[str, Any] = {}
    user_id: str = "default"
    access_token: str = ""


def _db():
    directory = os.path.dirname(DB_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.execute(
        "CREATE TABLE IF NOT EXISTS connector_auth ("
        "connector TEXT NOT NULL, user_id TEXT NOT NULL, token TEXT NOT NULL, "
        "PRIMARY KEY (connector, user_id))"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS audit ("
        "id TEXT PRIMARY KEY, connector TEXT, tool TEXT, user_id TEXT, status TEXT, "
        "detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.commit()
    return connection


def _encode(value: str) -> str:
    raw = value.encode("utf-8")
    key = SECRET.encode("utf-8")
    masked = bytes(byte ^ key[index % len(key)] for index, byte in enumerate(raw))
    return base64.urlsafe_b64encode(masked).decode("ascii")


def _decode(value: str) -> str:
    try:
        masked = base64.urlsafe_b64decode(value.encode("ascii"))
        key = SECRET.encode("utf-8")
        return bytes(byte ^ key[index % len(key)] for index, byte in enumerate(masked)).decode("utf-8")
    except Exception:
        return ""


def _audit(connector: str, tool: str, user_id: str, status: str, detail: str = ""):
    connection = _db()
    connection.execute(
        "INSERT INTO audit (id, connector, tool, user_id, status, detail) VALUES (?, ?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, connector, tool, user_id, status, detail[:1000]),
    )
    connection.commit()
    connection.close()


def _find_connector(tool_name: str):
    for name, connector in connectors.items():
        if any(item.get("function", {}).get("name") == tool_name for item in connector.list_tools()):
            return name, connector
    return None, None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "connectors": list(connectors.keys()),
        "tools": sum(len(connector.list_tools()) for connector in connectors.values()),
    }


@app.get("/connectors")
def list_connectors():
    return {"connectors": list(connectors.keys())}


@app.post("/connectors", status_code=201)
def register_connector(payload: RegisterConnector):
    if not payload.name or not payload.url:
        return {"error": "name and url are required"}
    connectors[payload.name] = RemoteConnector(payload.name, payload.url, payload.token, payload.scopes)

    connection = _db()
    if payload.token:
        connection.execute(
            "INSERT INTO connector_auth (connector, user_id, token) VALUES (?, ?, ?) "
            "ON CONFLICT(connector, user_id) DO UPDATE SET token = excluded.token",
            (payload.name, "default", _encode(payload.token)),
        )
        connection.commit()
    connection.close()
    _audit(payload.name, "register", "default", "ok")
    return {"name": payload.name, "registered": True}


@app.get("/tools")
def list_tools(scopes: str = ""):
    allowed = set(filter(None, scopes.split(","))) if scopes else None
    tools = []
    for connector in connectors.values():
        for tool in connector.list_tools():
            family = tool.get("family") or "mcp"
            if allowed is not None and "*" not in allowed and family not in allowed:
                continue
            tools.append(tool)
    return {"tools": tools}


@app.post("/tools/{tool_name}/invoke")
def invoke_tool(tool_name: str, payload: InvokeRequest):
    connector_name, connector = _find_connector(tool_name)
    if not connector:
        return {"success": False, "error": f"Unknown tool: {tool_name}"}

    tool_spec = next(
        item for item in connector.list_tools()
        if item.get("function", {}).get("name") == tool_name
    )
    scopes = getattr(connector, "scopes", [])
    family = tool_spec.get("family") or "mcp"
    if scopes and family not in scopes and "*" not in scopes:
        _audit(connector_name, tool_name, payload.user_id, "denied_scope")
        return {"success": False, "error": f"Tool {tool_name} is outside connector scopes"}

    token = payload.access_token
    if not token and connector_name != "local":
        connection = _db()
        row = connection.execute(
            "SELECT token FROM connector_auth WHERE connector = ? AND user_id = ?",
            (connector_name, payload.user_id),
        ).fetchone()
        connection.close()
        token = _decode(row["token"]) if row else ""

    context = {"user_id": payload.user_id, "access_token": token}
    try:
        result = connector.call_tool(tool_name, payload.arguments, context)
    except Exception as exc:
        _audit(connector_name, tool_name, payload.user_id, "error", str(exc))
        return {"success": False, "error": str(exc)}

    _audit(
        connector_name,
        tool_name,
        payload.user_id,
        "ok" if result.get("success") else "failed",
        json.dumps(result)[:500],
    )
    return result


@app.get("/audit")
def audit_log(limit: int = 50):
    connection = _db()
    rows = connection.execute(
        "SELECT id, connector, tool, user_id, status, detail, created_at "
        "FROM audit ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (min(max(limit, 1), 200),),
    ).fetchall()
    connection.close()
    return {"events": [dict(row) for row in rows]}


@app.post("/connectors/{name}/refresh")
def refresh_auth(name: str, user_id: str = "default"):
    connector = connectors.get(name)
    if not connector:
        return {"success": False, "error": "Connector not found"}
    return connector.refresh_auth({"user_id": user_id})


@app.post("/webhooks/{name}")
def webhook(name: str, payload: Dict[str, Any]):
    connector = connectors.get(name)
    if not connector:
        return {"success": False, "error": "Connector not found"}
    return connector.webhook(payload)

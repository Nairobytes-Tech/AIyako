import uuid
from typing import Any, Dict

from connector import Connector


def _schema(name, description, properties, required=None, risk="low", family="mcp"):
    return {
        "type": "function",
        "family": family,
        "risk": risk,
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required or []},
        },
    }


class LocalConnector(Connector):
    name = "local"

    def __init__(self):
        self.messages = [
            {"id": "m1", "from": "Ada", "subject": "Kioo demo", "body": "Welcome to Kioo."},
            {"id": "m2", "from": "Team", "subject": "Standup", "body": "Standup at 10:00."},
        ]
        self.events = [
            {"id": "e1", "title": "Standup", "start": "10:00", "end": "10:15"},
        ]
        self.chats = [
            {"id": "c1", "name": "Family", "last_message": "See you later"},
        ]
        self.meetings = [
            {"id": "mt1", "title": "Weekly sync", "transcript": "We agreed to ship the MCP gateway."},
        ]
        self.tools = [
            _schema("list_messages", "List recent emails", {"limit": {"type": "number"}}, family="email"),
            _schema("read_message", "Read an email", {"id": {"type": "string"}}, ["id"], family="email"),
            _schema("search_mail", "Search emails", {"query": {"type": "string"}}, ["query"], family="email"),
            _schema("send_email", "Send an email", {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, ["to", "subject", "body"], "high", "email"),
            _schema("list_events", "List calendar events", {}, family="calendar"),
            _schema("create_event", "Create a calendar event", {"title": {"type": "string"}, "start": {"type": "string"}}, ["title", "start"], "high", "calendar"),
            _schema("list_chats", "List recent WhatsApp chats", {}, family="whatsapp"),
            _schema("send_whatsapp", "Send a WhatsApp message", {"chat_id": {"type": "string"}, "message": {"type": "string"}}, ["chat_id", "message"], "high", "whatsapp"),
            _schema("list_meetings", "List recent meetings", {}, family="meetings"),
            _schema("summarize_meeting", "Summarize a meeting transcript", {"id": {"type": "string"}}, ["id"], family="meetings"),
        ]
        self.handlers = {
            "list_messages": lambda args: {"success": True, "data": {"messages": self.messages[:int(args.get("limit", 10))]}},
            "read_message": self._read_message,
            "search_mail": self._search_mail,
            "send_email": self._send_email,
            "list_events": lambda args: {"success": True, "data": {"events": self.events}},
            "create_event": self._create_event,
            "list_chats": lambda args: {"success": True, "data": {"chats": self.chats}},
            "send_whatsapp": self._send_whatsapp,
            "list_meetings": lambda args: {"success": True, "data": {"meetings": self.meetings}},
            "summarize_meeting": self._summarize_meeting,
        }

    def list_tools(self):
        return self.tools

    def call_tool(self, name, args, user_context):
        handler = self.handlers.get(name)
        if not handler:
            return {"success": False, "error": f"Unknown connector tool: {name}"}
        return handler(args)

    def _read_message(self, args):
        message = next((m for m in self.messages if m["id"] == args.get("id")), None)
        if not message:
            return {"success": False, "error": "Message not found"}
        return {"success": True, "data": message}

    def _search_mail(self, args):
        query = str(args.get("query") or "").lower()
        found = [m for m in self.messages if query in (m["subject"] + m["body"]).lower()]
        return {"success": True, "data": {"messages": found}}

    def _send_email(self, args):
        record = {"id": uuid.uuid4().hex, **args}
        return {"success": True, "data": {"queued": True, "message": record}}

    def _create_event(self, args):
        record = {"id": uuid.uuid4().hex, **args}
        self.events.append(record)
        return {"success": True, "data": {"event": record}}

    def _send_whatsapp(self, args):
        return {"success": True, "data": {"queued": True, "message": args}}

    def _summarize_meeting(self, args):
        meeting = next((m for m in self.meetings if m["id"] == args.get("id")), None)
        if not meeting:
            return {"success": False, "error": "Meeting not found"}
        return {"success": True, "data": {"summary": meeting["transcript"][:600]}}

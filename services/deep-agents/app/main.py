import json
import os
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import agent_graph
from app.prompt import build_system_prompt
from tools.local_tools import format_tool_result
from tools.registry import invoke, refresh_mcp_tools, tool_schemas

MODEL_BASE_URL = os.getenv("MODEL_BASE_URL", "http://localhost:8000/v1").rstrip("/")
MODEL_NAME = os.getenv("MODEL_NAME", "qwen3-0.6b-local")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "")
MODEL_TIMEOUT_SECONDS = max(float(os.getenv("MODEL_TIMEOUT_SECONDS", "300")), 1.0)
MAX_STEPS = min(max(int(os.getenv("KIOO_MAX_STEPS", "10")), 1), 10)
USE_GRAPH = agent_graph.LANGGRAPH_AVAILABLE and os.getenv("KIOO_USE_LANGGRAPH", "1") != "0"
SYSTEM_PROMPT = build_system_prompt(tool_schemas())

MCP_TOOLS = refresh_mcp_tools()

app = FastAPI(title="Kioo Deep Agents Service")


class ChatRequest(BaseModel):
    session_id: str
    message: str
    history: Optional[List[Dict[str, Any]]] = None
    approved_tool_keys: Optional[List[str]] = None


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    status: str = "completed"
    error: Optional[str] = None
    model: Optional[str] = None
    steps: int = 0
    tool_calls: List[Dict[str, Any]] = []
    tool_results: List[Any] = []
    approval: Optional[Dict[str, Any]] = None
    events: List[Dict[str, Any]] = []


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "fallback": FALLBACK_MODEL,
        "max_steps": MAX_STEPS,
        "engine": "langgraph" if USE_GRAPH else "loop",
        "mcp_tools": MCP_TOOLS,
        "tools": len(tool_schemas()),
    }


@app.get("/")
def root():
    return {"service": "kioo-deep-agents", "docs": "/docs"}


def _prepare_history(req: ChatRequest):
    history = list(req.history or [])
    if not any(message.get("role") == "system" for message in history):
        history.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    return history + [{"role": "user", "content": req.message}]


async def _call_model(client: httpx.AsyncClient, model: str, messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    response = await client.post(
        f"{MODEL_BASE_URL}/chat/completions",
        json={
            "model": model,
            "messages": messages,
            "tools": tool_schemas(),
            "stream": False,
            "temperature": 0.2,
        },
        timeout=MODEL_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"Malformed model response: {str(payload)[:400]}") from exc
    if not isinstance(message, dict):
        raise ValueError(f"Malformed model message: {str(message)[:400]}")
    return message


async def _completion(messages: List[Dict[str, Any]]):
    models = [MODEL_NAME] + ([FALLBACK_MODEL] if FALLBACK_MODEL and FALLBACK_MODEL != MODEL_NAME else [])
    last_error = None
    async with httpx.AsyncClient() as client:
        for model in models:
            for _ in range(2):
                try:
                    return await _call_model(client, model, messages), model, None
                except Exception as exc:
                    last_error = str(exc).strip() or type(exc).__name__
    return None, None, last_error or "No model available"


def _parse_arguments(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


async def _run_graph(req: ChatRequest):
    reply = await agent_graph.run_with_graph(_prepare_history(req), req.session_id)
    return ChatResponse(
        session_id=req.session_id,
        reply=str(reply),
        model=MODEL_NAME,
        steps=1,
        events=[{"type": "final", "content": str(reply)}],
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if USE_GRAPH:
        try:
            return await _run_graph(req)
        except Exception:
            pass

    messages = _prepare_history(req)
    approved = set(req.approved_tool_keys or [])
    tool_calls_log: List[Dict[str, Any]] = []
    tool_results: List[Any] = []
    events: List[Dict[str, Any]] = []

    for step in range(1, MAX_STEPS + 1):
        message, model, error = await _completion(messages)
        if error or message is None:
            return ChatResponse(
                session_id=req.session_id,
                reply="I couldn't complete that right now. Please try again.",
                status="error",
                error=error or "The model returned an empty response.",
                model=model,
                steps=step,
                tool_calls=tool_calls_log,
                tool_results=tool_results,
                events=events,
            )

        calls = message.get("tool_calls") or []
        if not calls:
            reply = str(message.get("content") or "").strip() or "I have completed your request."
            events.append({"type": "final", "content": reply})
            return ChatResponse(
                session_id=req.session_id,
                reply=reply,
                model=model,
                steps=step,
                tool_calls=tool_calls_log,
                tool_results=tool_results,
                events=events,
            )

        messages.append({"role": "assistant", "content": str(message.get("content") or ""), "tool_calls": calls})
        repeated_count = 0

        for call in calls:
            function = call.get("function") or {}
            name = function.get("name") or call.get("name") or "unknown"
            args = _parse_arguments(function.get("arguments", call.get("arguments")))
            events.append({"type": "status", "status": "tool", "tool": name})
            events.append({"type": "toolCall", "call": {"name": name, "arguments": args}})

            result = invoke(name, args, list(approved))
            if result.get("error") == "approval_required":
                approval = {
                    "name": name,
                    "arguments": args,
                    "key": result.get("approval_key"),
                    "risk": result.get("risk"),
                }
                events.append({"type": "status", "status": "waiting_approval", "tool": name})
                return ChatResponse(
                    session_id=req.session_id,
                    reply="Waiting for your approval.",
                    status="waiting_approval",
                    model=model,
                    steps=step,
                    tool_calls=tool_calls_log,
                    tool_results=tool_results,
                    approval=approval,
                    events=events,
                )

            key = f"{name}:{json.dumps(args, sort_keys=True)}"
            if any(previous.get("name") == name and previous.get("arguments") == args for previous in tool_calls_log):
                repeated_count += 1
            tool_calls_log.append({"name": name, "arguments": args, "key": key})
            tool_results.append(result)
            events.append({"type": "toolResult", "result": result})
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id", ""),
                "name": name,
                "content": format_tool_result(name, result, args),
            })

        if repeated_count == len(calls):
            reply = "That action was already completed."
            events.append({"type": "final", "content": reply})
            return ChatResponse(
                session_id=req.session_id,
                reply=reply,
                model=model,
                steps=step,
                tool_calls=tool_calls_log,
                tool_results=tool_results,
                events=events,
            )

    reply = "I reached the step limit before finishing. Please try a shorter request."
    return ChatResponse(
        session_id=req.session_id,
        reply=reply,
        status="max_steps",
        model=MODEL_NAME,
        steps=MAX_STEPS,
        tool_calls=tool_calls_log,
        tool_results=tool_results,
        events=events,
    )


def _sse(payload: Dict[str, Any]) -> str:
    chunk = {
        "id": f"chatcmpl-{os.getenv('SESSION_ID', 'local')}",
        "object": "chat.completion.chunk",
        "choices": [{"index": 0, "delta": payload, "finish_reason": None}],
    }
    return f"data: {json.dumps(chunk)}\n\n"


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    async def generate():
        if USE_GRAPH and agent_graph.LANGGRAPH_AVAILABLE:
            try:
                graph = agent_graph.get_graph()
                config = agent_graph.config_for(req.session_id)
                async for event in graph.astream_events(
                    {"messages": agent_graph.to_langchain_messages(_prepare_history(req))},
                    config=config,
                    version="v2",
                ):
                    kind = event.get("event")
                    if kind == "on_chat_model_stream":
                        token = event.get("data", {}).get("chunk", None)
                        content = getattr(token, "content", "") if token else ""
                        if content:
                            yield _sse({"content": content})
                    elif kind == "on_tool_start":
                        yield _sse({"status": "tool", "tool": event.get("name")})
                    elif kind == "on_tool_end":
                        yield _sse({"toolResult": str(event.get("data", {}).get("output", ""))[:2000]})
                yield "data: [DONE]\n\n"
                return
            except Exception:
                pass

        result = await chat(req)
        for token in result.reply.split(" "):
            yield _sse({"content": f"{token} "})
        for event in result.events:
            if event.get("type") == "toolCall":
                yield _sse({"status": "tool", "tool": event["call"].get("name")})
            elif event.get("type") == "toolResult":
                yield _sse({"toolResult": event["result"]})
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")

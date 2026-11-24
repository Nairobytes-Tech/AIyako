import os
from typing import Any, Dict, List

from tools.registry import tool_specs

MODEL_BASE_URL = os.getenv("MODEL_BASE_URL", "http://localhost:8000/v1").rstrip("/")
MODEL_NAME = os.getenv("MODEL_NAME", "qwen3-0.6b-local")
MODEL_TIMEOUT_SECONDS = max(float(os.getenv("MODEL_TIMEOUT_SECONDS", "300")), 1.0)
DB_PATH = os.getenv("KIOO_DB_PATH", "data/kioo.db")

try:
    from langchain_core.tools import StructuredTool
    from langchain_openai import ChatOpenAI
    from langgraph.checkpoint.memory import MemorySaver
    from langgraph.prebuilt import create_react_agent
    from pydantic import create_model

    LANGGRAPH_AVAILABLE = True
except Exception:
    LANGGRAPH_AVAILABLE = False


_TYPE_MAP = {
    "string": str,
    "number": float,
    "integer": int,
    "boolean": bool,
    "object": dict,
    "array": list,
}


def _args_model(name: str, schema: Dict[str, Any]):
    fn = schema.get("function", {})
    properties = fn.get("parameters", {}).get("properties", {})
    required = fn.get("parameters", {}).get("required", [])
    fields = {}
    for key, prop in properties.items():
        field_type = _TYPE_MAP.get(prop.get("type"), str)
        fields[key] = (field_type, ... if key in required else None)
    return create_model(f"{name}_args", **fields)


def _tool_from_spec(spec):
    from tools.registry import invoke

    def handler(**kwargs):
        return invoke(spec.name, kwargs)

    return StructuredTool.from_function(
        func=handler,
        name=spec.name,
        description=spec.schema["function"].get("description", ""),
        args_schema=_args_model(spec.name, spec.schema),
    )


_graph = None
_checkpointer = None


def get_checkpointer():
    global _checkpointer
    if _checkpointer is not None:
        return _checkpointer
    try:
        from langgraph.checkpoint.sqlite import SqliteSaver
        _checkpointer = SqliteSaver.from_conn_string(DB_PATH)
    except Exception:
        _checkpointer = MemorySaver()
    return _checkpointer


def get_graph():
    global _graph
    if _graph is not None:
        return _graph
    llm = ChatOpenAI(
        base_url=MODEL_BASE_URL,
        api_key="local",
        model=MODEL_NAME,
        temperature=0.2,
        timeout=MODEL_TIMEOUT_SECONDS,
    )
    tools = [_tool_from_spec(spec) for spec in tool_specs()]
    _graph = create_react_agent(llm, tools, checkpointer=get_checkpointer())
    return _graph


def config_for(session_id: str) -> Dict[str, Any]:
    return {"configurable": {"thread_id": session_id}}


def to_langchain_messages(history: List[Dict[str, Any]]):
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

    mapping = []
    for message in history:
        role = message.get("role")
        if role == "system":
            mapping.append(SystemMessage(content=message.get("content") or ""))
        elif role == "assistant":
            mapping.append(AIMessage(content=message.get("content") or ""))
        elif role == "tool":
            mapping.append(ToolMessage(
                content=message.get("content") or "",
                tool_call_id=message.get("tool_call_id") or "",
                name=message.get("name") or "tool",
            ))
        else:
            mapping.append(HumanMessage(content=message.get("content") or ""))
    return mapping


async def run_with_graph(history: List[Dict[str, Any]], session_id: str) -> str:
    graph = get_graph()
    result = await graph.ainvoke(
        {"messages": to_langchain_messages(history)},
        config=config_for(session_id),
    )
    return result["messages"][-1].content

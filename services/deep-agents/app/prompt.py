import os
from pathlib import Path
from typing import Any, Dict, List, Optional


def _load_base_prompt() -> str:
    candidates = []
    configured = os.getenv("KIOO_PROMPT_PATH")
    if configured:
        candidates.append(Path(configured))
    source = Path(__file__).resolve()
    if len(source.parents) > 3:
        candidates.append(source.parents[3] / "prompts" / "kioo-system.txt")
    candidates.append(Path("/app/prompts/kioo-system.txt"))
    for candidate in candidates:
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8").strip()
    raise FileNotFoundError("Kioo system prompt file not found")


BASE_SYSTEM_PROMPT = _load_base_prompt()


def build_system_prompt(tools: Optional[List[Dict[str, Any]]] = None) -> str:
    lines = []
    for tool in tools or []:
        definition = tool.get("function", tool)
        name = definition.get("name")
        if not name:
            continue
        description = definition.get("description") or "Use when relevant."
        lines.append(f"- {name}: {description}")

    if not lines:
        return BASE_SYSTEM_PROMPT

    tool_section = "\n".join(lines)
    return (
        f"{BASE_SYSTEM_PROMPT}\n\n"
        f"## Available tools\n{tool_section}\n\n"
        "Use the tool schemas for exact arguments. Call a tool instead of describing what you would do."
    )

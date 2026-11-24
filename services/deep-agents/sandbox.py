import os
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict

USE_DOCKER = os.getenv("KIOO_SANDBOX_DOCKER") == "1"
DOCKER_IMAGE = os.getenv("KIOO_SANDBOX_IMAGE", "python:3.12-slim")
TIMEOUT = min(max(int(os.getenv("KIOO_SANDBOX_TIMEOUT", "10")), 1), 60)

BLOCKED = ["rm -rf /", "mkfs", "shutdown", "reboot"]


def run_command(args: Dict[str, Any]) -> Dict[str, Any]:
    command = str(args.get("command") or "").strip()
    if not command:
        return {"success": False, "error": "command is required"}
    if any(blocked in command for blocked in BLOCKED):
        return {"success": False, "error": "command blocked by sandbox policy"}

    with tempfile.TemporaryDirectory(prefix="kioo-sandbox-") as workdir:
        try:
            if USE_DOCKER:
                result = subprocess.run(
                    [
                        "docker", "run", "--rm", "--network", "none", "--read-only",
                        "-v", f"{workdir}:/work", "-w", "/work",
                        DOCKER_IMAGE, "sh", "-c", command,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=TIMEOUT,
                )
            else:
                result = subprocess.run(
                    shlex.split(command) if not any(char in command for char in "|&;><$") else command,
                    shell=any(char in command for char in "|&;><$"),
                    cwd=workdir,
                    capture_output=True,
                    text=True,
                    timeout=TIMEOUT,
                    env={"PATH": os.getenv("PATH", "/usr/bin:/bin"), "HOME": workdir},
                )
        except subprocess.TimeoutExpired:
            return {"success": False, "error": f"command timed out after {TIMEOUT}s"}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    return {
        "success": result.returncode == 0,
        "data": {
            "stdout": result.stdout[-8000:],
            "stderr": result.stderr[-8000:],
            "exit_code": result.returncode,
        },
        "error": None if result.returncode == 0 else result.stderr[-2000:],
    }


def write_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = Path(str(args.get("path") or ""))
    content = str(args.get("content") or "")
    if not path.name or ".." in path.parts:
        return {"success": False, "error": "invalid path"}
    target = Path(tempfile.gettempdir()) / "kioo-sandbox-files" / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"success": True, "data": {"path": str(target), "bytes": len(content)}}


def read_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = Path(str(args.get("path") or ""))
    if not path.name or ".." in path.parts:
        return {"success": False, "error": "invalid path"}
    target = Path(tempfile.gettempdir()) / "kioo-sandbox-files" / path
    if not target.exists():
        return {"success": False, "error": "file not found"}
    return {"success": True, "data": {"path": str(target), "content": target.read_text(encoding="utf-8")[:20000]}}

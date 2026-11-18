from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import os, json, httpx

MODEL_BASE_URL = os.getenv("MODEL_BASE_URL", "http://localhost:8000/v1")
MODEL_NAME = os.getenv("MODEL_NAME", "Qwen3.5-9B")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "Qwen3.5-4B")

app = FastAPI(title="Kioo Deep Agents Service")

class ChatRequest(BaseModel):
    session_id: str
    message: str
    history: Optional[List[Dict[str, Any]]] = None

class ChatResponse(BaseModel):
    session_id: str
    reply: str
    status: str = "completed"
    error: Optional[str] = None
    tool_calls: List[Dict[str, Any]] = []
    tool_results: List[Any] = []

@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "fallback": FALLBACK_MODEL}

@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{MODEL_BASE_URL}/chat/completions", json={
                "model": MODEL_NAME,
                "messages": (req.history or []) + [{"role": "user", "content": req.message}],
                "stream": False,
            })
            r.raise_for_status()
            data = r.json()
            reply = data["choices"][0]["message"].get("content", "")
            return ChatResponse(session_id=req.session_id, reply=reply)
    except Exception as e:
        # Fallback: smaller model
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                r = await client.post(f"{MODEL_BASE_URL}/chat/completions", json={
                    "model": FALLBACK_MODEL,
                    "messages": (req.history or []) + [{"role": "user", "content": req.message}],
                    "stream": False,
                })
                r.raise_for_status()
                data = r.json()
                reply = data["choices"][0]["message"].get("content", "")
                return ChatResponse(session_id=req.session_id, reply=reply, status="degraded")
        except Exception as e2:
            return ChatResponse(session_id=req.session_id, reply="I couldn't complete that right now. Please try again.", status="error", error=str(e2))

@app.get("/")
def root():
    return {"service": "kioo-deep-agents", "docs": "/docs"}

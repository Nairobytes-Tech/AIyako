from abc import ABC, abstractmethod
from typing import Any, Dict, List

import httpx


class Connector(ABC):
    name = "base"

    @abstractmethod
    def list_tools(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def call_tool(self, name: str, args: Dict[str, Any], user_context: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError

    def refresh_auth(self, user_context: Dict[str, Any]) -> Dict[str, Any]:
        return {"success": True, "data": {"refreshed": False}}

    def webhook(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {"success": False, "error": "webhooks not supported"}


class RemoteConnector(Connector):
    def __init__(self, name: str, url: str, token: str = "", scopes: List[str] | None = None):
        self.name = name
        self.url = url.rstrip("/")
        self.token = token
        self.scopes = scopes or []

    def _headers(self, user_context):
        headers = {"Content-Type": "application/json"}
        token = user_context.get("access_token") or self.token
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def list_tools(self):
        response = httpx.get(f"{self.url}/tools", headers=self._headers({}), timeout=10.0)
        response.raise_for_status()
        return response.json().get("tools", [])

    def call_tool(self, name, args, user_context):
        response = httpx.post(
            f"{self.url}/call",
            headers=self._headers(user_context),
            json={"name": name, "arguments": args},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()

    def refresh_auth(self, user_context):
        response = httpx.post(
            f"{self.url}/refresh",
            headers=self._headers(user_context),
            timeout=10.0,
        )
        response.raise_for_status()
        return response.json()

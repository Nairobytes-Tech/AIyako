# MCP Connectors — Interface, Auth, Approvals

## Naming

- **Connector**: external system adapter (email, calendar, WhatsApp, meetings).
- **MCP Gateway**: registry/router/auth/audit bus at `services/mcp-gateway/`.
- **Tool**: an action exposed by a connector to the Deep Agent.
- **Tool family**: grouping (`email`, `calendar`, `whatsapp`, `meetings`, `research`, `memory`).
- **Approval**: explicit user confirmation for high-risk tools.

## Connector interface

`services/mcp-gateway/connector.py`:

```python
class Connector:
    name: str
    def list_tools(self) -> list[dict]: ...
    def call_tool(self, name, args, user_context) -> dict: ...
    def refresh_auth(self, user_context) -> dict: ...
    def webhook(self, payload) -> dict: ...
```

`list_tools()` returns OpenAI-style function schemas with extra `family` and
`risk` fields. `call_tool()` returns `{success: true, data}` or
`{success: false, error}`. `user_context` carries `user_id` and `access_token`.

## Gateway endpoints

- `GET /health`, `GET /connectors`
- `POST /connectors` — register a remote connector (`name`, `url`, `token`, `scopes`)
- `GET /tools?scopes=email,calendar` — aggregate tool schemas for the agent
- `POST /tools/{name}/invoke` — route one tool call with audit
- `GET /audit` — recent tool-call log
- `POST /connectors/{name}/refresh`, `POST /webhooks/{name}`

## Auth and scopes

- Tokens are stored per `(connector, user_id)` in `data/mcp.db`.
- `MCP_GATEWAY_SECRET` obfuscates stored tokens; replace with a KMS in production.
- Connector `scopes` limit which tool families may be invoked.
- Direct API calls from the agent to Gmail/WhatsApp are forbidden; all calls go through the gateway.

## Risk and approval policy

| Risk | Examples | Policy |
|------|----------|--------|
| low | `search_notes`, `web_search`, `list_messages`, `list_events` | auto |
| medium | `save_note`, `create_task`, `create_goal`, `set_reminder` | auto + audit |
| high | `send_email`, `send_whatsapp`, `create_event`, `execute_command` | approval required |
| critical | payments/admin | blocked |

When Deep Agents invokes a high-risk tool without approval, it returns
`status: waiting_approval` and an `approval` payload. The Node proxy persists
an approval row and re-invokes the remote agent with `approved_tool_keys` after
the user approves.

## First connectors

Implemented as local starter connectors in `services/mcp-gateway/connectors.py`:

1. Email — `list_messages`, `read_message`, `search_mail`, `send_email` (high)
2. Calendar — `list_events`, `create_event` (high)
3. WhatsApp — `list_chats`, `send_whatsapp` (high)
4. Meetings — `list_meetings`, `summarize_meeting`

They currently use in-memory demo data. Replace with provider adapters behind
the same interface when credentials are available.

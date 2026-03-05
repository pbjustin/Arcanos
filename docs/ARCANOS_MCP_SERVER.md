# ARCANOS MCP Server

## Overview
ARCANOS exposes an MCP server with:

1. HTTP transport: `POST /mcp` (`src/routes/mcp.ts`)
2. Stdio transport: `src/mcp/mcp-stdio.ts`

The server registers ARCANOS/Trinity, plans, agents, RAG, research, memory, module, and ops tools from `src/mcp/server/index.ts`.

## Request Lifecycle (HTTP)
1. `POST /mcp` enters `mcpAuthMiddleware`.
2. Request context is built (`requestId`, OpenAI client, runtime budget, optional `sessionId`).
3. A fresh MCP server + streamable HTTP transport is created per request (prevents cross-request state leakage).
4. Tool handlers execute with request-local async context.
5. Response is returned in MCP protocol format.

`GET /mcp` is intentionally rejected with `405 Method Not Allowed`.

## Security Model

### Auth and origin
- `MCP_BEARER_TOKEN` is required.
- Request must include `Authorization: Bearer <token>`.
- Optional origin allowlist via `MCP_ALLOWED_ORIGINS`.

### Confirmation gating
- Controlled by `MCP_REQUIRE_CONFIRMATION` (default `true`).
- Gated tools require a server-issued nonce (`confirmationNonce`).
- Nonce is payload-bound and session-bound, then consumed on success.
- TTL is `MCP_CONFIRM_TTL_MS` (default `60000` ms).

### Destructive exposure
- `MCP_EXPOSE_DESTRUCTIVE=false` (default) hides destructive operations.
- Destructive tools return `ERR_DISABLED` when not exposed.

### Module invocation hardening
- `modules.invoke` is deny-by-default.
- Allowlist is `MCP_ALLOW_MODULE_ACTIONS` (CSV, e.g. `rag:*,billing:charge`).

## Tool Catalog

### Core reasoning
- `trinity.ask`
- `arcanos.run`
- `trinity.query_finetune`

### CLEAR and plans
- `clear.evaluate`
- `plans.create`
- `plans.list`
- `plans.get`
- `plans.approve`
- `plans.block` (destructive)
- `plans.expire` (destructive)
- `plans.execute` (destructive)
- `plans.results`

### Agents
- `agents.register`
- `agents.list`
- `agents.get`
- `agents.heartbeat`

### RAG and research
- `rag.ingest_url`
- `rag.ingest_content`
- `rag.query`
- `research.run`

### Memory/modules/ops
- `memory.save`
- `memory.load`
- `memory.list`
- `memory.delete` (destructive)
- `modules.list`
- `modules.invoke` (allowlist-gated)
- `ops.health_report`

## Configuration
| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_BEARER_TOKEN` | none | Required for HTTP MCP auth. |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated browser origin allowlist. |
| `MCP_HTTP_BODY_LIMIT` | `1mb` | Express JSON body size limit on `/mcp`. |
| `MCP_REQUIRE_CONFIRMATION` | `true` | Enables nonce confirmation gate. |
| `MCP_CONFIRM_TTL_MS` | `60000` | Nonce expiry window in milliseconds. |
| `MCP_EXPOSE_DESTRUCTIVE` | `false` | Enables destructive tools when `true`. |
| `MCP_ENABLE_SESSIONS` | `false` | Enables generated transport session IDs. |
| `MCP_ALLOW_MODULE_ACTIONS` | empty | Required to permit `modules.invoke`. |

## Example (HTTP MCP)

### List tools
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list","params":{}}'
```

### Call `trinity.ask`
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"method\":\"tools/call\",\"params\":{\"name\":\"trinity.ask\",\"arguments\":{\"prompt\":\"Health check\"}}}"
```

## Stdio Mode Notes
- Entrypoint: `node dist/mcp/mcp-stdio.js` (after build).
- Logs are forced to `stderr` to avoid corrupting MCP stdout frames.
- Optional session id can be passed by CLI arg (`--sessionId`) or env (`MCP_SESSION_ID` / `ARCANOS_SESSION_ID`).

## Troubleshooting
- `MCP_BEARER_TOKEN not configured`: set the token env var and restart.
- `401 Unauthorized`: wrong/missing bearer token.
- `403 Origin not allowed`: `Origin` header not in `MCP_ALLOWED_ORIGINS`.
- `ERR_CONFIRM_REQUIRED` / `ERR_CONFIRM_INVALID`: re-run tool call with returned `confirmationNonce` before TTL expires.
- `ERR_DISABLED`: tool is destructive and `MCP_EXPOSE_DESTRUCTIVE=false`.
- `ERR_GATED` from `modules.invoke`: add explicit `module:action` to `MCP_ALLOW_MODULE_ACTIONS`.

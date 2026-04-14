# ARCANOS MCP Server

## Overview
ARCANOS exposes MCP over two transports:

1. HTTP streamable transport: `POST /mcp` (`src/routes/mcp.ts`)
2. Local stdio transport: `src/mcp/mcp-stdio.ts`

Tool registration lives in `src/mcp/server/index.ts` and includes reasoning, plans, agents, DAG orchestration, RAG, research, memory, modules, and ops health.

Routing rule:
- `POST /mcp` is the explicit MCP control-plane transport.
- `POST /gpt/:gptId` is the writing plane and does not auto-dispatch to MCP. If a caller needs MCP tools, it must call `/mcp` directly.

## How It Works (HTTP)

Request flow for `POST /mcp`:
1. `mcpAuthMiddleware` verifies bearer token and optional origin allowlist.
2. `buildMcpRequestContext(req)` creates request-local context:
   - `requestId`
   - OpenAI client handle
   - runtime budget
   - optional `sessionId` from headers/body
3. A fresh MCP server + streamable HTTP transport pair is built for this request.
4. `runWithMcpRequestContext(...)` binds context via `AsyncLocalStorage`.
5. MCP SDK handles JSON-RPC request and returns MCP response payload.

`GET /mcp` is intentionally rejected with `405` and `Allow: POST`.

## How It Works (Stdio)

Stdio entrypoint (`src/mcp/mcp-stdio.ts`) does the following:
1. Redirects console logging to `stderr` to protect stdout MCP frames.
2. Builds one stdio MCP context (`buildMcpStdioContext`).
3. Creates the server and connects `StdioServerTransport`.
4. Supports optional session id from:
   - CLI: `--sessionId` / `--session-id`
   - env: `MCP_SESSION_ID` or `ARCANOS_SESSION_ID`

## Security and Guardrails

### Authentication and origin policy
- `MCP_BEARER_TOKEN` is mandatory for HTTP transport.
- Request header must be exact: `Authorization: Bearer <token>`.
- Comparison is timing-safe.
- If `MCP_ALLOWED_ORIGINS` is set, browser `Origin` must match allowlist.

### Confirmation nonce flow
If `MCP_REQUIRE_CONFIRMATION=true`:
1. Gated tool called without valid `confirmationNonce`.
2. Server returns `ERR_CONFIRM_REQUIRED` or `ERR_CONFIRM_INVALID` and issues a nonce.
3. Client retries same call with `confirmationNonce`.
4. Nonce must match:
   - tool name
   - session key
   - payload digest (bound to request arguments)
5. Nonce is consumed on success and expires after `MCP_CONFIRM_TTL_MS` (default 60s).

### Destructive tool exposure
- `MCP_EXPOSE_DESTRUCTIVE=false` hides destructive handlers.
- Calls to those tools return `ERR_DISABLED`.

Destructive tools:
- `plans.block`
- `plans.expire`
- `plans.execute`
- `memory.delete`

### `modules.invoke` allowlist
- Deny-by-default.
- Controlled by `MCP_ALLOW_MODULE_ACTIONS` (`module:action` or `module:*`).
- Disallowed call returns `ERR_GATED`.

## Tool Catalog

### Writing-plane tools
- `trinity.query`
- `arcanos.run`
- `trinity.query_finetune`

### Control-plane tools
These tools are explicit operational interfaces and must be invoked over MCP, not inferred from the GPT writing plane.

- `dag.*`
- `modules.list`
- `modules.invoke`
- `ops.health_report`

### Plans and agent control
- `clear.evaluate`
- `plans.create`
- `plans.list`
- `plans.get`
- `plans.approve`
- `plans.block`
- `plans.expire`
- `plans.execute`
- `plans.results`

Agents:
- `agents.register`
- `agents.list`
- `agents.get`
- `agents.heartbeat`

### DAG orchestration
- `dag.capabilities`
- `dag.run.create`
- `dag.run.get`
- `dag.run.wait`
- `dag.run.tree`
- `dag.run.node`
- `dag.run.events`
- `dag.run.metrics`
- `dag.run.errors`
- `dag.run.lineage`
- `dag.run.verification`
- `dag.run.cancel`

### RAG and research
- `rag.ingest_url`
- `rag.ingest_content`
- `rag.query`
- `research.run`

### Memory
- `memory.save`
- `memory.load`
- `memory.list`
- `memory.delete`

## Common MCP Error Codes
| Code | Meaning |
| --- | --- |
| `ERR_CONFIRM_REQUIRED` | Tool is gated and needs a confirmation nonce retry. |
| `ERR_CONFIRM_INVALID` | Nonce missing/expired/mismatched tool, session, or payload. |
| `ERR_DISABLED` | Tool disabled by deployment flags (typically destructive). |
| `ERR_GATED` | Additional policy gate failed (for example module allowlist). |
| `ERR_NOT_FOUND` | Referenced resource not found (plan/agent/etc.). |
| `ERR_INTERNAL` | Unhandled tool exception wrapped by MCP error formatter. |

## Configuration
| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_BEARER_TOKEN` | none | Required for HTTP MCP auth. |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated browser origin allowlist. |
| `MCP_HTTP_BODY_LIMIT` | `1mb` | JSON body limit for `/mcp`. |
| `MCP_REQUIRE_CONFIRMATION` | `true` | Enable nonce confirmation gate. |
| `MCP_CONFIRM_TTL_MS` | `60000` | Nonce expiration in milliseconds. |
| `MCP_EXPOSE_DESTRUCTIVE` | `false` | Expose destructive tools when true. |
| `MCP_ENABLE_SESSIONS` | `false` | Generate MCP transport session IDs in HTTP mode. |
| `MCP_ALLOW_MODULE_ACTIONS` | empty | CSV allowlist for `modules.invoke`. |

## Quick Verification (HTTP)

List tools:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list","params":{}}'
```

Call `trinity.query`:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"method\":\"tools/call\",\"params\":{\"name\":\"trinity.query\",\"arguments\":{\"prompt\":\"Health check\"}}}"
```

Create a DAG run:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"3\",\"method\":\"tools/call\",\"params\":{\"name\":\"dag.run.create\",\"arguments\":{\"goal\":\"Audit the current backend DAG path\",\"confirmationNonce\":\"<nonce-from-first-response>\"}}}"
```

Wait for a DAG run update:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"4\",\"method\":\"tools/call\",\"params\":{\"name\":\"dag.run.wait\",\"arguments\":{\"runId\":\"dagrun_123\",\"updatedAfter\":\"2026-03-07T00:00:00.000Z\",\"waitForUpdateMs\":5000}}}"
```

## Troubleshooting

- `MCP_BEARER_TOKEN not configured`
1. Set `MCP_BEARER_TOKEN`.
2. Restart process.

- `401 Unauthorized`
1. Verify exact bearer token value.
2. Check for extra whitespace.

- `403 Origin not allowed`
1. Verify browser `Origin`.
2. Add origin to `MCP_ALLOWED_ORIGINS`.

- `ERR_CONFIRM_REQUIRED` / `ERR_CONFIRM_INVALID`
1. Retry with returned `confirmationNonce`.
2. Keep same tool + argument payload.
3. Retry before TTL expires.

- `ERR_GATED` for `modules.invoke`
1. Add explicit allowlist entry to `MCP_ALLOW_MODULE_ACTIONS`.
2. Restart service after env update.

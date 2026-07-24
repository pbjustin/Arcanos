# Arcanos MCP Server

## Overview

Arcanos exposes Model Context Protocol (MCP) over two transports:

1. HTTP streamable transport: `POST /mcp` in `src/routes/mcp.ts`
2. Local stdio transport: `src/mcp/mcp-stdio.ts`

Current tool registration is split across `src/mcp/server/index.ts`, `jobTools.ts`, `controlPlaneTools.ts`, `dagTools.ts`, and `actionPlanTools.ts`.

Routing boundary:

- `POST /mcp` is the explicit MCP control-plane transport.
- `POST /gpt/:gptId` is the writing plane and never infers an MCP tool call from prompt text.
- `gpt.generate`, `trinity.query`, `arcanos.run`, and `trinity.query_finetune` are MCP tools that intentionally enter writing capabilities.
- `jobs.status` and `jobs.result` read existing GPT job state by `jobId`; they do not enter Trinity or create writing work.

## HTTP request flow

For `POST /mcp`:

1. Per-client and per-credential rate limits allow 300 requests per 15 minutes.
2. `mcpAuthMiddleware` verifies the bearer token and optional origin allowlist.
3. `buildMcpRequestContext(req)` creates request-local context, including request/trace identifiers, runtime budget, optional session ID, and an optional fixed ActionPlan requester principal.
4. A fresh MCP server and streamable HTTP transport are built for the request.
5. `runWithMcpRequestContext(...)` binds the context with `AsyncLocalStorage`.
6. The MCP SDK handles the JSON-RPC payload.

The route uses `MCP_HTTP_BODY_LIMIT` (default `1mb`), disables response caching, and rejects `GET /mcp` with `405` and `Allow: POST`.

## Stdio flow

The stdio entrypoint:

1. redirects console logging to `stderr` to protect stdout MCP frames
2. builds one stdio MCP context
3. creates the server and connects `StdioServerTransport`
4. accepts an optional session ID from `--sessionId`, `--session-id`, `MCP_SESSION_ID`, or `ARCANOS_SESSION_ID`

Requester-owned ActionPlan tools are HTTP-only and are not advertised by the stdio transport.

## Security and guardrails

### HTTP authentication and origin policy

- `MCP_BEARER_TOKEN` is mandatory for HTTP MCP.
- The request header must be `Authorization: Bearer <token>`.
- Credential comparison is timing-safe.
- If `MCP_ALLOWED_ORIGINS` is configured, a browser `Origin` must match that allowlist.

### Requester-owned ActionPlans

The safe ActionPlan catalog is registered only when all of the following are true:

- transport is authenticated HTTP
- `MCP_BEARER_TOKEN` is valid
- `ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID` is configured as the fixed requester identity bound to that bearer credential

The principal ID must begin with an alphanumeric character and contain only alphanumerics plus `.`, `_`, `:`, or `-` (maximum 128 characters).

The exposed requester-owned tools are:

- `plans.create`
- `plans.list`
- `plans.get`
- `plans.execute`
- `plans.get_execution`
- `plans.get_execution_result`

Legacy plan lifecycle tools (`plans.approve`, `plans.block`, `plans.expire`, and `plans.results`) and all `agents.*` tools are intentionally filtered from registration. Do not build clients against those hidden names.

### Confirmation nonce flow

When `MCP_REQUIRE_CONFIRMATION=true`, a confirmation-gated call follows this flow:

1. Call the tool without a nonce.
2. Receive `ERR_CONFIRM_REQUIRED` (or `ERR_CONFIRM_INVALID`) and a newly issued nonce.
3. Retry the same tool and payload with `confirmationNonce`.
4. The server verifies that the nonce matches the tool, session key, and argument digest.
5. The nonce is consumed after successful verification and expires after `MCP_CONFIRM_TTL_MS` (default 60 seconds).

Current confirmation-gated tools:

- `dag.run.create`
- `dag.run.cancel`
- `plans.execute`
- `rag.ingest_url`
- `rag.ingest_content`
- `research.run`
- `memory.save`
- `memory.delete`
- `modules.invoke`
- `ops.control_plane` when the requested operation requires approval

### Destructive exposure

`MCP_EXPOSE_DESTRUCTIVE=false` does not remove every registered tool name. Registered handlers enforce the flag when called:

- `memory.delete` returns `ERR_DISABLED`.
- approval-requiring `ops.control_plane` calls return `ERR_DISABLED`.
- `plans.execute` returns top-level `ERR_GATED` with `details.category` set to `ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED`.

Legacy destructive plan handlers are absent entirely because legacy `plans.*` registrations are filtered. `dag.run.cancel` is confirmation-gated but does not use `MCP_EXPOSE_DESTRUCTIVE`.

### `modules.invoke` allowlist

`modules.invoke` is deny-by-default and requires a matching `MCP_ALLOW_MODULE_ACTIONS` entry (`module:action` or `module:*`). The same allowlist gates GPT Access capability runs. Keep entries narrow.

## Current tool catalog

Except for the conditional HTTP-only ActionPlan tools described above, the server registers the following catalog.

### Writing tools

- `gpt.generate`
- `trinity.query`
- `arcanos.run`
- `trinity.query_finetune`

### Policy, jobs, and control plane

- `clear.evaluate`
- `jobs.status`
- `jobs.result`
- `control_plane.invoke`
- `ops.health_report`
- `ops.control_plane_capabilities`
- `ops.control_plane`

### DAG orchestration

- `dag.capabilities`
- `dag.run.create`
- `dag.run.latest`
- `dag.run.get`
- `dag.run.wait`
- `dag.run.trace`
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

### Modules

- `modules.list`
- `modules.invoke`

## Common MCP error codes

| Code | Meaning |
| --- | --- |
| `ERR_CONFIRM_REQUIRED` | The tool requires a confirmation retry. |
| `ERR_CONFIRM_INVALID` | The nonce is missing, expired, or does not match the tool/session/payload. |
| `ERR_DISABLED` | The registered operation is disabled by deployment policy. |
| `ERR_GATED` | An additional policy gate failed, such as the module/action allowlist or disabled requester-owned ActionPlan execution. Inspect `details.category` for the stable policy category. |
| `ERR_NOT_FOUND` | The referenced resource was not found. |
| `ERR_INTERNAL` | An unhandled tool exception was converted to a stable MCP error. |

For example, requester-owned `plans.execute` returns `ERR_GATED` with
`details.category: "ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED"` when destructive
exposure is disabled. The category is not a top-level MCP error code.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `MCP_BEARER_TOKEN` | none | Required for HTTP MCP authentication. Use a strong token; ActionPlan principal binding also requires it. |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated browser origin allowlist. |
| `MCP_HTTP_BODY_LIMIT` | `1mb` | JSON body limit for `/mcp`. |
| `MCP_REQUIRE_CONFIRMATION` | `true` | Enables nonce confirmation for the gated tools listed above. |
| `MCP_CONFIRM_TTL_MS` | `60000` | Nonce expiration in milliseconds. |
| `MCP_EXPOSE_DESTRUCTIVE` | `false` | Enables registered destructive/approval-requiring operations that consult this flag. |
| `MCP_ENABLE_SESSIONS` | `false` | Generates MCP transport session IDs in HTTP mode. |
| `MCP_ALLOW_MODULE_ACTIONS` | empty | CSV allowlist for `modules.invoke` and GPT Access capability runs. |
| `ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID` | none | Fixed requester ID bound to authenticated HTTP MCP; enables requester-owned ActionPlan tools. |

Keep environment defaults synchronized with `CONFIGURATION.md` and `.env.example`.

## Quick HTTP verification

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

Call `jobs.status`:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"3\",\"method\":\"tools/call\",\"params\":{\"name\":\"jobs.status\",\"arguments\":{\"jobId\":\"job_123\"}}}"
```

Create a DAG run after obtaining a nonce from the first call:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"4\",\"method\":\"tools/call\",\"params\":{\"name\":\"dag.run.create\",\"arguments\":{\"goal\":\"Audit the current backend DAG path\",\"confirmationNonce\":\"<nonce-from-first-response>\"}}}"
```

## Troubleshooting

- `MCP_BEARER_TOKEN not configured`: set the token and restart the backend.
- `401 Unauthorized`: verify the exact bearer token and remove accidental whitespace.
- `403 Origin not allowed`: add the browser origin to `MCP_ALLOWED_ORIGINS`.
- ActionPlan tools missing from `tools/list`: use HTTP, configure both bearer and requester-principal variables, and restart.
- `ERR_CONFIRM_REQUIRED` / `ERR_CONFIRM_INVALID`: retry the same tool and unchanged payload with the returned nonce before it expires.
- `ERR_GATED` from `modules.invoke`: add an exact `MCP_ALLOW_MODULE_ACTIONS` entry and restart.
- Expected legacy plan or agent tool is missing: migrate to the requester-owned plan catalog; legacy plan/agent registrations are intentionally unavailable.

## Async bridge guidance

For agent-safe asynchronous GPT retrieval over MCP:

1. Create writing work with a writing tool such as `trinity.query`.
2. Read lifecycle state with `jobs.status`.
3. Read terminal output with `jobs.result`.

Do not attempt prompt-based job retrieval through a writing tool; retrieval must remain structured by `jobId`.

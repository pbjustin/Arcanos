# GPT Fast Path

## Architecture
`POST /gpt/:gptId` now has two execution modes:

- `fast_path`: inline prompt generation for small requests that look like prompt-generation work. It bypasses job creation, worker orchestration, DAG planning, memory overlays, research overlays, and audit overlays.
- `orchestrated_path`: existing async or module-dispatch behavior for durable jobs, complex prompts, explicit actions, DAG/research/tool requests, idempotent retries, and long-running work.

The route keeps a single public endpoint so existing Custom GPT integrations do not need a new URL. The router branches internally before async job planning. Explicit async bridge actions (`query`, `query_and_wait`, `get_status`, `get_result`) always keep their current job-backed behavior; fast path is for prompt-generation requests that omit `action`.

Fast-path eligibility is implemented in `src/shared/gpt/gptFastPath.ts`. Inline execution is implemented in `src/services/gptFastPath.ts`.

## Eligibility
A request is eligible when all of these are true:

- `GPT_FAST_PATH_ENABLED` is not disabled.
- The request has a prompt.
- The prompt looks like prompt-generation work.
- If the caller explicitly sets fast mode, all other eligibility checks still apply.
- There is no explicit idempotency key.
- The action is omitted. Explicit async bridge actions stay orchestrated even if `executionMode` is `fast`.
- The request does not carry heavy fields such as `tools`, `workflow`, `dag`, `files`, `images`, `research`, or a non-empty `payload`.
- Prompt length, message count, and requested max words stay under configured limits.

Configuration:

| Variable | Default | Notes |
| --- | --- | --- |
| `GPT_FAST_PATH_ENABLED` | `true` | Set `false` to route all requests through existing orchestration. |
| `GPT_FAST_PATH_TIMEOUT_MS` | `8000` | Inline model timeout, clamped from 500ms to 20000ms. |
| `GPT_FAST_PATH_MAX_PROMPT_CHARS` | `900` | Maximum prompt size for automatic fast-path classification. |
| `GPT_FAST_PATH_MAX_MESSAGE_COUNT` | `3` | Maximum `messages[]` count. |
| `GPT_FAST_PATH_MAX_WORDS` | `350` | Maximum requested output size from `maxWords` / `max_words`. |
| `GPT_FAST_PATH_GPT_ALLOWLIST` | empty | Optional comma-separated GPT IDs allowed to use the fast path. Empty means all GPT IDs. |

## HTTP Usage
Fast path:

```bash
curl -i -X POST http://localhost:3000/gpt/arcanos-core \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Generate a prompt for a launch email.","executionMode":"fast"}'
```

Expected signals:

- HTTP `200`
- Header `x-gpt-route-decision: fast_path`
- Header `x-gpt-queue-bypassed: true`
- Body `routeDecision.path: "fast_path"`
- No `jobId`

Automatic fast path also works for small prompt-generation requests without `executionMode`:

```bash
curl -i -X POST http://localhost:3000/gpt/arcanos-core \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Generate a prompt for a launch email."}'
```

Force the orchestrated path:

```bash
curl -i -X POST http://localhost:3000/gpt/arcanos-core \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Generate a large prompt pack.","executionMode":"async"}'
```

Durable async bridge:

```bash
curl -i -X POST http://localhost:3000/gpt/arcanos-core \
  -H "Content-Type: application/json" \
  -d '{"action":"query","prompt":"Generate a large prompt pack."}'
```

## Arcanos CLI
Build the CLI first:

```bash
npm run build:packages
```

Fast mode:

```bash
node packages/cli/dist/index.js generate \
  --gpt arcanos-core \
  --prompt "Generate a prompt for a launch email." \
  --mode fast \
  --base-url http://localhost:3000
```

Orchestrated mode:

```bash
node packages/cli/dist/index.js generate \
  --gpt arcanos-core \
  --prompt "Generate a large prompt pack." \
  --mode orchestrated \
  --base-url http://localhost:3000
```

The command prints the generated text plus local latency and route details. Add `--json` for deterministic scripting output.

## MCP Usage
The MCP server exposes `gpt.generate` for fast-path prompt generation. HTTP transport example:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"fast-gpt","method":"tools/call","params":{"name":"gpt.generate","arguments":{"gptId":"arcanos-core","prompt":"Generate a prompt for a launch email.","mode":"fast"}}}'
```

Stdio transport:

```bash
npm run build
npm run mcp:stdio
```

Use the MCP client’s normal `tools/list` flow to discover `gpt.generate`.

## Railway CLI Workflow
The active Railway deployment still uses `railway.json` and `scripts/start-railway-service.mjs`. Railway CLI 4.x supports browser login via `railway login`, environment linking through `railway env`, local command execution with Railway variables through `railway run`, deployments with `railway up`, logs with `railway logs`, and variables through `railway variable` (`variables`, `vars`, and `var` are aliases).

Interactive setup:

```bash
railway login
railway link
railway status
railway env production
railway variable list --service <web-service> --environment production
```

Set fast-path variables when needed:

```bash
railway variable set GPT_FAST_PATH_ENABLED=true --service <web-service> --environment production
railway variable set GPT_FAST_PATH_TIMEOUT_MS=8000 --service <web-service> --environment production
```

Run locally with Railway-provided variables:

```bash
railway run --service <web-service> --environment production npm run dev
```

Deploy and watch logs:

```bash
npm run build
npm test -- --runTestsByPath tests/gpt-fast-path-classification.test.ts tests/gpt-fast-path.route.test.ts --coverage=false
railway up --service <web-service> --environment production
railway logs --service <web-service> --environment production
```

Smoke test after deploy:

```bash
railway run --service <web-service> --environment production npm run railway:probe:fast-path
npm run railway:probe:fast-path -- --base-url https://<your-service>.up.railway.app --gpt-id arcanos-core
npm run railway:probe:async -- --base-url https://<your-service>.up.railway.app --gpt-id arcanos-core
```

Use a project token for non-interactive CI by setting `RAILWAY_TOKEN`. Use `RAILWAY_API_TOKEN` only for account/workspace-level automation.

Railway references:
- [Railway CLI](https://docs.railway.com/cli)
- [Deploying with the CLI](https://docs.railway.com/cli/deploying)
- [railway up](https://docs.railway.com/cli/up)
- [railway variable](https://docs.railway.com/cli/variable)
- [railway login](https://docs.railway.com/cli/login)

## Observability
Every GPT route response includes route-decision headers once the request reaches the writing plane:

- `x-gpt-route-decision`
- `x-gpt-route-decision-reason`
- `x-gpt-queue-bypassed`

Structured logs include:

- `gpt.request.route_decision`
- `gpt.request.fast_path_completed`
- `gpt.request.fast_path_fallback`

Metrics include:

- `gpt_route_decisions_total{path,reason,queue_bypassed}`
- `gpt_fast_path_latency_ms{gpt_id,outcome}`

## Troubleshooting
If a request unexpectedly falls back to async, check:

- The response header `x-gpt-route-decision-reason`.
- Whether the prompt actually matches prompt-generation intent.
- Whether `executionMode` was set to `async` / `orchestrated`.
- Whether the request has `action`, non-empty `payload`, `tools`, `dag`, `files`, `research`, or other heavy fields.
- Whether an `Idempotency-Key` header was provided.
- Whether `GPT_FAST_PATH_ENABLED=false` or `GPT_FAST_PATH_GPT_ALLOWLIST` excludes the GPT ID.
- Whether prompt size, message count, or `maxWords` exceeds configured limits.
- Whether logs show `gpt.request.fast_path_fallback`, which means the classifier selected fast path but inline execution failed and the request continued through the existing orchestrated path.

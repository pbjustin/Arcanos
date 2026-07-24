# Arcanos Backend

[![CI/CD Pipeline](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml)
[![codecov](https://codecov.io/gh/pbjustin/Arcanos/branch/main/graph/badge.svg)](https://codecov.io/gh/pbjustin/Arcanos)

## Overview
Arcanos is a TypeScript/Express backend with optional workers and an optional Python CLI daemon (`daemon-python/`).

Key characteristics:
- **Responses-first OpenAI integration** (tool calling + continuation via `previous_response_id`)
- **Adapter-boundary construction** (centralized client creation, headers, resilience)
- **Shared HTTP toolkit** (`src/shared/http/`) for request context, validation, and errors
- **DB-backed async jobs** for durable GPT and worker execution
- **Schema-first protocol surface** in `packages/protocol/`
- **Railway-ready** web/worker launcher and health configuration


### Optional local daemon (Python)
The repository includes an **optional local daemon CLI** in `daemon-python/` that turns Arcanos into a personal coding assistant on your machine:
- routes module-bound daemon chat through `/gpt/arcanos-daemon`
- detects inline unified diffs in AI responses and prompts **Apply patch? [y/N]**
- detects command proposals and prompts **Run? [y/N]** (allowlisted)
- injects lightweight **repo indexing context** into backend requests
- keeps **SQLite audit/history** with backups + `/rollback`

See: `daemon-python/README.md`

### Optional CLI Bridge
`ARCANOS:CLI` is an optional protected GPT Access capability for inspecting and safely interacting with the local Python daemon. It is disabled unless `ARCANOS_CLI_BRIDGE_ENABLED=true`.

It is exposed only under `/gpt-access/capabilities/v1`; it does not route through `/gpt/:gptId` and is not a raw shell endpoint. When disabled, discovery still lists it with `enabled:false` for operator visibility. Read-only actions include `status`, `policy`, `repoContext`, `proposeCommand`, `proposePatch`, and `tailAudit`. Execution and patch application require the existing confirmation flow, the matching proposal id, and still pass shared `config/cli-policy.json` command policy, cwd sandboxing, timeout, output cap, redaction, patch safety, and daemon-side audit checks.

Start the local daemon bridge with `arcanos bridge`; it binds to `127.0.0.1` by default. Configure `ARCANOS_CLI_BRIDGE_URL`, `ARCANOS_CLI_BRIDGE_TOKEN`, `ARCANOS_CLI_SANDBOX_ROOT`, `ARCANOS_CLI_COMMAND_TIMEOUT_MS`, and `ARCANOS_CLI_OUTPUT_MAX_BYTES` as needed. Command and patch POSTs require the bridge token; keep it local and do not paste it into GPT payloads.


## Prerequisites
- Node.js 20.19.0 recommended; current dependencies require Node 20.18.1+ despite the older root `engines` floor. npm 8+.
- Optional: Python 3.10+ for daemon work in `daemon-python/`
- Optional: OpenAI API key for non-mock model calls

## Setup
```bash
npm install
cp .env.example .env
```

Use `npm install` for local development. CI and Railway use reproducible `npm ci` installs. The current Dockerfile starts from `npm ci --omit=dev` and then installs development dependencies for the image build, so treat the Dockerfile itself as the container install source of truth.

## Configuration
- Backend minimum:
  - `PORT=3000` for local `.env` usage; Railway injects `PORT`
  - `OPENAI_API_KEY=sk-...` (optional for mock-mode tests)
- Optional OpenAI request persistence:
  - `OPENAI_STORE=false`
- Railway service role:
  - `ARCANOS_PROCESS_KIND=web` on the API service
  - `ARCANOS_PROCESS_KIND=worker` on the async worker service

## Run locally
Build and start the backend:

```bash
npm run build
npm start
```

For a rebuild-and-run development cycle, use `npm run dev`. Then verify the local process with:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/health
```

See `docs/RUN_LOCAL.md` for daemon setup, the dedicated worker, focused validation, and troubleshooting.

## Deploy (Railway)
- `docs/RAILWAY_DEPLOYMENT.md`
- `docs/CI_CD.md`

## Custom GPT + GPT ID API Bridge
Custom GPT Actions should call the HTTP bridge, not Railway CLI. The runtime path is:
`Custom GPT Action -> POST /api/bridge/gpt -> direct or queued GPT execution -> /jobs/* for async polling`.

`POST /gpt/:gptId` remains the writing plane for module-bound generative work. Job-result lookups, runtime diagnostics, queue inspection, worker status, and MCP diagnostics must use direct control endpoints or `/gpt-access/*`, not prompt-shaped requests through `/gpt/:gptId`.

See `docs/gpt-access-gateway.md` for protected gateway auth/scopes, natural-language dispatch, fallback semantics, and safety/deployment notes.

Required environment:
- `OPENAI_ACTION_SHARED_SECRET` for inbound bridge auth.
- `DEFAULT_GPT_ID` as the fallback GPT ID when callers omit `gptId`.

Bridge endpoints:
- `POST /api/bridge/gpt` accepts `{ "gptId": "arcanos-core", "prompt": "...", "action": "query" | "query_and_wait", "metadata": {} }`.
- `GET /api/bridge/health` reports bridge env sanity, default GPT route reachability, database state, worker health when available, and bridge failure counters.
- Async job retrieval stays on `GET /jobs/{id}` and `GET /jobs/{id}/result`.

The Custom GPT Action OpenAPI document is `openapi/custom-gpt-bridge.yaml`.

## Troubleshooting
- `docs/TROUBLESHOOTING.md`
- Health checks: `GET /healthz` (liveness), `GET /readyz` (readiness), `GET /health` (dependency summary and Railway probe)

## References
- API catalog: `docs/API.md`
- Memory backend guide: `docs/MEMORY_BACKEND_USAGE.md`
- Workspace packages: `docs/WORKSPACE_PACKAGES.md`
- Schema/protocol changes: `docs/SCHEMA_PROTOCOL_GUIDE.md`
- Database and migrations: `docs/DATABASE_MIGRATIONS.md`
- OpenAI tooling: `docs/OPENAI_RESPONSES_TOOLS.md`
- Solo operator runtime guide: `docs/SOLO_OPERATOR_RUNTIME_GUIDE.md`
- Configuration details: `docs/CONFIGURATION.md`
- Documentation index: `docs/README.md`

## OpenAI integration map (current)
Canonical boundaries / pipelines:
- Shared TypeScript client constructor and helpers: `packages/arcanos-openai/src/client.ts`
- TypeScript OpenAI adapter boundary: `src/core/adapters/openai.adapter.ts`
- TypeScript request builders (staged): `src/services/openai/requestBuilders/`
  - `build → normalize → convert → validate`
- TypeScript call pipeline (staged): `src/services/openai/chatFlow/`
  - `prepare → execute → parse → trace`
- Shared parsing utilities: `packages/arcanos-openai/src/responseParsing.ts`
- Worker OpenAI boundary: `workers/src/infrastructure/sdk/openai.ts`
- Python daemon OpenAI adapter: `daemon-python/arcanos/openai/openai_adapter.py`

## Health endpoints
- Liveness: `GET /healthz`
- Readiness: `GET /readyz` (critical dependencies ready for traffic)
- Detailed dependency view: `GET /health` (Railway healthcheck path; includes Redis and other dependency state)

## Custom GPT bridge smoke test
Use `POST /api/bridge/gpt` with `action: "health_echo"` to verify bridge auth, request handling, queueing, worker execution, and canonical `/jobs/{id}/result` retrieval without invoking the Trinity reasoning pipeline. Use `action: "query"` or `action: "query_and_wait"` when the request must exercise real model behavior.

## OpenAI data retention
Responses requests default to **stateless** (`store: false`). You can enable storage via:
- `OPENAI_STORE=true`

More details:
- `docs/OPENAI_RESPONSES_TOOLS.md`

External SDK references:
- OpenAI Node SDK: https://github.com/openai/openai-node
- OpenAI Python SDK: https://github.com/openai/openai-python
- OpenAI API documentation: https://platform.openai.com/docs

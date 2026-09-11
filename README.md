# Arcanos Backend

[![CI/CD Pipeline](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/pbjustin/Arcanos/actions/workflows/ci-cd.yml)
[![codecov](https://codecov.io/gh/pbjustin/Arcanos/branch/main/graph/badge.svg)](https://codecov.io/gh/pbjustin/Arcanos)

## Overview
Arcanos is a TypeScript/Express backend for module-bound AI requests, durable
jobs, and protected control-plane capabilities. Its product modules include
Gaming guidance and Backstage Booker continuity/generation. An optional Python
daemon provides a local client.

Key characteristics:
- **Responses-first OpenAI integration** (tool calling + continuation via `previous_response_id`)
- **Adapter-boundary construction** (centralized client creation, headers, resilience)
- **Shared HTTP toolkit** (`src/shared/http/`) for request context, validation, and errors
- **DB-backed async jobs** for durable GPT and worker execution
- **Schema-first protocol surface** in `packages/protocol/`
- **Railway-ready** web/worker launcher and health configuration

Start with the [documentation index](docs/README.md). Users can follow
[local setup](docs/RUN_LOCAL.md) and the [API guide](docs/API.md);
contributors use [CONTRIBUTING.md](CONTRIBUTING.md), operators use the
[Railway runbook](docs/RAILWAY_DEPLOYMENT.md), and repository agents use
[AGENTS.md](AGENTS.md). These guides describe source and configuration, not a
verified live deployment. Optional integrations require their own credentials,
services, and capability-specific readiness.

### Optional local daemon (Python)
The repository includes an **optional local daemon CLI** in `daemon-python/` that turns Arcanos into a personal coding assistant on your machine:
- routes module-bound daemon chat through `/gpt/arcanos-daemon`
- detects inline unified diffs in AI responses and prompts **Apply patch? [y/N]**
- detects command proposals and prompts **Run? [y/N]** (allowlisted)
- injects lightweight **repo indexing context** into backend requests
- keeps **SQLite audit/history** with backups + `/rollback`

See the [Python daemon guide](daemon-python/README.md).

### Optional CLI Bridge
`ARCANOS:CLI` is an optional protected GPT Access capability for inspecting and safely interacting with the local Python daemon. It is disabled unless `ARCANOS_CLI_BRIDGE_ENABLED=true`.

It is exposed under `/gpt-access/capabilities/v1`, with confirmation,
proposal matching, command policy, sandboxing and daemon-side audit checks for
execution. Disabled discovery remains visible with `enabled:false`. It is not
a raw shell endpoint. See the [daemon bridge guide](daemon-python/README.md)
and [Gateway guide](docs/gpt-access-gateway.md) for actions and configuration.

Start the Python daemon bridge with `arcanos bridge`; it binds to `127.0.0.1`
by default. Keep its distinct bridge token local and out of GPT payloads. The
TypeScript CLI also installs an `arcanos` executable; see
[CLI overview](docs/CLI_OVERVIEW.md) to distinguish the two.


## Prerequisites
- Exact Node.js 24.18.1 with its bundled npm 11.16.0.
- Optional: Python 3.10+ for daemon work in `daemon-python/`
- Optional: OpenAI API key for non-mock model calls
- PostgreSQL for durable jobs and authoritative persisted data. Production web
  activation also requires Redis; the separate BullMQ/Redis runtime has its own
  setup. See [Configuration](docs/CONFIGURATION.md) for conditional requirements.

## Setup
From the repository root, for a new checkout without an existing `.env`:

```bash
npm install
cp .env.example .env
```

Use `Copy-Item .env.example .env` in PowerShell. Preserve existing configuration.
Installation contacts package registries and runs local setup hooks; see the
[local runbook](docs/RUN_LOCAL.md) before installing into an existing workspace.

Use `npm install` for local development. CI and Railway use reproducible `npm ci` installs. The current Dockerfile starts from `npm ci --omit=dev` and then installs development dependencies for the image build, so treat the Dockerfile itself as the container install source of truth.

## Configuration
- Backend minimum:
  - `PORT=3000` for local `.env` usage; Railway injects `PORT`
  - `OPENAI_API_KEY=<your-local-key>` (optional for mock-mode tests)
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

Startup can initialize database state and background work; select a local/test
target intentionally. See [RUN_LOCAL.md](docs/RUN_LOCAL.md) for daemon setup,
the dedicated worker, offline documentation checks, and troubleshooting.

## Deploy (Railway)
- [Railway deployment](docs/RAILWAY_DEPLOYMENT.md)
- [CI/CD](docs/CI_CD.md)

## Custom GPT + GPT ID API Bridge
Custom GPT Actions should call the HTTP bridge, not Railway CLI. The runtime path is:
`Custom GPT Action -> POST /api/bridge/gpt -> direct or queued GPT execution -> capability-bound /jobs/* async polling`.

`POST /gpt/:gptId` remains the writing plane for module-bound generative work. Job-result lookups, runtime diagnostics, queue inspection, worker status, and MCP diagnostics must use direct control endpoints or `/gpt-access/*`, not prompt-shaped requests through `/gpt/:gptId`.

See [GPT Access](docs/gpt-access-gateway.md) for protected gateway auth/scopes,
natural-language dispatch, fallback semantics, and safety notes. The bridge is
documented in [API](docs/API.md) and
[its OpenAPI contract](openapi/custom-gpt-bridge.yaml).

The bridge authenticates with `OPENAI_ACTION_SHARED_SECRET` and needs a distinct
server-side `ARCANOS_JOB_READ_CAPABILITY_SECRET` for job-backed responses.
The response returns a job-specific token for exactly one
`x-arcanos-job-read-token` header on `/jobs/*` reads. Keep signing keys
server-side and tokens out of URLs, logs and prompts. Rotation, response shapes,
and `DEFAULT_GPT_ID` fallback are documented in the linked guides.

The read capability alone never authorizes cancellation: cancellation also
requires confirmation and the creation surface's authenticated owner.
Anonymous public GPT jobs are intentionally non-cancellable. These generic
job rules must not be assumed to provide the same ownership checks on every
MCP or Gateway surface; see the authorization limitations in [API](docs/API.md).

## Troubleshooting
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- Health checks: `GET /healthz` and `GET /health` (public registry/lifecycle snapshots), and `GET /readyz` (activation readiness and the Railway deployment probe)

## References
- [API catalog](docs/API.md), [configuration](docs/CONFIGURATION.md), and [memory](docs/MEMORY_BACKEND_USAGE.md)
- [Workspace packages](docs/WORKSPACE_PACKAGES.md) and [schema/protocol changes](docs/SCHEMA_PROTOCOL_GUIDE.md)
- [Database and migrations](docs/DATABASE_MIGRATIONS.md) and [solo operator guide](docs/SOLO_OPERATOR_RUNTIME_GUIDE.md)
- [OpenAI tooling](docs/OPENAI_RESPONSES_TOOLS.md) and the complete [documentation index](docs/README.md)

## OpenAI integration map (current)
The shared constructor lives in `packages/arcanos-openai/src/client.ts`; the
backend adapter is `src/core/adapters/openai.adapter.ts`. Request construction
and execution are staged under `src/services/openai/`. The
[OpenAI guide](docs/OPENAI_RESPONSES_TOOLS.md) maps the worker and Python
boundaries, model precedence, parsing, tool continuation, and retention.

## Health endpoints
- Public health: `GET /healthz` and `GET /health` use the same handler in the
  normal app. Its status is 200 when required GPT registrations are present,
  otherwise 503; the body includes startup and Redis lifecycle snapshots.
- Activation readiness: `GET /readyz` checks the configured critical dependencies.

The public health handlers are registered before the separate health router;
they do not run that router's active dependency checks. See [API](docs/API.md)
for the effective routes and [startup resilience](docs/STARTUP_RESILIENCE.md).

Health success does not establish completed Notion synchronization, fresh
Gaming evidence, protected-operation eligibility, or end-to-end correctness.

## Custom GPT bridge smoke test
This is an active, job-creating operation against an explicitly authorized
target, not an offline documentation check.

Use `POST /api/bridge/gpt` with `action: "health_echo"` to verify bridge auth,
request handling, queueing, worker execution, and canonical
`/jobs/{id}/result` retrieval without invoking the Trinity reasoning pipeline.
Retain the returned job-read capability for that retrieval. Use
`action: "query"` or `action: "query_and_wait"` when the request must exercise
real model behavior.

## OpenAI data retention
The backend request builder and ask tool loop default to `store: false`.
`OPENAI_STORE=true` enables storage only in callers that consult that setting;
some sensitive paths force it off and some portable helpers omit the field.
This does not disable Arcanos's own logs, memory, or durable job storage.

More details: [OpenAI Responses and tools](docs/OPENAI_RESPONSES_TOOLS.md).

External SDK references:
- OpenAI Node SDK: https://github.com/openai/openai-node
- OpenAI Python SDK: https://github.com/openai/openai-python
- OpenAI API documentation: https://platform.openai.com/docs

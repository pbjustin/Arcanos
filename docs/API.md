# API Guide

## Overview
This is the current API catalog for routes mounted by `src/routes/register.ts`, `src/routes/healthGroup.ts`, and `src/routes/api/index.ts`. Route behavior is sensitive to mount order when duplicate paths exist.

## Prerequisites
- Backend running locally or on Railway.
- JSON client (curl/Postman/SDK).
- For protected routes, confirmation headers or trusted automation settings.

## Setup
Start the backend:
```bash
npm run build
npm start
```

Base URLs:
- Local: `http://localhost:3000`
- Railway: `https://<your-service>.up.railway.app`

## Configuration
Confirmation gate behavior (`src/middleware/confirmGate.ts`):
- Manual: `x-confirmed: yes`
- Challenge retry: `x-confirmed: token:<challengeId>`
- Trusted GPT: `x-gpt-id` + configured `TRUSTED_GPT_IDS`
- Automation secret: configured header (default `x-arcanos-automation`)

## Run locally
Quick probes:
```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/ask -H "Content-Type: application/json" -d '{"message":"hello"}'
```

## Deploy (Railway)
No API path changes are required for Railway. Ensure health (`/health`) and confirmation-gated flows are validated after deploy.

## Troubleshooting
- 403 with `CONFIRMATION_REQUIRED`: use confirmation flow headers.
- 503 from AI routes: check OpenAI key config and upstream status.
- 404 on expected route: verify method and mounted path prefix.

## References
- Route registry: `../src/routes/register.ts`
- API mount index: `../src/routes/api/index.ts`
- Validation and auth middleware: `../src/middleware/confirmGate.ts`

## Active Endpoint Groups

### Core health and status
- `GET /`
- `GET /health`
- `GET /healthz`
- `GET /readyz`
- `GET /railway/healthcheck`
- `GET /status`
- `POST /status` (confirmation required)
- `POST /heartbeat` (confirmation required)
- `GET /api/test`
- `GET /api/fallback/test`

### Core AI interaction
- `GET|POST /ask`
- `GET|POST /brain` (confirmation required)
- `POST /arcanos` (confirmation required)
- `POST /arcanos-pipeline`
- `POST /arcanos-query`
- `POST /siri` (confirmation required)
- `POST /api/ask`
- `POST /api/arcanos/ask` (confirmation required)
- `POST /api/ask-hrc`

### AI utility and media
- `POST /write` (confirmation required)
- `POST /guide` (confirmation required)
- `POST /audit` (confirmation required, primary handler from `ai-endpoints.ts`)
- `POST /sim` (confirmation required)
- `POST /image`
- `POST /api/vision`
- `POST /api/transcribe`
- `GET /api/openai/status`
- `POST /api/openai/prompt`

### Memory, codebase, and reusable code
- `GET /api/memory/health`
- `POST /api/memory/save` (confirmation required)
- `GET /api/memory/load`
- `DELETE /api/memory/delete` (confirmation required)
- `GET /api/memory/list`
- `GET /api/memory/view`
- `POST /api/memory/bulk` (confirmation required)
- `POST /memory/resolve`
- `GET /api/codebase/tree`
- `GET /api/codebase/file`
- `POST /api/reusables`
- `GET /api/reusables/health`

### Workers, orchestration, and DevOps
- `GET /workers/status`
- `POST /workers/heal` (confirmation required)
- `POST /workers/run/:workerId` (confirmation required)
- `POST /orchestration/reset` (confirmation required)
- `GET /orchestration/status`
- `POST /orchestration/purge` (confirmation required)
- `POST /devops/self-test`
- `POST /devops/daily-summary`

### Research, RAG, and command routing
- `GET /api/commands`
- `GET /api/commands/health`
- `POST /api/commands/execute` (confirmation required)
- `POST /commands/research` (confirmation required)
- `POST /sdk/research` (confirmation required)
- `POST /rag/fetch`
- `POST /rag/save`
- `POST /rag/query`

### Daemon, debug, and registry paths
- `POST /api/daemon/heartbeat` (daemon auth required)
- `GET /api/daemon/commands` (daemon auth required)
- `POST /api/daemon/commands/ack` (daemon auth required)
- `POST /api/daemon/confirm-actions` (daemon auth required)
- `GET /api/daemon/registry` (daemon auth required)
- `POST /api/update` (public validation path; daemon-auth variant also exists)
- `POST /debug/create-confirmation-token` (automation secret required)
- `POST /debug/consume-confirm-token` (automation secret required)
- `ALL /bridge-status`, `/bridge`, `/bridge/handshake`, `/ipc`, `/ipc/handshake`, `/ipc/status`
- `GET /registry`
- `GET /registry/:moduleName`
- `POST /queryroute`
- `POST /modules/:moduleRoute` (dynamic module route from runtime module loader)
- `ANY /gpt/:gptId` (forwarded to module route via `gptRouter.ts`)

### API submodules mounted under `/api`
- `GET /api/assistants`
- `POST /api/assistants/sync`
- `GET /api/assistants/:name`
- `POST /api/sim`
- `GET /api/sim/health`
- `GET /api/sim/examples`
- `POST /api/afol/decide`
- `GET /api/afol/health`
- `GET /api/afol/logs`
- `GET /api/afol/analytics`
- `POST /api/pr-analysis/webhook`
- `POST /api/pr-analysis/analyze`
- `GET /api/pr-analysis/health`
- `GET /api/pr-analysis/schema`

### SDK routes mounted under `/sdk`
- `POST /sdk/workers/init` (confirmation required)
- `GET /sdk/workers/status`
- `POST /sdk/routes/register` (confirmation required)
- `POST /sdk/scheduler/activate` (confirmation required)
- `POST /sdk/jobs/dispatch` (confirmation required)
- `POST /sdk/test-job` (confirmation required)
- `POST /sdk/init-all` (confirmation required)
- `GET /sdk/diagnostics`
- `POST /sdk/system-test` (confirmation required)

## TODO (verified route-order ambiguities)
- `POST /audit` is defined in multiple routers; current mount order means AI utility handling executes first.
- `POST /api/update` has a public route and a daemon-authenticated route; current mount order executes the public route first.
- `GET /health` is defined in multiple routers; health-group handler executes first because it is mounted before reinforcement and status routes.
- `/api/reusables*` routes are mounted both through `api/index.ts` and directly in `register.ts`; first matching handler responds and the second mount is effectively redundant.

# Configuration Guide

## Overview
This document captures active backend and daemon configuration used by current code. Defaults and precedence are derived from `src/platform/runtime/unifiedConfig.ts`, `src/platform/runtime/env.ts`, compatibility re-exports under `src/config/`, and daemon config modules.

## Prerequisites
- Copy `.env.example` to `.env` for backend.
- Copy `daemon-python/.env.example` to `daemon-python/.env` for daemon usage.

## Setup
Backend:
```bash
cp .env.example .env
```

Daemon:
```bash
cd daemon-python
cp .env.example .env
```

## Configuration
### Backend required and core variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PORT` | No locally; Railway-managed in deploys | direct server `3000`; validation fallback `8080` | `.env.example` sets `3000`. Railway injects `PORT`; do not hard-code it in Railway Variables. |
| `NODE_ENV` | No | `development` | Affects host binding and runtime behavior. |
| `OPENAI_API_KEY` | No* | none | Needed for live AI responses. |
| `OPENAI_BASE_URL` | No | none | Optional OpenAI endpoint override. |
| `OPENAI_MODEL` | No | fallback chain | Participates in default model resolution chain. |
| `DATABASE_URL` | No | none | Enables PostgreSQL persistence. |
| `REDIS_URL` | No | none | Preferred Redis connection string; discrete `REDISHOST`/`REDISPORT`/`REDISUSER`/`REDISPASSWORD` are fallback inputs. |
| `ARCANOS_GPT_ACCESS_TOKEN` | Yes for `/gpt-access/*` | none | Bearer token for the protected GPT access gateway. Store real values only in runtime variables or GPT Action auth. |
| `ARCANOS_GPT_ACCESS_SCOPES` | Yes for `/gpt-access/jobs/create` | all scopes except `jobs.create` is denied unless explicit | Comma-separated gateway scope allowlist. Include `jobs.create` and `jobs.result` for protected async Trinity execution. |
| `ARCANOS_PROCESS_KIND` | Yes for Railway launcher | none | Must be `web` or `worker` when using `scripts/start-railway-service.mjs`; omit for direct local `npm start`. |
| `RUN_WORKERS` | No | `true` (non-test) | Local/direct background worker toggle. Ignored by Railway launcher role selection when `ARCANOS_PROCESS_KIND` is set. |
| `WORKER_API_TIMEOUT_MS` | No | `30000` | Unified config default; some worker adapters fallback to `60000` if unset. |
| `ARC_LOG_PATH` | No | `/tmp/arc/log` | Runtime log path. |
| `ARC_MEMORY_PATH` | No | `/tmp/arc/memory` | Runtime memory path. |
| `RAILWAY_ENVIRONMENT` | No | none | Set by Railway and used for environment detection. |
| `RAILWAY_API_TOKEN` | No | none | Only required for Railway management/API tooling, not normal app runtime. |

`OPENAI_API_KEY` is optional for startup because the API can return mock responses in non-live paths, but live AI behavior and the dedicated worker require a valid key.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Controls logging and worker defaults. |
| `PORT` | `3000` direct server / `8080` validation fallback | `src/server.ts` binds `process.env.PORT || 3000`; `environmentValidation.ts` backfills missing `PORT` with `8080` during startup validation. Prefer setting `PORT=3000` locally. Railway supplies the live port. |
| `HOST` | `127.0.0.1` (dev) / `0.0.0.0` (prod) | Bind address for the HTTP server. In development, defaults to localhost for security. Set to `0.0.0.0` to allow network access (e.g., Docker, WSL2, testing from other devices). |
| `SERVER_URL` | `http://127.0.0.1:<port>` | Base URL used for internal callbacks. |
| `BACKEND_STATUS_ENDPOINT` | `/status` | Status endpoint path for internal checks. |
| `LOG_LEVEL` | `info` | Logging verbosity for the structured logger. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Directory for logs and audit output. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem cache for memory snapshots. |
| `JSON_LIMIT` | `10mb` | JSON payload size limit. |
| `REQUEST_TIMEOUT` | `30000` | Request timeout in milliseconds. |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS allow list (non-development). |

### OpenAI API key resolution

*Without an API key, AI routes return mock responses by design.*

The OpenAI client resolves keys in this order:

### OpenAI key resolution order
1. `OPENAI_API_KEY`
2. `RAILWAY_OPENAI_API_KEY`
3. `API_KEY`
4. `OPENAI_KEY`

### Default model resolution order
1. `FINETUNED_MODEL_ID`
2. `FINE_TUNED_MODEL_ID`
3. `AI_MODEL`
4. `OPENAI_MODEL`
5. `RAILWAY_OPENAI_MODEL`
6. `gpt-4.1-mini`

### Fallback model resolution order
1. `FALLBACK_MODEL`
2. `AI_FALLBACK_MODEL`
3. `RAILWAY_OPENAI_FALLBACK_MODEL`
4. `FINETUNED_MODEL_ID`
5. `FINE_TUNED_MODEL_ID`
6. `gpt-4.1`

### Confirmation and automation
| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUSTED_GPT_IDS` | empty | Trusted GPT IDs that can bypass manual confirmation. |
| `ARCANOS_AUTOMATION_SECRET` | empty | Shared secret for automation bypass. |
| `ARCANOS_AUTOMATION_HEADER` | `x-arcanos-automation` | Header carrying automation secret. |
| `ASK_ROUTE_MODE` | `gone` | Legacy ask-style migration switch. Set `compat` only while temporarily supporting old `/brain` callers. |

### Railway service role
| Variable | Required | Purpose |
| --- | --- | --- |
| `ARCANOS_PROCESS_KIND=web` | Railway web service | Starts the compiled API runtime with `RUN_WORKERS=false` through `scripts/start-railway-service.mjs`. |
| `ARCANOS_PROCESS_KIND=worker` | Railway worker service | Starts `dist/workers/jobRunner.js` and exposes a minimal health server on `/health`, `/healthz`, and `/readyz`. |

If `ARCANOS_PROCESS_KIND` is missing or not `web`/`worker`, the Railway launcher exits with a fatal startup error by design.

### GPT access and Trinity async execution
Protected GPT Action and operator calls must use `/gpt-access/*` for backend operations. Do not ask `/gpt/:gptId` to inspect runtime state, read queue/job results, call MCP tools, or proxy protected backend actions.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ARCANOS_GPT_ACCESS_TOKEN` | Yes for `/gpt-access/*` | none | Gateway bearer token. The gateway returns an auth/config error when this is missing. |
| `ARCANOS_GPT_ACCESS_SCOPES` | Yes for job creation | all recognized scopes are granted when unset, except `jobs.create` remains denied unless explicitly listed | Scope allowlist. Use `runtime.read,workers.read,queue.read,jobs.create,jobs.result,diagnostics.read` for the minimal protected async Trinity flow. |
| `OPENAI_API_KEY` | Yes for live worker execution | none | Preferred OpenAI key setting. The config layer also supports the fallback key names listed above. |
| `DATABASE_URL` or complete `PG*` set | Yes for durable async jobs | none | Required by `/gpt-access/jobs/create` persistence and by the worker queue. Web and worker services must share the same database. |
| `JOB_WORKER_ID` | No | `async-queue` | Base worker identity for queue claims, logs, and heartbeat state. |
| `JOB_WORKER_STATS_ID` | No | `JOB_WORKER_ID` | Stable aggregate identity for worker inspection. |
| `JOB_WORKER_CONCURRENCY` | No | `WORKER_COUNT` or `1` | Number of queue-consumer slots in one worker process. |
| `WORKER_TRINITY_RUNTIME_BUDGET_MS` | No | `420000` | Max worker Trinity runtime budget. |
| `WORKER_TRINITY_STAGE_TIMEOUT_MS` | No | `180000` | Per-stage/model timeout passed from worker-originated Trinity calls. |
| `PLANNER_TIMEOUT_MS` | No | `WORKER_TRINITY_STAGE_TIMEOUT_MS` | Planner DAG node timeout. |
| `PLANNER_MAX_RETRIES` | No | `2` | Planner retry count after the first attempt. |
| `PLANNER_RETRY_BACKOFF_MS` | No | `1000` | Planner retry backoff base. |
| `ARCANOS_CORE_BACKGROUND_HANDLER_TIMEOUT_MS` | No | background profile default | Handler timeout for background `ARCANOS:CORE` execution. |
| `ARCANOS_CORE_BACKGROUND_PIPELINE_TIMEOUT_MS` | No | `120000` | Primary Trinity timeout for background `ARCANOS:CORE` execution, clamped by code. |
| `ARCANOS_CORE_BACKGROUND_DEGRADED_HEADROOM_MS` | No | background profile default | Time reserved for degraded fallback after a background pipeline timeout. |
| `TRINITY_DAG_GPT_ACCESS_ENABLED` | No | auto-enabled only when worker slots are greater than `DAG_MAX_CONCURRENT_NODES` | Routes queued DAG node execution through `/gpt-access/jobs/create` and `/gpt-access/jobs/result`. Set `true` only with `JOB_WORKER_CONCURRENCY` or `WORKER_COUNT` at least `DAG_MAX_CONCURRENT_NODES + 1`; unsafe forced routing fails clearly instead of risking nested queue deadlock. Set `false` for local legacy direct-worker debugging. |
| `GPT_MODULE_MAP` | No | auto-discovered module definitions | JSON override/extension for GPT ID to module bindings. |

Protected async Trinity flow:
1. `POST /gpt-access/jobs/create` validates bearer auth and the `jobs.create` scope.
2. The gateway writes one durable `gpt` job and returns `jobId`.
3. The worker claims the job, calls the GPT dispatcher in-process, and routes `arcanos-core` to `ARCANOS:CORE`.
4. `ARCANOS:CORE` calls `runTrinityWritingPipeline(...)`, which rejects control-plane leakage before `runThroughBrain(...)`.
5. The worker stores terminal output and protected clients poll `POST /gpt-access/jobs/result`.

Queued Trinity DAG nodes use `src/services/trinity/adapter.ts` to create and poll Arcanos core GPT jobs through the same GPT Access job path. The adapter accepts injected config/dependencies for tests and non-Railway runtimes; production code reads the role toggle from `TRINITY_DAG_GPT_ACCESS_ENABLED` and otherwise only auto-enables when worker slots exceed `DAG_MAX_CONCURRENT_NODES`, preserving at least one slot for child GPT jobs.

Use `docs/TRINITY_PIPELINE.md` for the full execution flow and `docs/gpt-access-gateway.md` for curl examples.

### Dedicated job runner
| Variable | Default | Purpose |
| --- | --- | --- |
| `JOB_WORKER_ID` | `async-queue` | Base worker identity used in logs, heartbeats, and queue claiming. |
| `JOB_WORKER_STATS_ID` | `JOB_WORKER_ID` | Stable stats/inspection identity. |
| `JOB_WORKER_CONCURRENCY` | `WORKER_COUNT` or `1` | Number of queue-consumer slots in one worker process. |
| `JOB_WORKER_POLL_MS` | `250` | Poll delay after a claimed job cycle. |
| `JOB_WORKER_IDLE_BACKOFF_MS` | `1000` | Sleep interval when no job is available. |
| `JOB_WORKER_DB_BOOTSTRAP_RETRY_MS` | `5000` | Initial retry delay while waiting for database connectivity. |
| `JOB_WORKER_DB_BOOTSTRAP_MAX_RETRY_MS` | `30000` | Max DB bootstrap retry delay. |
| `JOB_WORKER_DB_BOOTSTRAP_MAX_ATTEMPTS` | `0` | `0` means retry indefinitely. |

### Self reflections and judged feedback
| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCANOS_CONTEXT_MODE` | `reinforcement` | Enables/disables contextual reinforcement recording (`off` disables storage in memory context window). |
| `ARCANOS_CONTEXT_WINDOW` | `50` | Maximum in-memory reinforcement entries retained. |
| `ARCANOS_MEMORY_DIGEST_SIZE` | `8` | Context digest length used in system prompt reinforcement section. |
| `ARCANOS_CLEAR_MIN_SCORE` | `0.85` | Minimum normalized score threshold for judged acceptance. |
| `TRINITY_JUDGED_FEEDBACK_ENABLED` | `true` | Enables automatic judged feedback writes from Trinity CLEAR audit output. |
| `TRINITY_JUDGED_ALLOWED_ENDPOINTS` | `*` | Comma-separated source-endpoint allowlist for auto-judged feedback (`*` allows all). |
| `JUDGED_FEEDBACK_CACHE_MAX_ENTRIES` | `2000` | Maximum entries retained in judged idempotency cache. |

### MCP server
| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_BEARER_TOKEN` | none | Required bearer token for `POST /mcp`. |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated browser origin allowlist for MCP HTTP requests. |
| `MCP_HTTP_BODY_LIMIT` | `1mb` | JSON body size limit for MCP transport route. |
| `MCP_REQUIRE_CONFIRMATION` | `true` | Require nonce confirmation for gated MCP tools. |
| `MCP_CONFIRM_TTL_MS` | `60000` | Nonce expiration window for MCP confirmation flow. |
| `MCP_EXPOSE_DESTRUCTIVE` | `false` | Expose destructive MCP tools when set to true. |
| `MCP_ENABLE_SESSIONS` | `false` | Enable transport session ID generation in MCP HTTP transport. |
| `MCP_ALLOW_MODULE_ACTIONS` | empty | CSV allowlist controlling `modules.invoke` (`module:action` or `module:*`). |

### Metrics
| Variable | Default | Purpose |
| --- | --- | --- |
| `METRICS_ENABLED` | enabled unless `false` | Controls `GET /metrics`. |
| `METRICS_AUTH_TOKEN` | none | Optional bearer or `x-metrics-token` secret for `GET /metrics`; no token means the metrics endpoint is public. |

### Daemon-specific core variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Required only when using local OpenAI routing. |
| `BACKEND_URL` | none | Backend routing target (recommended for `arcanos-daemon`). |
| `BACKEND_TOKEN` | none | Optional bearer token for backend auth. |
| `BACKEND_GPT_ID` | `arcanos-daemon` | Identifies the daemon to the backend for `/gpt/:gptId` routing and optional `x-gpt-id` auth metadata. |
| `BACKEND_ALLOW_GPT_ID_AUTH` | `false` | If true, daemon may authenticate via `x-gpt-id` without a bearer token (backend must allow). |
| `BACKEND_ROUTING_MODE` | `hybrid` | `local`, `backend`, or `hybrid`. |
| `AGENTIC_ENABLED` | `true` | Enables multi-step reasoning loop (ask → propose → approve → apply/run → continue). |
| `AGENT_MAX_STEPS` | `6` | Max loop iterations per user request. |
| `REPO_INDEX_ENABLED` | `true` | Enables lightweight repo indexing context injection. |
| `REPO_INDEX_MAX_FILES` | `800` | Upper bound for indexed file count. |
| `REPO_INDEX_MAX_CHARS` | `50000` | Upper bound for serialized context payload size. |
| `HISTORY_DB_PATH` | `history.db` | SQLite file for messages/patch/command history and audit. |
| `PATCH_BACKUP_DIR` | `patch_backups` | Directory used for backup snapshots (rollback support). |
| `PATCH_TOKEN_START` | `---patch.start---` | Optional explicit patch block delimiter recognized by the CLI. |
| `PATCH_TOKEN_END` | `---patch.end---` | Optional explicit patch block delimiter recognized by the CLI. |
| `AUTOMATIONS_FILE` | `automations.toml` | TOML file containing local automation recipes (`/auto`). |
| `DEBUG_SERVER_TOKEN` | none | Strongly recommended when debug server enabled. |
| `IDE_AGENT_DEBUG` / `DEBUG_SERVER_ENABLED` | `false` | Enables local debug server. |

## Run locally
Backend config validation is implicit at startup. Use:
```bash
npm run build
npm start
```

Daemon config validation occurs on daemon startup:
```bash
cd daemon-python
arcanos
```

## Deploy (Railway)
- Keep required runtime values in Railway Variables.
- Keep production and development variables separated.
- Railway injects `PORT` and optionally `DATABASE_URL` when PostgreSQL is attached.
- Set `ARCANOS_PROCESS_KIND=web` on the web service and `ARCANOS_PROCESS_KIND=worker` on the worker service.

## Troubleshooting
- Local server uses an unexpected port: set `PORT=3000` in `.env` explicitly.
- Railway launcher fatal startup error: set `ARCANOS_PROCESS_KIND` to `web` or `worker` on that service.
- Unexpected model in use: verify model precedence chain and remove conflicting variables.
- Confirmation bypass not working: verify header name and secret match exactly.

## Generated Directories

These directories are created at runtime or during builds and must **not** be committed. All are listed in `.gitignore`.

| Directory | Generated by | Purpose |
| --- | --- | --- |
| `dist/` | `npm run build` | Compiled TypeScript output |
| `node_modules/` | `npm install` | Node.js dependencies |
| `coverage/` | `npm test` / `pytest --cov` | Test coverage reports |
| `logs/` | Runtime | Application and audit logs |
| `backups/` | `scripts/backup.ps1` | Workspace backups |
| `dist_new/` | Legacy build scripts | Deprecated build artifacts |
| `converge-artifacts/` | `npm run converge:ci` | CI convergence gate output |
| `**/.pytest_cache/` | pytest | Python test cache |

## References
- `../.env.example`
- `../config/env/core.env.example`
- `../src/platform/runtime/unifiedConfig.ts`
- `../src/platform/runtime/env.ts`
- `../daemon-python/.env.example`


## OpenAI data retention
- `OPENAI_STORE` (default: `false`)
  - When `true`, Responses requests will be created with `store: true`.
  - When `false`, Responses requests use `store: false` (stateless / no retention).

## Daemon tool result continuation
These control how long the backend waits for the daemon to report tool results before continuing the model response:
- `DAEMON_RESULT_WAIT_MS` (default: `8000`)
- `DAEMON_RESULT_POLL_MS` (default: `250`)

## Complete environment variable reference
This table mirrors the highest-impact runtime keys in `.env.example`. Use `.env.example` for the current operator template and update this section when a new deploy-relevant variable is added.
| Variable | Default (example) | Purpose |
|---|---:|---|
| `PORT` | `3000` | HTTP port the server binds to. |
| `NODE_ENV` | `development` | Runtime mode. |
| `OPENAI_API_KEY` | `your-openai-api-key-here` | OpenAI API key used by server/runtime. |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Default model name. |
| `ARCANOS_BACKEND_URL` | `http://127.0.0.1:3000` (commented) | Backend base URL used by CLI/scripts before fallback variables. |
| `OPENAI_ACTION_SHARED_SECRET` | `replace-with-a-strong-shared-secret` | Shared secret for `/api/bridge/gpt`. |
| `ARCANOS_GPT_ACCESS_TOKEN` | commented placeholder | Bearer token for `/gpt-access/*`; real values must not be committed or logged. |
| `ARCANOS_GPT_ACCESS_SCOPES` | commented full scope list | Gateway scope allowlist. `jobs.create` must be explicit for protected async job creation. |
| `DEFAULT_GPT_ID` | `arcanos-core` | Default GPT id for bridge requests that omit `gptId`. |
| `ARCANOS_PROCESS_KIND` | `web` (commented) | Explicit Railway launcher role: `web` or `worker`. |
| `ALLOW_MOCK_FALLBACK` | `false` | Allow fallback to mocked providers in non-prod. |
| `BUDGET_DISABLED` | `false` | Disable runtime budget enforcement (not recommended in prod). |
| `WATCHDOG_LIMIT_MS` | `120000` | Hard watchdog limit for long-running operations. |
| `SAFETY_BUFFER_MS` | `2000` | Safety buffer subtracted from watchdog to stop early. |
| `TRINITY_BASE_SOFT_CAP_MS` | `60000` | Base soft cap for Trinity-mode calls. |
| `TRINITY_MULT_SIMPLE` | `1.0` | Multiplier for simple Trinity calls. |
| `TRINITY_MULT_COMPLEX` | `1.4` | Multiplier for complex Trinity calls. |
| `TRINITY_MULT_CRITICAL` | `1.8` | Multiplier for critical Trinity calls. |
| `RAILWAY_API_TOKEN` | `` | Railway API token used by optional automation/ops routes. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Filesystem path for logs (if file logging enabled). |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem path for memory persistence. |
| `RUN_WORKERS` | `true` | Whether to run background workers in this process. |
| `WORKER_API_TIMEOUT_MS` | `60000` | Timeout for worker-to-server API calls. |
| `JOB_WORKER_ID` | `async-queue` (commented) | Dedicated worker identity. |
| `JOB_WORKER_CONCURRENCY` | `1` (commented) | Queue-consumer slots per worker process. |
| `JOB_WORKER_POLL_MS` | `250` (commented) | Worker polling delay after claim cycles. |
| `WORKER_TRINITY_RUNTIME_BUDGET_MS` | `420000` (code default) | Worker Trinity runtime budget. |
| `WORKER_TRINITY_STAGE_TIMEOUT_MS` | `180000` (code default) | Worker Trinity stage/model timeout. |
| `TRINITY_DAG_GPT_ACCESS_ENABLED` | unset in `.env.example`; code auto-enables only when worker slots exceed `DAG_MAX_CONCURRENT_NODES` if unset | Queue DAG node prompts through GPT Access job creation/result polling. |
| `REDIS_URL` | `redis://localhost:6379` (commented) | Preferred Redis connection string. |
| `SAFETY_HEARTBEAT_TIMEOUT_MS` | `15000` | Worker heartbeat timeout window. |
| `SAFETY_HEARTBEAT_MISS_THRESHOLD` | `3` | Missed heartbeats before marking unhealthy. |
| `SAFETY_HEALTHY_CYCLES_TO_RECOVER` | `3` | Healthy cycles required to recover from unhealthy state. |
| `SAFETY_QUARANTINE_COOLDOWN_MS` | `120000` | Cooldown after quarantining before recovery. |
| `SAFETY_WORKER_RESTART_THRESHOLD` | `5` | Restart threshold within the restart window. |
| `SAFETY_WORKER_RESTART_WINDOW_MS` | `300000` | Window for counting worker restarts. |
| `DISPATCH_V9_POLICY_TIMEOUT_MS` | `5000` | Timeout for dispatch policy evaluation. |
| `SAFETY_FAIL_CLOSED_INTEGRITY` | `true` | Fail closed when integrity checks cannot be satisfied. |
| `OPENAI_STORE` | `false` | If true, allow OpenAI to store Responses; default false (stateless). |
| `MCP_BEARER_TOKEN` | commented placeholder | Required for `POST /mcp`. |
| `METRICS_AUTH_TOKEN` | commented empty | Optional token for `GET /metrics`. |
| `ASK_ROUTE_MODE` | `gone` (commented) | Legacy `/brain` migration switch. |
| `DAEMON_RESULT_WAIT_MS` | `8000` | How long (ms) to poll for daemon command results before continuing without them. |
| `DAEMON_RESULT_POLL_MS` | `250` | Poll interval (ms) when waiting for daemon results. |

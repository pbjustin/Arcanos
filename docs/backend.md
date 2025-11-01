# 🧠 Arcanos Backend Documentation

This guide documents how the Arcanos backend is assembled, configured, and operated. The codebase is a TypeScript service that compiles to `dist/` and runs on Node.js ≥ 18 using Express, OpenAI's SDK v5, and a modular persistence layer.

---

## 🚀 Quick Start

1. Install dependencies
   ```bash
   npm ci
   ```
2. Compile TypeScript
   ```bash
   npm run build
   ```
3. Launch the server (auto-selects a free port when the preferred port is busy)
   ```bash
   npm start            # alias for node dist/start-server.js
   ```

The runtime entry point (`src/start-server.ts`) calls `startServer()` from `src/server.ts`. The build output lives in `dist/` (see `package.json` scripts and `tsconfig.json`).

---

## 🏗️ Runtime Architecture

### Startup pipeline
When `startServer()` runs, the following lifecycle executes:

1. **`performStartup()`** (`src/startup.ts`)
   - Validates environment variables and filesystem expectations for Railway deployments (`utils/envValidation.ts`).
   - Applies environment security policies before anything else (`utils/environmentSecurity.ts`).
   - Initializes the database connection and falls back to in-memory mode if a database is unavailable (`db/index.ts`).
   - Boots the memory store (`memory/store.ts`) and verifies persistence schemas (`persistenceManagerHierarchy.ts`).
   - Validates the configured OpenAI API key and logs the selected model (`services/openai.ts`).

2. **`createApp()`** (`src/app.ts`)
   - Creates the Express instance with CORS, JSON body parsing, structured logging, and diagnostics middleware.
   - Installs OpenAI clients on `app.locals` via `init-openai.ts`.
   - Registers every route bundle through `routes/register.ts` and installs fallback/error middleware.

3. **Port selection & worker bootstrap** (`src/server.ts`)
   - Resolves a preferred port from `PORT`/`HOST` with automatic fallback using `utils/portUtils.ts`.
   - Calls `initializeWorkers()` (`utils/workerBoot.ts`) to load optional background workers located in `workers/` (skipped when the directory is absent or `RUN_WORKERS` is false).
   - Logs a boot summary including active models, worker status, and health endpoints.

4. **Background automation**
   - `src/logic/aiCron.ts` schedules a heartbeat every minute that writes `memory/heartbeat.json` and logs recent activity.
   - `runSystemDiagnostic()` (`services/gptSync.ts`) executes shortly after startup to sanity-check integrations.

5. **Lifecycle guards**
   - Signal handlers perform graceful shutdowns and print Railway diagnostics. Uncaught errors are logged but do not crash the process immediately.

---

## ⚙️ Environment Configuration

### Required

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | API key used to initialize the OpenAI SDK client. Without it, the backend serves mock responses for AI endpoints. |

### Model selection priority
`services/openai.ts` chooses the first defined value in the list below and defaults to `gpt-4o` when none are provided:
`defaultModel` (internal override) → `OPENAI_MODEL` → `FINETUNED_MODEL_ID` → `FINE_TUNED_MODEL_ID` → `AI_MODEL`.

### Server & logging

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | Preferred HTTP port. `startServer()` will fall back to the next available port if occupied. |
| `HOST` | `0.0.0.0` | Bind address. |
| `NODE_ENV` | `development` | Controls logging verbosity and error payloads. |
| `SERVER_URL` | `http://127.0.0.1:<port>` | Used in status reporting when the runtime port differs from the preferred port. |
| `LOG_LEVEL` | `info` | Logging level for structured logs. |
| `ARC_LOG_PATH` | `/tmp/arc/log` | Location for session logs and other persisted log artifacts. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Base directory for memory files (used by `memoryAware` utilities). |

### Database connectivity

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Primary connection string. When omitted or connection fails, an in-memory persistence fallback is used. |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Optional components that are assembled into `DATABASE_URL` if the main variable is missing. |

Database initialization is coordinated through `initializeDatabase()` (`db/index.ts`), which populates status information consumed by health endpoints.

### Worker & cron controls

| Variable | Default | Description |
|----------|---------|-------------|
| `RUN_WORKERS` | `false` | Enables loading/scheduling of worker modules from `workers/`. |
| `WORKER_COUNT` | `4` | Reported worker count in diagnostics and status responses. |
| `WORKER_MODEL` | Falls back to selected AI model | Model identifier propagated to worker contexts. |
| `WORKER_API_TIMEOUT_MS` | `60000` | Timeout for OpenAI requests executed by workers. |

If `RUN_WORKERS` is disabled or no worker modules exist, initialization completes with empty worker lists while still validating the database connection for observability.

### Security & compliance

| Variable | Purpose |
|----------|---------|
| `TRUSTED_GPT_IDS` | Comma-separated list of GPT IDs that bypass the `x-confirmed: yes` header requirement enforced by `middleware/confirmGate.ts`. |
| `ALLOW_ROOT_OVERRIDE` & `ROOT_OVERRIDE_TOKEN` | When enabled, permit elevated persistence operations during troubleshooting (see `persistenceManagerHierarchy.ts`). |

Additional environment validation and enforcement rules can be found in `utils/environmentValidation.ts` and `utils/envValidation.ts`; failures are surfaced during `performStartup()` and will abort the boot when marked critical.

---

## 🧠 Data & Memory Layer

- **Primary storage** – `db/` implements a modular persistence layer with schema validation, query helpers, and repositories. `initializeDatabase()` attempts to connect using the configured PostgreSQL credentials.
- **Fallback mode** – If PostgreSQL cannot be reached, operations such as memory storage will degrade gracefully to in-memory implementations, while health endpoints report the degraded state.
- **Session memory** – `memory/store.ts` maintains a hybrid cache backed by filesystem snapshots located under `ARC_MEMORY_PATH`.
- **State management** – `services/stateManager.ts` exposes `loadState()`/`updateState()` for `/status` routes and records the currently running port, version, and uptime.

---

## 📡 API Surface

Routes are registered in `routes/register.ts`. Highlights include:

### Health & diagnostics
- `GET /` – Simple "ARCANOS is live" banner.
- `GET /railway/healthcheck` – Plain-text Railway probe.
- `GET /health` – Aggregated service health (OpenAI, database, caches) with degraded status reporting.
- `GET /healthz` – Liveness probe.
- `GET /readyz` – Readiness probe (ensures database/OpenAI availability).
- `GET /status` / `POST /status` – Read and update the in-memory system state (`services/stateManager.ts`).

### Core AI entry points
- `POST /ask` – Primary chat endpoint routed through `logic/trinity.ts`; secured with rate limiting and payload validation.
- `POST /brain` – Alias for `/ask` that retains the confirmation gate requirement.
- `POST /arcanos` – Diagnostic endpoint powered by `logic/arcanos.ts`; requires the `x-confirmed: yes` header or a trusted GPT ID.
- `POST /api/arcanos/*`, `/api/openai/*`, `/api/sim/*`, `/api/commands/*`, `/api/pr-analysis/*` – Specialized API bundles for programmatic integrations.
- `POST /orchestration/*` & `GET /orchestration/status` – GPT-5 orchestration shell utilities.
- `POST /sdk/*` – OpenAI SDK compatibility surface.

### Memory & worker management
- `GET /api/memory/health` – Database-backed memory health report.
- `POST /api/memory/save`, `GET /api/memory/load`, `DELETE /api/memory/delete`, `POST /api/memory/bulk` – CRUD-style memory APIs (write operations gated by `confirmGate`).
- `GET /workers/status` & related routes – Worker initialization status and scheduler insights.

### Additional integrations
- `/gpt/*` – GPT routing helpers defined in `routes/gptRouter.ts`.
- `/backstage/*` – Backstage tooling endpoints.
- `/siri`, `/image`, `/rag`, `/research`, `/hrc` – Optional modules that wrap specialized services such as RAG processing or hallucination-resistant checks.

> **Confirmation header** – Mutating routes generally require `x-confirmed: yes` unless the caller identifies as a trusted GPT (`TRUSTED_GPT_IDS`). Requests are logged with the outcome for audit compliance.

---

## 📈 Observability & Health Checks

- Structured logging originates from `utils/structuredLogging.ts`. Log categories (server, cron, health, etc.) map to the boot summary printed in `server.ts`.
- Heartbeat data lives in `memory/heartbeat.json` and is refreshed every minute by `logic/aiCron.ts`.
- `/health`, `/healthz`, `/readyz`, and `/status` surface database and OpenAI availability, cache stats, and uptime metrics.
- `services/gptSync.ts` executes a post-boot diagnostic to validate external connectivity.

---

## ☁️ Deployment Notes

- **Build** – `npm run build` compiles TypeScript to `dist/`.
- **Start** – `npm start` (or `node dist/start-server.js`) should be used locally and for environments where dynamic port reassignment is required.
- **Procfile** – For platforms like Railway or Heroku, `web: node --max-old-space-size=7168 dist/server.js` is provided as a conservative production entry point.
- **Port management** – The service logs when it must fall back from the preferred port and updates the runtime state so external monitors can read the active port via `/status`.
- **Graceful shutdown** – `SIGINT`/`SIGTERM` handlers in `server.ts` close the HTTP server, log memory usage, and emit Railway deployment identifiers before exiting.

---

_Last updated for the current codebase layout (2025-02)._ 

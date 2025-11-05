# Arcanos Backend

> **Last Updated:** 2024-10-30 | **Version:** 1.0.0 | **OpenAI SDK:** v5.16.0

Arcanos is an AI-assisted TypeScript backend built on Express. The service routes
requests through a centralized OpenAI integration, persists state to disk, and
exposes a collection of HTTP APIs for AI orchestration, diagnostics, memory
management, and background worker coordination.

---

## 🧠 Core Architecture & Features

- **Express + TypeScript runtime** – `src/start-server.ts` boots the application,
  performs environment validation, and mounts routes from `src/routes`.
- **Centralized OpenAI client** – `src/services/openai.ts` lazily initializes the
  SDK, chooses a default model (`OPENAI_MODEL` → `FINETUNED_MODEL_ID`
  → `FINE_TUNED_MODEL_ID` → `AI_MODEL` → `gpt-4o`), and exposes helpers for chat,
  image generation, and GPT‑5 delegation.
- **Adaptive Failover Orchestration Layer (AFOL)** – `src/afol/` monitors service
  health, applies routing policies, and logs every failover decision. See
  [`docs/AFOL_OVERVIEW.md`](docs/AFOL_OVERVIEW.md) for guidance.
- **State synchronization** – `src/services/stateManager.ts` maintains
  `systemState.json`, while `/status` endpoints provide read/write access for
  external automation.
- **Graceful fallbacks** – Missing `OPENAI_API_KEY` triggers mock responses,
  database failures degrade to in-memory persistence, and worker boot tolerates a
  missing `workers/` directory.
- **Heartbeat & diagnostics** – `src/logic/aiCron.ts` writes
  `memory/heartbeat.json` every minute and `/health`, `/healthz`, and `/readyz`
  report OpenAI and database status.

---

## 🚀 Quick Start

```bash
npm install
cp .env.example .env   # populate OPENAI_API_KEY and any optional variables
npm run build
npm start
```

### Common Scripts

```bash
npm run dev      # Start the server with ts-node-dev
npm test         # Run Jest test suites
npm run lint     # Lint TypeScript sources
```

### Health Checks

```bash
curl http://localhost:8080/health     # aggregated service health
curl http://localhost:8080/healthz    # liveness probe
curl http://localhost:8080/readyz     # readiness probe
```

---

## ⚙️ Configuration Overview

Key environment variables used by the backend:

| Variable | Description |
| --- | --- |
| `OPENAI_API_KEY` | API key for the OpenAI SDK. Missing keys enable mock responses. |
| `OPENAI_MODEL` / `FINETUNED_MODEL_ID` / `FINE_TUNED_MODEL_ID` / `AI_MODEL` | Preferred model identifiers (first non-empty wins). |
| `RESEARCH_MODEL_ID` | Optional override for the research pipeline; defaults to the selected AI model. |
| `GPT5_MODEL` | Override identifier used for GPT‑5 reasoning fallbacks (default `gpt-5`). |
| `PORT` / `HOST` / `SERVER_URL` | Server binding details. `PORT` defaults to `8080`. |
| `DATABASE_URL` (+ `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`) | PostgreSQL connection string with automatic assembly from discrete settings. |
| `ARC_LOG_PATH` / `ARC_MEMORY_PATH` | Filesystem paths for log storage and memory snapshots. |
| `RUN_WORKERS` | Enables worker bootstrap (defaults to `true` outside of tests). |
| `WORKER_COUNT` / `WORKER_MODEL` / `WORKER_API_TIMEOUT_MS` | Worker concurrency, default model, and request timeout controls. |
| `TRUSTED_GPT_IDS` | Comma-separated GPT identifiers allowed to bypass confirmation headers. |
| `SESSION_CACHE_TTL_MS` / `SESSION_CACHE_CAPACITY` / `SESSION_RETENTION_MINUTES` | Memory cache retention and capacity tuning. |
| `NOTION_API_KEY` / `RESEARCH_MAX_CONTENT_CHARS` / `HRC_MODEL` | Feature-specific integrations for Notion sync, research ingestion, and HRC analysis. |

A full configuration matrix is maintained in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

---

## 🌐 API Highlights

All routes are registered in [`src/routes/register.ts`](src/routes/register.ts).
Confirmation-sensitive endpoints require the `x-confirmed: yes` header unless the
caller supplies a trusted GPT ID via `x-gpt-id` or request payload.

### Conversational & Reasoning Endpoints

| Endpoint | Confirmation | Description |
| --- | --- | --- |
| `POST /ask` | No | Primary chat endpoint routed through the Trinity brain. |
| `POST /brain` | Yes | Confirmation-gated alias for `/ask`. |
| `POST /arcanos` | Yes | Diagnostic orchestration entry point powered by `runARCANOS`. |
| `POST /siri` | Yes | Siri-style prompt handler with Trinity routing. |
| `POST /arcanos-pipeline` | Yes | Multi-stage pipeline combining ARCANOS, GPT‑3.5, and GPT‑5. |
| `POST /api/arcanos/ask` | Yes | Minimal JSON API that streams or returns ARCANOS completions. |

### AI Utilities

- `POST /write`, `POST /guide`, `POST /audit`, `POST /sim`
  – Content generation, guidance, auditing, and simulations (all require
  confirmation).
- `POST /image` – DALL·E-style image generation with optional `size` parameter.
- `POST /api/sim` – Simulation API with `/api/sim/health` and `/api/sim/examples`
  helper routes.
- `POST /gpt/:gptId/*` – Dynamic routing to modules defined in
  `config/gptRouterConfig.ts`.

### Memory & State

| Endpoint | Notes |
| --- | --- |
| `GET /api/memory/health` | Memory service diagnostics. |
| `POST /api/memory/save` | Persist a key/value pair (requires confirmation). |
| `GET /api/memory/load?key=...` | Retrieve stored memory. |
| `DELETE /api/memory/delete` | Remove a memory entry (requires confirmation). |
| `GET /api/memory/list` | List recent memory entries. |
| `GET /api/memory/view` | View the legacy filesystem snapshot. |
| `POST /api/memory/bulk` | Execute bulk memory operations (requires confirmation). |
| `GET /status` / `POST /status` | Read/write `systemState.json` (POST requires confirmation). |

### Workers & Automation

- `GET /workers/status` – Enumerates available worker modules and runtime
  configuration.
- `POST /workers/run/:workerId` – Executes a worker by filename (requires
  confirmation).
- `POST /heartbeat` – Records operator heartbeats to `logs/heartbeat.log`
  (requires confirmation).

### Research, RAG, and Integrations

- `POST /rag/fetch`, `/rag/save`, `/rag/query` – Retrieval-augmented generation
  ingestion and querying.
- `POST /commands/research` – Curated research pipeline (requires confirmation).
- `POST /sdk/research` – SDK-friendly research bridge that reuses the central
  OpenAI client (requires confirmation).
- `POST /api/ask-hrc` – Hallucination Resistant Core evaluation.
- `POST /api/pr-analysis/*`, `/api/openai/*`, `/api/commands/*` – Specialized
  automation surfaces documented in the `docs/api` directory.

#### Research Module Primer

ARCANOS Research accepts a topic and optional URLs, fetches each source, and
uses the centralized OpenAI SDK client (`createCentralizedCompletion`) to
summarize and synthesize a brief. Results are persisted to
`memory/research/{topic}` for later retrieval and auditing.

```bash
curl -X POST http://localhost:8080/commands/research \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "topic": "Hallucination resistant prompting",
        "urls": ["https://example.com/article"]
      }'

curl -X POST http://localhost:8080/sdk/research \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"topic": "Knowledge management for AI teams"}'
```

Both endpoints respect mock-mode fallbacks when `OPENAI_API_KEY` is set to the
test sentinel and remain deployable on Railway thanks to confirmation gating,
JSON payloads, and adherence to the shared health/diagnostic surfaces.

---

## 🛡️ Security & Confirmation Gate

The middleware in [`src/middleware/confirmGate.ts`](src/middleware/confirmGate.ts)
blocks mutating operations unless either:

1. The request includes `x-confirmed: yes`, or
2. The caller identifies as a trusted GPT (`TRUSTED_GPT_IDS` + `x-gpt-id`).

Audit logs include confirmation status, trusted GPT usage, and timestamped
context for downstream analysis.

---

## 🧪 Testing & Quality Checks

```bash
npm test                     # Jest test suites
npm run lint                 # ESLint (via @typescript-eslint)
npm run build && npm start   # Ensure the compiled server boots
```

For additional diagnostics, `src/services/gptSync.ts` executes a post-boot system
diagnostic and `/api/test` returns a lightweight readiness payload for Railway.

---

## 📚 Additional Documentation

- [`docs/backend.md`](docs/backend.md) – Detailed runtime walkthrough.
- [`docs/api/README.md`](docs/api/README.md) – Endpoint catalog and examples.
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) – Expanded environment
  reference.
- [`docs/environment-security-overview.md`](docs/environment-security-overview.md)
  – Startup safety checks and sandbox rules.

---

Need a deeper dive? Start with [`docs/README.md`](docs/README.md) for the full
documentation index and cross-links to specialized guides.

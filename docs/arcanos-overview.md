# 🌟 Arcanos Architecture Overview

> **Last Updated:** 2025-02-18 | **Version:** 1.3.0 | **Architecture Guide**

Arcanos is an AI-controlled backend system that pairs a fine-tuned GPT model with
traditional web services. Built with TypeScript and Express, it relies on a
PostgreSQL database for persistence and ships with comprehensive fallback
behaviors so development can continue even when upstream dependencies are
unavailable. The design goal is to give the model operational control over
common tasks while providing standard HTTP endpoints for human or automated
callers.

---

## 📋 Architecture Documentation Self-Check

This overview includes:
- [x] Core AI-controlled architecture principles
- [x] Integration patterns with OpenAI SDK v6.15.0
- [x] Database fallback behaviors
- [x] Worker system architecture
- [x] Configuration patterns and environment dependencies
- [x] Railway deployment compatibility considerations

Key capabilities include:

- **Fine-Tuned Model Integration** – Core logic routes through a fine-tuned GPT
  model. The model approves fallback to standard GPT models when necessary.
- **Intent-Based Routing** – Incoming requests are analyzed to detect intents
  such as `WRITE` or `AUDIT` and routed to specialized handlers.
- **Persistent Memory** – Conversation context and arbitrary key/value data are
  stored in PostgreSQL with an in-memory fallback for development.
- **OpenAI Assistants** – The backend can synchronize organization assistants so
  they are available at runtime.
- **AI-Controlled Workers** – Background tasks such as health checks and memory
  sync run only with AI approval.

In short, Arcanos acts as a comprehensive AI backend where the model plays an
active role in system management while exposing a conventional API for clients.

For strict GPT-5.2 reasoning from Python, the project includes a companion module
outlined in [`ARCANOS_PYTHON_README.md`](../ARCANOS_PYTHON_README.md). It
enforces the fine-tuned model and automatically alerts a maintenance assistant
on any failure.

---

## 🧱 Component Breakdown

| Component | Location | Responsibilities |
| --- | --- | --- |
| **Express Server** | `src/start-server.ts`, `src/routes/` | Boots the HTTP server, registers confirmation-gated routes, and exposes health/readiness probes. |
| **Centralized OpenAI Client** | `src/services/openai.ts` | Lazily instantiates the OpenAI SDK, prioritizes fine-tuned models, and offers helpers for chat, research, and GPT‑5 delegation. |
| **Adaptive Failover Orchestration Layer (AFOL)** | `src/afol/` | Monitors service health, logs failover decisions, and swaps between GPT tiers or memory backends when incidents arise. |
| **Memory Service** | `memory-service/`, `src/services/memoryService.ts` | Persists conversation context in PostgreSQL with filesystem and in-memory fallbacks for tests and local dev. |
| **Worker Runtime** | `workers/`, `src/logic/aiCron.ts` | Schedules AI-controlled cron jobs, syncs memory snapshots, and executes diagnostics such as `/workers/run/:workerId`. |
| **Diagnostics & Confirmation Middleware** | `src/middleware/confirmGate.ts`, `src/routes/health.ts` | Enforces `x-confirmed` headers, audits trusted GPT usage, and reports OpenAI/database readiness. |

---

## 🔁 Request & Reasoning Lifecycle

1. **Ingress** – HTTP traffic enters through Express routes (see
   `src/routes/register.ts`). Confirmation-sensitive routes require
   `x-confirmed` unless the caller is on the trusted GPT list.
2. **Intent Detection** – Middleware and the Trinity brain (`src/logic/brain/`)
   analyze payloads to map requests to intents such as `WRITE`, `AUDIT`, or
   `RESEARCH`.
3. **OpenAI Invocation** – `createCentralizedCompletion` selects the best
   available model following this priority:
   `OPENAI_MODEL → FINETUNED_MODEL_ID → FINE_TUNED_MODEL_ID → AI_MODEL → gpt-4o`.
   GPT‑5.2 reasoning is triggered automatically for escalations or when explicit
   intent requests it.
4. **Memory Coordination** – Responses can read from or write to
   `memory/memory.db` (PostgreSQL) while mirroring important entries to
   `memory/` snapshots for auditing.
5. **Response & Logging** – AFOL logs the model + memory path taken, the
   confirmation token, and any failover reason before returning the payload.

---

## 🗄️ Memory & Persistence Strategy

- **Primary Store** – PostgreSQL (via `DATABASE_URL`) holds long-term memory,
  heartbeats, and research artifacts.
- **Filesystem Snapshots** – `memory/` contains JSON mirrors used for audits and
  offline inspection.
- **In-Memory Fallback** – If the database is unavailable, the memory service
  automatically degrades to an in-memory map, logging the incident for later
  replay.
- **Bulk Operations** – `/api/memory/bulk` enables multi-record transactions
  while maintaining confirmation gating to prevent accidental wipes.

This layered approach keeps the AI agent responsive even when infrastructure is
partially degraded.

---

## 🛠️ Worker & Automation Loop

Workers live under `workers/` and can be invoked via `/workers/run/:workerId`
with confirmation. The AI decides which worker to execute, but every run is
still validated server-side. The `aiCron` module performs:

- Heartbeat writes to `memory/heartbeat.json`.
- Memory syncs between PostgreSQL, filesystem snapshots, and cached state.
- Assistant synchronization so OpenAI organization assistants stay aligned with
  project configuration.
- Health polling for external services referenced in `config/` (Notion, research
  fetchers, etc.).

Workers inherit the same OpenAI client helpers, so model selection and failover
behave consistently across synchronous and async paths.

---

## ⚙️ Configuration & Environment

Key environment variables:

- `OPENAI_API_KEY` – Required for live calls. When missing or set to the test
  sentinel, mock responses are returned.
- `OPENAI_MODEL`, `FINETUNED_MODEL_ID`, `FINE_TUNED_MODEL_ID`, `AI_MODEL` – Model
  preference chain.
- `RESEARCH_MODEL_ID`, `GPT51_MODEL` / `GPT5_MODEL` – Optional overrides for specialized flows.
- `DATABASE_URL` or discrete PG settings – PostgreSQL connection parameters.
- `RUN_WORKERS`, `WORKER_COUNT`, `WORKER_MODEL`, `WORKER_API_TIMEOUT_MS` – Worker
  scheduling and capacity controls.
- `TRUSTED_GPT_IDS`, `CONFIRMATION_CHALLENGE_TTL_MS` – Confirmation gate
  settings.
- `ARC_LOG_PATH`, `ARC_MEMORY_PATH` – Custom log/memory directories when running
  outside the repository root.

A full matrix lives in [`docs/CONFIGURATION.md`](./CONFIGURATION.md).

---

## 🚀 Deployment Notes

- **Railway Compatibility** – The project includes `railway/` manifests plus
  `RAILWAY_COMPATIBILITY_GUIDE.md` to ensure all confirmation and health surfaces
  are reachable in containerized environments.
- **Docker & Procfile** – `Dockerfile`, `docker-compose.yml`, and `Procfile`
  support local docker builds, Railway one-click deploys, and Heroku-style
  process management.
- **Health Probes** – `/health`, `/healthz`, and `/readyz` must be exposed for
  platform monitoring. They call into AFOL to ensure OpenAI and PostgreSQL are
  reachable before signaling readiness.

---

## 📊 Monitoring & Diagnostics

- **Logs** – Stored under `logs/` with structured entries that include model
  identifiers, failover decisions, and confirmation context.
- **Heartbeats** – `aiCron` writes `memory/heartbeat.json` so automation can
  confirm the AI is still managing the system.
- **System State** – `/status` exposes `systemState.json`, enabling external
  agents to inspect or update operational metadata (write access requires
  confirmation).
- **Security Audits** – `SECURITY_SUMMARY.md` and `OPTIMIZATION_REPORT.md`
  summarize the most recent audits. Use them alongside this overview when
  onboarding new operators.

---

## ✅ Operational Readiness Checklist

- [ ] `OPENAI_API_KEY` configured and tested via `/ask`.
- [ ] PostgreSQL reachable (verify `/api/memory/health`).
- [ ] Workers enabled (`RUN_WORKERS=true`) and `GET /workers/status` returning
      expected entries.
- [ ] `/health`, `/healthz`, and `/readyz` wired into platform monitors.
- [ ] Trusted GPT IDs or automation tokens documented for the confirmation gate.

Keeping this checklist green ensures the fine-tuned model, AFOL, and workers are
coordinated before promoting a deployment to production.

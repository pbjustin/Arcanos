# ARCANOS Configuration Guide

> **Last Updated:** 2024-10-30 | **Version:** 1.0.0

This guide documents environment variables and configuration patterns used by
the Arcanos backend. Defaults are taken from `src/config/index.ts` and
`src/utils/env.ts`.

---

## 📋 Configuration Self-Check

- [x] Required vs optional variables highlighted
- [x] Default values documented with source references
- [x] Confirmation and security flags explained
- [x] Railway deployment notes included
- [x] Consistent with package version `1.0.0`

---

## ⚙️ Core Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | ✅ | – | OpenAI API key. When omitted the service returns deterministic mock responses. |
| `PORT` | ❌ | `8080` | Preferred HTTP port. `src/utils/portUtils.ts` falls back to the next free port. |
| `HOST` | ❌ | `0.0.0.0` | Bind address for the HTTP server. |
| `SERVER_URL` | ❌ | `http://127.0.0.1:<port>` | Used when constructing absolute URLs for backend sync. |
| `NODE_ENV` | ❌ | `development` | Controls logging verbosity and certain feature defaults. |
| `LOG_LEVEL` | ❌ | `info` | Logging level for `utils/structuredLogging.ts`. |
| `ARC_LOG_PATH` | ❌ | `/tmp/arc/log` | Directory for session logs and heartbeat output. |
| `ARC_MEMORY_PATH` | ❌ | `/tmp/arc/memory` | Filesystem cache for memory snapshots. |

---

## 🧠 Model Selection

`src/services/openai.ts` chooses the first non-empty value in the chain below:

1. `OPENAI_MODEL`
2. `FINETUNED_MODEL_ID`
3. `FINE_TUNED_MODEL_ID`
4. `AI_MODEL`
5. `gpt-4o` (fallback)

Additional model-related variables:

| Variable | Default | Description |
| --- | --- | --- |
| `GPT5_MODEL` | `gpt-5` | Identifier used for GPT‑5 reasoning fallbacks. |
| `API_KEY` | – | Legacy alias checked before `OPENAI_API_KEY`. |

---

## 🗄️ Database Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | – | Primary PostgreSQL connection string. Enables persistent memory. |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | – | If `DATABASE_URL` is missing these values are combined to create one. |
| `SESSION_PERSISTENCE_CLIENT` | – | Optional override for session persistence backend (`memory/sessionPersistence.ts`). |
| `SESSION_PERSISTENCE_URL` | – | Explicit connection string for the session persistence client. |
| `SESSION_PERSISTENCE_SQLITE_PATH` | – | Path used when SQLite is selected. |

Database failures gracefully fall back to in-memory storage; health endpoints
report the degraded state for observability.

---

## 🧾 Session & Memory Tuning

| Variable | Default | Description |
| --- | --- | --- |
| `SESSION_CACHE_TTL_MS` | `300000` | TTL for session cache entries. |
| `SESSION_CACHE_CAPACITY` | `200` | Maximum number of cached sessions. |
| `SESSION_RETENTION_MINUTES` | `1440` | Persistence retention window for session snapshots. |
| `ARC_MEMORY_PATH` | `/tmp/arc/memory` | Filesystem directory for memory snapshots. |

---

## 🤖 Worker & Automation Settings

| Variable | Default | Description |
| --- | --- | --- |
| `RUN_WORKERS` | `true` (disabled automatically in tests) | Enables worker bootstrap in `src/utils/workerBoot.ts`. |
| `WORKER_COUNT` | `4` | Number of workers reported in diagnostics. |
| `WORKER_MODEL` | Derived from model chain | Model used by worker tasks. |
| `WORKER_API_TIMEOUT_MS` | `60000` | Timeout for OpenAI calls made by workers. |
| `ORCHESTRATION_LAST_RESET` | – | Optional metadata surfaced by the orchestration shell. |

`src/config/workerConfig.ts` registers worker tasks automatically when
`RUN_WORKERS` evaluates to `true`.

---

## 🔐 Security & Access Control

| Variable | Default | Description |
| --- | --- | --- |
| `TRUSTED_GPT_IDS` | – | Comma-separated GPT identifiers that bypass the confirmation gate. |
| `CONFIRMATION_CHALLENGE_TTL_MS` | `120000` | Lifetime (in milliseconds) for pending confirmation challenges returned by `confirmGate`. |
| `ALLOW_ROOT_OVERRIDE` | `false` | Enables elevated persistence operations when paired with `ROOT_OVERRIDE_TOKEN`. |
| `ROOT_OVERRIDE_TOKEN` | – | Secret required when root override mode is enabled. |
| `ADMIN_KEY` | – | Optional admin key consumed by orchestration workflows. |
| `REGISTER_KEY` | – | Optional key for automated registration flows. |
| `ARC_SHADOW_MODE` | `enabled` | Controls the shadow routing feature (`services/shadowControl.ts`). |
| `CREPID_PURGE` | `off` | Governs purge mode for `utils/crepidPurge.ts`. |

Confirmation behaviour is implemented in
[`src/middleware/confirmGate.ts`](../src/middleware/confirmGate.ts).

---

## 📚 Feature Integrations

| Variable | Default | Description |
| --- | --- | --- |
| `NOTION_API_KEY` | – | Enables Notion synchronisation in `services/notionSync.ts`. |
| `RESEARCH_MAX_CONTENT_CHARS` | `6000` | Upper bound on content length ingested by the research module. |
| `RESEARCH_MODEL_ID` | – | Overrides the research module's default model (falls back to the global AI model). |
| `HRC_MODEL` | Falls back to default model | Preferred model for Hallucination Resistant Core (`modules/hrc.ts`). |
| `BOOKER_TOKEN_LIMIT` | `512` | Token limit used by the Backstage booker module. |
| `USER_GPT_ID` | – | Propagated to Backstage modules for context. |
| `TUTOR_DEFAULT_TOKEN_LIMIT` | `200` | Default token limit for tutor logic. |
| `BACKEND_REGISTRY_URL` | – | Optional registry endpoint referenced by diagnostics. |
| `GPT_MODULE_MAP` | – | Serialized JSON map of GPT IDs to module routes (`config/gptRouterConfig.ts`). |
| `GPTID_BACKSTAGE_BOOKER`, `GPTID_ARCANOS_GAMING`, `GPTID_ARCANOS_TUTOR` | – | Convenience identifiers resolved by the GPT router. |

---

## 🛠️ Deployment Notes

### Railway

- `RAILWAY_ENVIRONMENT`, `RAILWAY_PROJECT_ID`, `RAILWAY_DEPLOYMENT_ID`,
  `RAILWAY_RELEASE_ID` are logged during shutdown to aid debugging.
- If the platform injects a managed PostgreSQL instance, `PG*` variables are
  automatically combined into `DATABASE_URL` by `src/db/client.ts`.

### Local Development

1. Copy `.env.example` to `.env` and populate the required fields.
2. Run `npm run dev` for a watch-mode server.
3. Use `npm test` to validate environment assumptions.

---

## 🧪 Validation Utilities

- `utils/envValidation.ts` performs basic range checks (e.g. `PORT` between 1 and
  65535) and ensures log directories exist.
- `utils/environmentSecurity.ts` toggles safe mode when high-risk variables are
  missing.
- `npm test` includes coverage for environment enforcement in
  `tests/environment-security.test.ts`.

---

## Troubleshooting

- **Mock AI responses** – Confirm `OPENAI_API_KEY` is set and not equal to the
  placeholder value from `.env.example`.
- **Database fallback** – When `DATABASE_URL` is absent or unreachable, memory
  endpoints remain available but `/health` reports status `degraded`.
- **Worker bootstrap disabled** – Set `RUN_WORKERS=true` (not needed when
  `workers/` is empty).
- **Trusted GPT IDs** – Ensure `TRUSTED_GPT_IDS` and the caller’s `x-gpt-id`
  value match exactly (case-sensitive).

Keep this document aligned with changes to `src/config`, `src/utils/env.ts`, and
any new feature-specific services that rely on environment variables.

# ARCANOS API Reference

> **Last Updated:** 2024-10-30 | **Version:** 1.0.0 | **OpenAI SDK:** v5.16.0

This guide summarises the HTTP API exposed by the Arcanos backend. All routes
are registered in [`src/routes/register.ts`](../../src/routes/register.ts).
Mutating endpoints require the `x-confirmed: yes` header unless the caller is a
trusted GPT (`TRUSTED_GPT_IDS` + `x-gpt-id`).

---

## 📡 Core AI Endpoints

| Endpoint | Confirmation | Description |
| --- | --- | --- |
| `POST /ask` | No | Primary chat endpoint routed through the Trinity brain. |
| `POST /brain` | Yes | Confirmation-gated alias for `/ask`. |
| `POST /arcanos` | Yes | Diagnostic orchestration entry point backed by `runARCANOS`. |
| `POST /siri` | Yes | Siri-style interface that reuses the Trinity pipeline. |
| `POST /arcanos-pipeline` | Yes | Multi-stage pipeline that combines ARCANOS, GPT‑3.5, and GPT‑5 reasoning. |
| `POST /api/arcanos/ask` | Yes | Minimal JSON API that returns or streams ARCANOS completions. |

### AI Utilities
- `POST /write`, `POST /guide`, `POST /audit`, `POST /sim`
  – Content generation, guidance, auditing, and simulation helpers (all require
  confirmation).
- `POST /image`
  – Image generation via OpenAI Images API (honours optional `size`).
- `POST /api/sim`
  – Simulation API with supporting routes `GET /api/sim/health` and
  `GET /api/sim/examples`.
- `POST /gpt/:gptId/*`
  – Dynamic router that forwards GPT-specific traffic to modules defined in
  `config/gptRouterConfig.ts`.

---

## 🗂️ Memory & State APIs

| Endpoint | Notes |
| --- | --- |
| `GET /api/memory/health` | Confirms database connectivity and reports recent errors. |
| `POST /api/memory/save` | Persist a key/value pair (requires confirmation). |
| `GET /api/memory/load?key=...` | Retrieve stored memory by key. |
| `DELETE /api/memory/delete` | Remove a memory entry (requires confirmation). |
| `GET /api/memory/list` | List recent memory entries ordered by update time. |
| `GET /api/memory/view` | Return the legacy filesystem log snapshot. |
| `POST /api/memory/bulk` | Execute a sequence of memory operations (requires confirmation). |
| `POST /heartbeat` | Append heartbeat telemetry to `logs/heartbeat.log` (requires confirmation). |
| `GET /status` | Return the contents of `systemState.json`. |
| `POST /status` | Update the backend state document (requires confirmation). |

---

## 🔁 Contextual Reinforcement & CLEAR Loop

| Endpoint | Confirmation | Description |
| --- | --- | --- |
| `POST /reinforce` | No | Record contextual summaries, bias, and metadata for the reinforcement window. |
| `POST /audit` | No | Submit CLEAR feedback; applies minimum score gating and forwards payloads to the CLEAR webhook when configured. |
| `GET /memory/digest` | No | Retrieve the latest contextual digest used by reinforcement-aware prompts. |
| `GET /memory` | No | Alias of `/memory/digest` maintained for compatibility. |
| `GET /health` | No | Report reinforcement mode, window size, stored entry counts, and last CLEAR timestamp. |

See [`docs/api/CONTEXTUAL_REINFORCEMENT.md`](CONTEXTUAL_REINFORCEMENT.md) for complete payload definitions and lifecycle details.

---

## 🛠️ Workers & Automation

| Endpoint | Confirmation | Description |
| --- | --- | --- |
| `GET /workers/status` | No | Lists worker files in the `workers/` directory and reports runtime configuration. |
| `POST /workers/run/:workerId` | Yes | Executes a worker module by filename using the worker context helper. |

---

## 🔍 Research, RAG, and Specialized Modules

| Endpoint | Confirmation | Description |
| --- | --- | --- |
| `POST /commands/research` | Yes | Invokes the research module to aggregate external sources. |
| `POST /rag/fetch` | No | Fetch and ingest a document by URL. |
| `POST /rag/save` | No | Persist custom text content for later retrieval. |
| `POST /rag/query` | No | Run a retrieval-augmented query across stored documents. |
| `POST /api/ask-hrc` | Yes | Hallucination Resistant Core evaluation. |
| `POST /api/pr-analysis/*` | Yes | Pull-request analysis helpers (see module documentation). |
| `POST /api/commands/execute` | Yes | Execute a registered command via `services/commandCenter.ts`. |
| `GET /api/commands/` | No | Enumerate available commands. |
| `GET /api/commands/health` | No | Command service health probe. |
| `POST /api/openai/*` | Mixed | OpenAI compatibility shims (see route for details). |
| `POST /api/sim` | No | Run a simulation scenario with optional streaming. |

---

## 🩺 Health & Diagnostics

| Endpoint | Description |
| --- | --- |
| `GET /` | Plain-text "ARCANOS is live" banner. |
| `GET /railway/healthcheck` | Railway-friendly health check. |
| `GET /health` | Aggregated health report including OpenAI and database status. |
| `GET /healthz` | Liveness probe. |
| `GET /readyz` | Readiness probe (ensures required dependencies are available). |
| `GET /api/test` | Lightweight JSON probe used for smoke tests. |

---

## 🔐 Confirmation Gate Examples

Protected operations require either `x-confirmed: yes` or a trusted GPT ID.

```bash
curl -X POST http://localhost:8080/api/memory/save \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"key":"example","value":{"note":"stored by API"}}'
```

Requests from a trusted GPT can omit the confirmation header when both
`TRUSTED_GPT_IDS` and `x-gpt-id` are configured:

```bash
curl -X DELETE http://localhost:8080/api/memory/delete \
  -H "Content-Type: application/json" \
  -H "x-gpt-id: my-approved-gpt" \
  -d '{"key":"example"}'
```

---

## Error Handling

All endpoints return JSON payloads with `status`, `message`, and `timestamp`
fields (where applicable). Common failure modes include:

- `400 Bad Request` – Validation errors, missing fields, or malformed JSON.
- `403 Forbidden` – Missing confirmation header or untrusted GPT ID.
- `404 Not Found` – Unknown worker/module identifiers.
- `429 Too Many Requests` – Rate limits defined in `utils/security.ts` have been
  exceeded.
- `500 Internal Server Error` / `503 Service Unavailable` – Upstream failures or
  external dependency outages.

---

## Related Documentation

- [`docs/api/API_REFERENCE.md`](API_REFERENCE.md) – Expanded request/response
  examples.
- [`docs/backend.md`](../backend.md) – Runtime architecture and boot process.
- [`docs/CONFIGURATION.md`](../CONFIGURATION.md) – Environment variable matrix.

Use these references together to keep client integrations aligned with the
current backend implementation.

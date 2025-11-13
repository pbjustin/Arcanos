# Arcanos API Prompt Usage Guide

This guide explains how to craft prompts for the major Arcanos API endpoints and
how to layer in memory, RAG, and worker automation.

## Table of Contents

1. [Quick Start](#quick-start)
2. [API Endpoints Overview](#api-endpoints-overview)
3. [Basic Prompting](#basic-prompting)
4. [Session & Domain Routing](#session--domain-routing)
5. [Endpoint-Specific Guides](#endpoint-specific-guides)
6. [Memory & RAG Integration](#memory--rag-integration)
7. [Worker Automation](#worker-automation)
8. [Error Handling & Troubleshooting](#error-handling--troubleshooting)

---

## Quick Start

### Prerequisites

1. Configure `.env` with at minimum:
   ```bash
   OPENAI_API_KEY=sk-...
   OPENAI_MODEL=gpt-4o
   PORT=8080
   RUN_WORKERS=false   # optional, set true to auto-boot cron workers
   ```
2. Install dependencies and build the service:
   ```bash
   npm install
   npm run build
   npm start
   ```
3. Confirm health:
   ```bash
   curl http://localhost:8080/health
   curl http://localhost:8080/api/test
   ```

---

## API Endpoints Overview

| Endpoint | Purpose | Confirmation | Notes |
| --- | --- | --- | --- |
| `POST /ask` | Primary chat endpoint routed through Trinity brain | No | Accepts `prompt`, `sessionId`, `overrideAuditSafe`. |
| `POST /api/ask` | ChatGPT-style wrapper | No | Accepts `message`, `prompt`, `text`, `query`, plus optional metadata; proxies to `/ask`. |
| `POST /brain` | Confirmation-gated alias for `/ask` | Yes | Same payload as `/ask`. |
| `POST /arcanos` | Diagnostic orchestration | Yes | Uses `userInput` and optional `sessionId`. |
| `POST /api/arcanos/ask` | Minimal JSON API | Yes | Accepts `prompt` plus optional streaming options. |
| `POST /arcanos-pipeline` | Multi-stage pipeline with GPT‑5 oversight | Yes | Accepts OpenAI-style `messages`. |
| `POST /api/ask-hrc` | Safety + hallucination scoring | Yes | Provide a `message` to score. |
| `POST /commands/research` / `POST /sdk/research` | Research pipeline | Yes | Provide `topic` + optional `urls`. |
| `/api/memory/*` | Memory CRUD & bulk ops | Mixed | Writes require `x-confirmed: yes`. |
| `/rag/*` | Retrieval-augmented workflows | No | Provide `url`, `content`, or `query`. |
| `/workers/run/:id` | Execute workers or dispatch `arcanos` tasks | Yes | `arcanos` worker accepts `{ input | prompt | text }`. |
| `/api/openai/prompt` | Raw OpenAI compatibility shim | Yes | Mirrors the OpenAI `text_completion` payload. |

---

## Basic Prompting

### `/ask` – Direct prompting

```bash
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{
        "prompt": "Explain eventual consistency in distributed systems",
        "sessionId": "eng-notes"
      }'
```

**Tips**
- `prompt` is required; `sessionId` keeps follow-up requests anchored to the same
  memory window.
- `overrideAuditSafe` accepts a string reason when you need to bypass audit-safe
  mode (still logged by `runThroughBrain`).

### `/api/ask` – Flexible payloads

Use whichever text field is convenient; the router normalizes to `prompt` and
appends context directives for `domain`, `useRAG`, `useHRC`, or arbitrary
`metadata`.

```bash
curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{
        "message": "Summarize the open incidents",
        "domain": "sre",
        "useRAG": true,
        "metadata": {"ticket": "INC-42"}
      }'
```

---

## Session & Domain Routing

### Multi-turn context with `sessionId`

```bash
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{
        "prompt": "Remind me what we decided about the deployment window",
        "sessionId": "deploy-ops"
      }'
```
Use the same `sessionId` for follow-up prompts; the Trinity brain will reuse the
session memory and include routing metadata in the response.

### Diagnostic intent via `/arcanos`

```bash
curl -X POST http://localhost:8080/arcanos \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "userInput": "Audit the staging cluster and list degraded services",
        "sessionId": "ops-oncall"
      }'
```

### Streaming programmatic access via `/api/arcanos/ask`

```bash
curl -N -X POST http://localhost:8080/api/arcanos/ask \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "prompt": "Ping",
        "options": {"stream": true}
      }'
```

---

## Endpoint-Specific Guides

### `/arcanos-pipeline` – Deep reasoning

```bash
curl -X POST http://localhost:8080/arcanos-pipeline \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "messages": [
          {"role": "user", "content": "Draft a rollback plan for the failing deploy"}
        ]
      }'
```

### `/api/ask-hrc` – Hallucination scoring

```bash
curl -X POST http://localhost:8080/api/ask-hrc \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"message": "The service is perfectly secure"}'
```

### `/commands/research`

```bash
curl -X POST http://localhost:8080/commands/research \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "topic": "LLM fine-tuning risks",
        "urls": ["https://example.com/post"]
      }'
```

### `/api/openai/prompt`

```bash
curl -X POST http://localhost:8080/api/openai/prompt \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "model": "gpt-4o",
        "prompt": "List three blast-radius mitigation tactics"
      }'
```

---

## Memory & RAG Integration

### Save context

```bash
curl -X POST http://localhost:8080/api/memory/save \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "key": "user:preferences",
        "value": {"language": "TypeScript", "tone": "succinct"}
      }'
```

### Load context

```bash
curl "http://localhost:8080/api/memory/load?key=user:preferences"
```

### Bulk operations

```bash
curl -X POST http://localhost:8080/api/memory/bulk \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "operations": [
          {"type": "save", "key": "project:current", "value": {"name": "Atlas"}},
          {"type": "delete", "key": "project:old"}
        ]
      }'
```

### RAG ingestion + query

```bash
# Ingest
curl -X POST http://localhost:8080/rag/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/postmortem"}'

# Query
curl -X POST http://localhost:8080/rag/query \
  -H "Content-Type: application/json" \
  -d '{"query": "Summarize the key remediation tasks"}'
```

---

## Worker Automation

### Dispatch ARCANOS worker tasks

```bash
curl -X POST http://localhost:8080/workers/run/arcanos \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"input": "Summarize the active RFCs"}'
```

### Trigger a scheduled worker manually

```bash
curl -X POST http://localhost:8080/workers/run/worker-memory \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes"
```

Use `/workers/status` to confirm which workers were loaded and whether the
planner could connect to PostgreSQL.

---

## Error Handling & Troubleshooting

- **400 responses** typically mean the body was missing `prompt`, `userInput`, or
  `key`. Recheck field names listed above.
- **403 responses** indicate the confirmation header was missing or the GPT ID is
  not in `TRUSTED_GPT_IDS`.
- **503 responses** from `/api/memory/*` mean PostgreSQL was unavailable. The
  response includes `database` and `error` fields.
- Use `GET /railway/healthcheck` and `GET /api/test` for quick service probes.
- Logs for the last AI call are stored at `/tmp/last-gpt-request` to help debug
  prompt payloads.

# Memory Backend Usage Guide

## Purpose
This guide explains how Arcanos saves, retrieves, and semantically searches conversation memory in the backend, including how users should phrase commands to the AI.

It covers:
- data flow and storage model
- how to command the AI to save and recall memory
- `sessionId` strategy
- exact retrieval vs semantic (RAG) retrieval
- API contracts for memory endpoints, including `GET /api/memory/search`

## Architecture Summary
Arcanos uses two complementary memory layers:

1. Exact memory storage (database table: `memory`)
- key-value persistence
- deterministic retrieval by key
- SQL text lookup inside keys and serialized values

2. Semantic memory retrieval (RAG, table: `rag_docs`)
- vector embeddings for natural-language similarity matching
- used as supplemental/fallback retrieval when exact hits are missing
- supports session-aware filtering

## Core Persistence Flow
When memory is saved through natural language (`POST /api/memory/nl` or dispatcher memory intercept):

1. Text is normalized and saved under an `nl-memory:{sessionId}:...` key.
2. Session pointers are updated:
- `nl-latest:{sessionId}` points to newest key
- `nl-session-index:{sessionId}` stores recent key list
3. The same content is best-effort ingested into RAG with metadata:
- `sourceType=memory`
- `memoryKey`
- `sessionId`

Result: exact lookup stays fast and deterministic; semantic lookup remains available for natural-language recall.

## Dispatcher Behavior (Universal Across Modules)
Memory commands are intercepted at dispatcher level before module action execution.

File reference:
- `src/routes/_core/gptDispatch.ts`

What this means:
- memory works across modules, not only Backstage Booker
- if no `sessionId` is supplied, fallback namespace is `global`
- memory commands can succeed even when module actions are ambiguous

## Command Baseline for Users
Use these command patterns when talking to the AI.

### Save Commands
High-confidence save verbs:
- `remember ...`
- `save ...`
- `store ...`

Examples:
- `remember this summary of Monday Night Raw: ...`
- `save this roster change for backstage booker`
- `store this under key raw-recap-2026-03-06`

Optional explicit key syntax at end:
- `... under key my-custom-key`
- `... with key my-custom-key`
- `... key my-custom-key`

### Retrieve Latest
Use "latest" or "last" with memory terms:
- `show latest memory`
- `load last saved summary`

### Retrieve by Key
Use direct key retrieval phrasing:
- `load memory key my-custom-key`
- `retrieve memory for key my-custom-key`

### Lookup / Search by Meaning
Use lookup verbs with query text:
- `lookup cody wins at summerslam`
- `find monday raw summary about jey uso`
- `search my saved notes about roster changes`

### List Session Memories
- `list memories`
- `show saved memories`

## Session Strategy (`sessionId`)
`sessionId` partitions memory context.

Recommended:
- single user + single thread: use a stable session ID per thread
- multi-user system: always provide per-user or per-conversation `sessionId`

If omitted:
- dispatcher defaults to `global`
- useful for universal/shared memory
- not recommended for strict multi-tenant isolation

## Retrieval Modes
Arcanos uses three retrieval modes in responses:

1. Exact hit
- direct key hit or SQL text match found in DB
- authoritative payload returned from `memory` table

2. Semantic supplemental
- semantic matches returned in addition to exact hits
- mainly used by unified search endpoint

3. Semantic fallback
- used when exact retrieval misses
- nearest semantic match is returned when available

## Endpoint Reference

### `POST /api/save-conversation`
Structured persistence endpoint for deterministic log/conversation saves.

Use this instead of prompt/GPT routes when the caller needs a machine-verifiable persistence receipt.

Request body:
```json
{
  "title": "Backend diagnostics",
  "tags": ["session_diagnostic_2026-03-08", "backend"],
  "contentMode": "transcript",
  "content": [
    { "role": "user", "content": "save this conversation" },
    { "role": "assistant", "content": "confirmed" }
  ],
  "sessionId": "raw_20260308_van",
  "metadata": {
    "source": "manual-test"
  }
}
```

Success response:
```json
{
  "success": true,
  "record_id": 18342,
  "storage_type": "conversation",
  "title": "Backend diagnostics",
  "tags": ["session_diagnostic_2026-03-08", "backend"],
  "content_mode": "transcript",
  "length_stored": 123,
  "bytes_stored": 123,
  "created_at": "2026-03-09T12:00:00.000Z",
  "error": null
}
```

Behavior:
- requires structured JSON input
- writes once, then immediately re-reads by returned `record_id`
- fails closed if the read-after-write verification does not match

### `GET /api/save-conversation/:recordId`
Fetches the exact stored conversation payload by returned record id.

Use this to verify:
- the row exists
- the stored `content_mode`
- the exact `content` that was persisted

### `POST /api/memory/nl`
Natural-language command endpoint.

Request body:
```json
{
  "input": "remember this summary ...",
  "sessionId": "booker-thread-1",
  "limit": 10
}
```

Response includes:
- `intent`, `operation`, `sessionId`
- `key`, `value`, `entries` when applicable
- `rag` diagnostics (active/mode/reason/matches/diagnostics)

### `GET /api/memory/load`
Exact key load with semantic fallback if exact key miss occurs.

Query params:
- `key` (required)
- `sessionId` (optional)
- `limit` (optional, used by fallback)

### `GET /api/memory/list`
Lists recent memory entries, optionally filtered by `prefix`.

### `GET /api/memory/table`
HTML table view for memory rows.

### `GET /api/memory/view`
JSON view of memory rows.

### `GET /api/memory/search`
Unified merged search endpoint (exact + semantic in one normalized schema).

Query params:
- `q` (required)
- `sessionId` (optional)
- `limit` (optional, default 15, max 50)

Response shape:
```json
{
  "status": "success",
  "message": "Memory search completed",
  "data": {
    "schema": {
      "key": "string",
      "value": "unknown",
      "metadata": "object|null",
      "created_at": "ISO-8601 string",
      "updated_at": "ISO-8601 string",
      "match_type": "\"exact\"|\"semantic\"",
      "score": "number|null",
      "source": "string"
    },
    "query": "raw summary",
    "sessionId": "booker-thread-1",
    "limit": 5,
    "counts": {
      "exact": 2,
      "semantic": 3,
      "merged": 4
    },
    "diagnostics": {
      "rag": {
        "enabled": true,
        "reason": "ok",
        "candidateCount": 12,
        "returnedCount": 3,
        "sessionFilterApplied": true,
        "sessionFallbackApplied": false,
        "sourceTypeFilterApplied": true,
        "minScore": 0.1,
        "limit": 5
      }
    },
    "hits": [
      {
        "key": "nl-memory:booker-thread-1:raw-summary-1",
        "value": { "text": "..." },
        "metadata": {},
        "created_at": "2026-03-06T07:00:00.000Z",
        "updated_at": "2026-03-06T07:00:00.000Z",
        "match_type": "exact",
        "score": null,
        "source": "database"
      },
      {
        "key": "rag:abc123#0",
        "value": { "text": "...", "source": "session:booker-thread-1" },
        "metadata": { "ragScore": 0.74 },
        "created_at": "2026-03-06T07:02:00.000Z",
        "updated_at": "2026-03-06T07:02:00.000Z",
        "match_type": "semantic",
        "score": 0.74,
        "source": "session:booker-thread-1"
      }
    ]
  }
}
```

## User Prompting Recommendations
For reliable memory behavior in clients:

1. Always provide `sessionId` for user-specific memory.
2. Use save verbs explicitly (`remember/save/store`) at start of command.
3. For exact recall, prefer key-based commands.
4. For fuzzy recall, prefer lookup/search commands.
5. Use `/api/memory/search` for UI search pages because it already merges exact + semantic.

## Security and Data Hygiene Notes
1. `sessionId` is the primary isolation control for memory lookup scope.
2. Avoid placing secrets in plain memory text unless your environment policy permits it.
3. Semantic retrieval may surface related context; enforce tenant boundaries with strict `sessionId` discipline.

## Operational Verification Checklist
After deploy:

1. Save memory:
- `POST /api/memory/nl` with a `remember ...` input
2. Deterministic structured save:
- `POST /api/save-conversation` with explicit `contentMode`
3. Read-after-write verification:
- `GET /api/save-conversation/:recordId`
4. Exact load:
- `GET /api/memory/load?key=...`
5. Unified search:
- `GET /api/memory/search?q=...&sessionId=...`
6. Check merged counts:
- confirm `exact`, `semantic`, and `merged`
7. Check diagnostics:
- confirm `diagnostics.rag.reason` is `ok` (or expected fallback reason)

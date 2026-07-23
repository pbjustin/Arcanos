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
- used by merged search and natural-language lookup, and as explicit fallback for selected exact/latest flows
- supports session-aware filtering

## Implementation and Validation
Use this source-of-truth map when changing the memory subsystem:
- route mounting and middleware order: `src/routes/api/index.ts`
- memory HTTP contract: `src/routes/api-memory.ts`
- structured conversation contract: `src/routes/api-save-conversation.ts`
- natural-language parsing, session scoping, and pointer behavior: `src/services/naturalLanguageMemory.ts`
- GPT dispatcher interception: `src/routes/_core/gptDispatch.ts`
- dispatcher conversation persistence: `src/services/moduleConversationPersistence.ts`
- legacy `/brain` compatibility-handler shortcut when `ASK_ROUTE_MODE=compat`: `src/services/naturalLanguageMemoryRouteShortcut.ts` and `src/routes/ask/index.ts`
- durable exact memory: `src/core/db/repositories/memoryRepository.ts` and `src/core/db/schema.ts`
- semantic ingestion and retrieval: `src/services/webRag.ts` and `src/core/db/repositories/ragRepository.ts`

Preserve these invariants:
- exact database hits remain authoritative when exact and semantic results share a key
- session-scoped natural-language commands without explicit session scope fail closed as `stateless`
- `/api/memory/search` intentionally performs a global merged search when `sessionId` is omitted
- structured conversation saves retain schema validation and immediate read-after-write verification

Focused mocked tests cover the HTTP routes, natural-language service, memory repository, and conversation-persistence service. The conditional GPT-dispatch interception and its call into conversation persistence are verified from source but do not have a focused dispatcher test; do not describe that branch as directly test-covered.

For memory code changes, use mocked focused tests instead of live persistence:
```powershell
npm run type-check
npm run lint
node scripts/run-jest.mjs --testPathPatterns=api-memory --testPathPatterns=api-save-conversation --testPathPatterns=naturalLanguageMemory --testPathPatterns=memoryRepository --testPathPatterns=moduleConversationPersistence --testPathPatterns=ask-memory-shortcut --coverage=false --runInBand
```

Do not call live save, delete, bulk, natural-language save, or save-conversation endpoints, or exercise GPT-dispatcher memory commands (including recall), unless persistent writes against the exact target and session are explicitly authorized. With explicit session scope, dispatcher interception attempts best-effort conversation/history persistence after reads; interception without explicit session scope skips that write. Endpoint, response-envelope, session-scope, or exact-versus-semantic changes must update this guide and `docs/API.md`; storage-schema changes must also update `docs/DATABASE_MIGRATIONS.md`.

## Core Persistence Flow
When memory is saved through natural language (`POST /api/memory/nl` or dispatcher memory intercept):

1. Text is normalized. Saves without an explicit key use `nl-memory:{sessionId}:...`; explicit-key syntax preserves the caller's key.
2. Session pointers are updated:
- `nl-latest:{sessionId}` points to newest key
- `nl-session-index:{sessionId}` stores recent key list
3. The same content is best-effort ingested into RAG with metadata:
- `sourceType=memory`
- `memoryKey`
- `sessionId`

Result: exact lookup stays fast and deterministic; semantic lookup remains available for natural-language recall. An identical retry may reuse the latest exact row and skip duplicate RAG ingestion.

## Conditional GPT-Dispatcher Interception
For a registered `/gpt/:gptId` request, memory handling runs before module action execution only when all of these conditions hold:

- direct-module routing is not forced
- the prompt is a string with a recognized memory intent
- the prompt has a memory cue or the module has no routable action
- the requested action is absent or `query`

The branch is not tied to Backstage Booker, but it is not universal. Forced-direct routes and requests that bypass intent routing do not use it. The legacy `/brain` compatibility handler runs a separate shortcut only when `ASK_ROUTE_MODE=compat`; `/api/arcanos/ask` does not use that shortcut.

When the branch runs:
- session-scoped saves, lists, inspections, latest recall, and ordinary lookup require an explicit `sessionId` or inline session/storage label
- session-scoped commands without explicit session scope fail closed as `stateless`
- natural-language direct-key selectors use general exact-memory resolution, while record and tag selectors search only `nl-memory:%` rows; use `/api/save-conversation/:recordId` or `/api/memory/load` for structured-conversation records
- memory commands can succeed even when module actions are ambiguous
- after the result, the dispatcher attempts best-effort conversation persistence; explicit session scope can write conversation/history even for recall, while interception without explicit session scope is skipped by the persistence service

## Command Baseline for Users
Use these command patterns when talking to the AI.
Except for exact key, record, or tag selectors, these examples assume the caller supplies `sessionId` in the request or includes an inline session/storage label.

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
`sessionId` scopes session-aware storage and retrieval. It is not a strict isolation or authorization boundary.

Recommended:
- single user + single thread: use a stable session ID per thread
- multi-user system: always provide per-user or per-conversation `sessionId`

If omitted:
- session-scoped natural-language commands without explicit session scope fail closed with `sessionId: "stateless"`
- exact key, record, or tag selectors can still perform deterministic direct lookup
- `GET /api/memory/search` intentionally searches globally when no `sessionId` filter is supplied

## Retrieval Behavior by Flow

| Flow | Exact and semantic behavior |
| --- | --- |
| Natural-language direct-key selector | Exact lookup through the general memory identifier resolver. |
| Natural-language record or tag selector | Exact-only within `nl-memory:%` rows. |
| `GET /api/memory/load` | Exact identifier lookup; semantic fallback requires `fallback=true`, `mode=search`, and an explicit or identifier-derived session scope. |
| Natural-language latest retrieval | Exact latest-pointer lookup; semantic fallback is used only when explicitly requested. |
| Ordinary natural-language lookup/search | Searches session-prefixed exact rows and session-filtered RAG results, then supplements them with a query-wide durable conversation-session search that is not filtered by `sessionId`. |
| `GET /api/memory/search` | Always merges exact and semantic results; omitting `sessionId` makes the search global. |

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

Recognized-command responses include the following fields when applicable:
- `intent`, `operation`, `sessionId`
- `key`, `value`, `entries` when applicable
- `rag` diagnostics (active/mode/reason/matches/diagnostics)

### `GET /api/memory/load`
Exact identifier load. A miss returns `404` unless semantic fallback is explicitly requested.

Query params:
- one of `key`, `record_id`, or `id` (required)
- `fallback=true` and `mode=search` (both required to enable semantic fallback)
- `sessionId` (optional when the identifier itself carries a session scope)
- `limit` (optional, used only by fallback)

Fallback is skipped when neither an explicit nor identifier-derived session scope is available.

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
1. These route handlers and direct GPT-dispatch memory paths do not independently establish tenant authorization. Verify deployment middleware and caller authorization before exposing or invoking them.
2. `sessionId` is a caller-controlled retrieval namespace/filter, not identity, authentication, authorization, or tenant isolation.
3. `POST /api/memory/save`, `DELETE /api/memory/delete`, and `POST /api/memory/bulk` use `confirmGate`; mutating `POST /api/memory/nl` and `POST /api/save-conversation` do not.
4. `confirmGate` is an action-confirmation/risk gate, not authentication, tenant authorization, or proof of key ownership.
5. The global unsafe-execution gate is a runtime-safety check, not tenant authentication or routine human approval.
6. `/api/memory/search` is global when `sessionId` is omitted.
7. Explicit session scope filters natural-language exact rows and RAG results, but ordinary lookup also supplements from durable conversation sessions without that filter; session scope does not guarantee bounded or tenant-isolated results across every source.
8. Avoid placing secrets in plain memory text unless your environment policy permits it.

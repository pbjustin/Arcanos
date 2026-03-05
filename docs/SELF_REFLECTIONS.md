# Self Reflections

## Overview
ARCANOS has two reflection paths:

1. `ai-reflections` (`src/services/ai-reflections.ts`): generates patch/reflection content, optionally persisted.
2. Judged-response feedback (`src/services/judgedResponseFeedback.ts`): converts response quality signals into reinforcement context and persisted `self_reflections` records.

Both paths are designed to keep user-facing responses non-blocking if persistence fails.

## How It Works

### Reflection generation (`ai-reflections`)
- Entry point: `buildPatchSet()`.
- If `useMemory: true`, the generated patch is persisted with `saveSelfReflection()`.
- If `useMemory: false`, persistence is intentionally skipped (stateless mode).
- If OpenAI generation fails, a deterministic fallback patch is returned.

### Judged response feedback (`judgedResponseFeedback`)
- Entry points:
1. Manual route: `POST /reinforcement/judge`.
2. Automatic Trinity hook: `runThroughBrain()` calls `recordTrinityJudgedFeedback()` after CLEAR audit.
- Payload is validated and normalized (`prompt`, `response`, `score`, `scoreScale`).
- Score is normalized against `ARCANOS_CLEAR_MIN_SCORE` to determine `accepted`.
- A reinforcement context entry is registered (`source: audit`, positive/negative bias).
- A `self_reflections` row is attempted with category `judged-response`.

## Persistence Behavior
- Repository: `src/core/db/repositories/selfReflectionRepository.ts`.
- Persistence is lazy-bootstrapped:
1. Checks DB connectivity.
2. Attempts `initializeDatabase('self-reflections')`.
3. Ensures tables/indexes exist via `initializeTables()`.
- Failed bootstrap attempts are cooldown-throttled for 30s to avoid retry storms.
- If DB is unavailable, writes are skipped with warning and request flow continues.

The common warning:
`[🧠 Reflections] Database not connected; skipping persistence for self-reflection`
means response processing continued, but no reflection row was written.

## Startup Hydration
- On startup (`src/core/startup.ts`), ARCANOS calls `hydrateJudgedResponseFeedbackContext()`.
- It reloads recent persisted `judged-response` reflections into in-memory reinforcement context.
- Hydration is one-time per process unless test-reset with `resetJudgedFeedbackHydrationState()`.

## Safety and Guardrails
- Idempotency window: 5 minutes for judged feedback duplicate suppression.
- Bounded cache: `JUDGED_FEEDBACK_CACHE_MAX_ENTRIES` (default `2000`).
- Deep metadata sanitization:
1. Max depth and item caps.
2. Dangerous keys dropped (`__proto__`, `prototype`, `constructor`).
3. Circular references and non-plain objects safely handled.
4. Common secret/token patterns redacted before persistence.

## Runtime Metrics
Endpoint: `GET /reinforcement/metrics`

Returns:
- `judgedFeedback` telemetry (`attempts`, `duplicatesSkipped`, `persistedWrites`, `persistenceFailures`, cache stats).
- Reinforcement health snapshot (`mode`, `window`, `storedContexts`, `minimumClearScore`, etc.).

Use this endpoint to confirm judged feedback writes are happening and duplicates are being suppressed.

## Configuration

### Reinforcement core
| Variable | Default | Notes |
| --- | --- | --- |
| `ARCANOS_CONTEXT_MODE` | `reinforcement` | Set `off` to disable contextual recording. |
| `ARCANOS_CONTEXT_WINDOW` | `50` | Max in-memory reinforcement entries. |
| `ARCANOS_MEMORY_DIGEST_SIZE` | `8` | Digest size in contextual prompt rendering. |
| `ARCANOS_CLEAR_MIN_SCORE` | `0.85` | Acceptance threshold used in judged feedback normalization. |

### Judged feedback automation
| Variable | Default | Notes |
| --- | --- | --- |
| `TRINITY_JUDGED_FEEDBACK_ENABLED` | `true` | Enables automatic judged persistence from Trinity CLEAR audits. |
| `TRINITY_JUDGED_ALLOWED_ENDPOINTS` | `*` | Comma-separated allowlist for source endpoints (e.g. `ask,siri,mcp.trinity.ask`). |
| `JUDGED_FEEDBACK_CACHE_MAX_ENTRIES` | `2000` | In-memory idempotency cache cap. |

## Quick Test
```bash
curl -X POST http://localhost:3000/reinforcement/judge \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"p\",\"response\":\"r\",\"score\":9.2,\"scoreScale\":\"0-10\",\"feedback\":\"good\"}"

curl http://localhost:3000/reinforcement/metrics
```

## Troubleshooting
- `Database not connected; skipping persistence...`:
1. Verify `DATABASE_URL` is set and reachable from runtime.
2. Restart the service to allow bootstrap and table init.
3. Confirm writes via `/reinforcement/metrics` (`persistedWrites` increasing, low `persistenceFailures`).
- Unexpected auto-judge skips:
1. Check `TRINITY_JUDGED_FEEDBACK_ENABLED`.
2. Check `TRINITY_JUDGED_ALLOWED_ENDPOINTS` includes the emitting endpoint (`ask`, `brain`, `siri`, `mcp.trinity.ask`, etc.).

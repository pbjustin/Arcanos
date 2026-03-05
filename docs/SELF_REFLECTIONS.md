# Self Reflections

## What They Are
ARCANOS uses `self_reflections` for two related but different loops:

1. Reflection generation (`src/services/ai-reflections.ts`): produces patch-style improvement output.
2. Judged-response feedback (`src/services/judgedResponseFeedback.ts`): turns quality judgments into reinforcement signals and persisted records.

Both loops are fail-open for user response flow: if persistence fails, runtime execution still continues.

## Flow 1: Reflection Generation (`ai-reflections`)

Primary entrypoints:
- `buildPatchSet(options)`
- `generateComponentReflection(component, options)`
- `createImprovementQueue(priorities, options)`

Execution flow:
1. Resolve model/runtime options (model, token limits, temperature, prompt, cache).
2. Build reflection prompt with controlled fields (`priority`, `category`, memory mode).
3. Call OpenAI via `callOpenAI(...)`.
4. Build `PatchSet` output.
5. If `useMemory=true`, attempt persistence with `saveSelfReflection(...)`.
6. If generation fails, return deterministic fallback content from template helpers.

Behavior guarantees:
- `buildPatchSet` always returns a `PatchSet`.
- `useMemory=false` intentionally skips DB persistence (stateless mode).
- Persistence errors are logged and not re-thrown to caller.

## Flow 2: Judged-Response Feedback (`judgedResponseFeedback`)

Primary entrypoints:
- Manual API: `POST /reinforcement/judge` (`src/routes/reinforcement.ts`)
- Automatic hook: `recordTrinityJudgedFeedback(...)` from Trinity (`src/core/logic/trinityJudgedFeedback.ts`)

Execution flow:
1. Validate and normalize payload (`prompt`, `response`, `score`, `scoreScale`, metadata).
2. Normalize score against `ARCANOS_CLEAR_MIN_SCORE` and compute `accepted`.
3. Build idempotency key and suppress duplicates in a 5-minute window.
4. Register reinforcement context entry (`source: audit`, positive/negative bias).
5. Attempt `saveSelfReflection(...)` with category `judged-response`.
6. Return non-throwing result object including `persisted: boolean`.

Automatic Trinity path adds extra gates before writing:
- `TRINITY_JUDGED_FEEDBACK_ENABLED` must be `true`.
- Remaining runtime budget must be at least 2000 ms.
- CLEAR audit data must exist.
- Source endpoint must pass `TRINITY_JUDGED_ALLOWED_ENDPOINTS`.

## Persistence and Storage Model

Repository: `src/core/db/repositories/selfReflectionRepository.ts`

Write/read bootstrap strategy:
1. Check active DB connectivity.
2. If disconnected, attempt `initializeDatabase('self-reflections')`.
3. Ensure required tables/indexes with `initializeTables()`.
4. After a failed bootstrap, retry attempts are cooldown-throttled for 30 seconds.

Fail-open behavior:
- On write path, DB unavailability logs warning and skips persistence.
- On read path (`loadRecentSelfReflectionsByCategory`), DB unavailability returns `[]`.

`self_reflections` table shape (`src/core/db/schema.ts`):
- `id UUID PRIMARY KEY`
- `priority TEXT`
- `category TEXT`
- `content TEXT`
- `improvements JSONB`
- `metadata JSONB`
- `created_at TIMESTAMPTZ`

## Startup Hydration

During startup (`src/core/startup.ts`):
1. If DB initializes successfully, ARCANOS runs `hydrateJudgedResponseFeedbackContext()`.
2. Recent `judged-response` rows are loaded.
3. Entries are converted into in-memory reinforcement context for prompt augmentation.

Hydration is one-time per process unless tests call `resetJudgedFeedbackHydrationState()`.

## Safety and Data Hygiene

Judged-feedback path includes strong sanitization and bounded state:
- Idempotency cache window: 5 minutes.
- Cache cap: `JUDGED_FEEDBACK_CACHE_MAX_ENTRIES` (default `2000`).
- Metadata sanitation guards:
1. Max depth/key/array limits.
2. Dangerous keys removed (`__proto__`, `prototype`, `constructor`).
3. Circular reference handling.
4. Non-plain object coercion.
5. Secret pattern redaction (API keys, bearer tokens, common secret assignments).

## Runtime Observability

Endpoint: `GET /reinforcement/metrics`

Returns:
- `judgedFeedback` counters (`attempts`, `duplicatesSkipped`, `persistedWrites`, `persistenceFailures`, cache stats).
- `reinforcement` subsystem health snapshot (`mode`, `window`, `minimumClearScore`, context counts).

Use this endpoint to verify judged feedback behavior after deploy/restart.

## Configuration

### Reinforcement core
| Variable | Default | Notes |
| --- | --- | --- |
| `ARCANOS_CONTEXT_MODE` | `reinforcement` | Set `off` to disable contextual reinforcement recording. |
| `ARCANOS_CONTEXT_WINDOW` | `50` | Max in-memory reinforcement entries. |
| `ARCANOS_MEMORY_DIGEST_SIZE` | `8` | Digest size used in reinforcement prompt rendering. |
| `ARCANOS_CLEAR_MIN_SCORE` | `0.85` | Acceptance threshold for judged feedback normalization. |

### Trinity judged-feedback automation
| Variable | Default | Notes |
| --- | --- | --- |
| `TRINITY_JUDGED_FEEDBACK_ENABLED` | `true` | Enable automatic judged feedback from Trinity CLEAR audits. |
| `TRINITY_JUDGED_ALLOWED_ENDPOINTS` | `*` | Endpoint allowlist for auto-judged writes (`*` or CSV). |
| `JUDGED_FEEDBACK_CACHE_MAX_ENTRIES` | `2000` | In-memory duplicate-suppression cache cap. |

## Verification Checklist
```bash
curl -X POST http://localhost:3000/reinforcement/judge \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"p\",\"response\":\"r\",\"score\":9.2,\"scoreScale\":\"0-10\",\"feedback\":\"good\"}"

curl http://localhost:3000/reinforcement/metrics
```

Expected checks:
1. `persisted` is `true` when DB is healthy.
2. `judgedFeedback.attempts` increments.
3. Repeating the same payload quickly increments `duplicatesSkipped`.

## Troubleshooting

- Warning: `Database not connected; skipping persistence for self-reflection`
1. Verify `DATABASE_URL`.
2. Verify DB reachability from runtime environment.
3. Restart service and recheck `/reinforcement/metrics`.

- Auto-judged feedback not writing
1. Check `TRINITY_JUDGED_FEEDBACK_ENABLED=true`.
2. Confirm source endpoint is allowed by `TRINITY_JUDGED_ALLOWED_ENDPOINTS`.
3. Confirm request had enough `remainingBudgetMs` and included CLEAR audit output.

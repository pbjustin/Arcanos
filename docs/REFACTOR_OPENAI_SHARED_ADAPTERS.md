# Refactor: Shared OpenAI Adapters (Incremental)

This repo now centralizes **client construction** and **retry/backoff policy** in the workspace package:

- `packages/arcanos-openai/src/client.ts`
- `packages/arcanos-openai/src/retry.ts`
- `packages/arcanos-openai/src/resilience.ts`

## What moved (this step)

### Shared
- `createOpenAIClient({ apiKey, baseURL, defaultHeaders, timeoutMs })`
- `retryWithBackoff(fn, options)` + `isRetryableOpenAIError()`
- `OPENAI_RESILIENCE_DEFAULTS`

### Updated consumers
- `workers/src/infrastructure/sdk/openai.ts`
  - uses `createOpenAIClient()` for construction (instead of local `new OpenAI(...)`)
- `arcanos-ai-runtime/src/ai/openaiClient.ts`
  - uses `createOpenAIClient()` for construction

## Next incremental steps
1. Wrap worker and runtime OpenAI calls with `retryWithBackoff()` where appropriate (rate limits, 5xx, network).
2. Extract a shared `OpenAIAdapter` interface (responses/chat/embeddings) into `@arcanos/openai` and have:
   - backend `src/services/openai/chatFlow/`
   - workers `workers/src/infrastructure/sdk/openai.ts`
   - runtime `arcanos-ai-runtime/src/ai/openaiClient.ts`
   converge on that single surface.
3. Fold backend-only telemetry/circuit-breaker into thin wrappers (platform layer), keeping the shared package dependency-free.
## Added (current): Staged call pipeline (`chatFlow`) and staged request builders

The backend `src/services/openai/chatFlow/` is now a **thin wiring layer** only.
All real logic lives in:

- `packages/arcanos-openai/src/unifiedClient.ts`

This shared implementation is dependency-injected so it can remain portable while still allowing the backend to provide:

- credential resolution (`resolveOpenAIKey`, `resolveOpenAIBaseURL`)
- adapter boundary (`createOpenAIAdapter`, `getOpenAIAdapter`)
- logging/telemetry (`aiLogger`, `recordTraceEvent`)
- circuit breaker snapshot for health checks

### Runtime import
- Backend uses staged pipelines:
  - `src/services/openai/chatFlow/`
  - `src/services/openai/requestBuilders/`
  and relies on shared package utilities where appropriate.



## Responses-first helpers (current)
- Shared output parsing: `packages/arcanos-openai/src/responseParsing.ts`
- Shared request staging:
  - `src/services/openai/chatFlow/` (prepare/execute/parse/trace)
  - `src/services/openai/requestBuilders/` (build/normalize/convert/validate)

## Data retention
Responses requests default to `store: false`. Override via `OPENAI_STORE=true`.

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
   - backend `src/services/openai/unifiedClient.ts`
   - workers `workers/src/infrastructure/sdk/openai.ts`
   - runtime `arcanos-ai-runtime/src/ai/openaiClient.ts`
   converge on that single surface.
3. Fold backend-only telemetry/circuit-breaker into thin wrappers (platform layer), keeping the shared package dependency-free.
## Added (this step): Shared `unifiedClient` implementation

The backend `src/services/openai/unifiedClient.ts` is now a **thin wiring layer** only.
All real logic lives in:

- `packages/arcanos-openai/src/unifiedClient.ts`

This shared implementation is dependency-injected so it can remain portable while still allowing the backend to provide:

- credential resolution (`resolveOpenAIKey`, `resolveOpenAIBaseURL`)
- adapter boundary (`createOpenAIAdapter`, `getOpenAIAdapter`)
- logging/telemetry (`aiLogger`, `recordTraceEvent`)
- circuit breaker snapshot for health checks

### Runtime import
- Backend continues to import `./openai/unifiedClient.js` (unchanged), but that module is now just a bridge.
- If you want to import directly, use: `@arcanos/openai/unifiedClient`


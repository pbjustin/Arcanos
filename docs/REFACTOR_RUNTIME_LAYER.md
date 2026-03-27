# Runtime Layer Refactor Notes

## What changed
To reduce confusion between `src/runtime/` and `src/platform/runtime/`, the **time-budgeted execution primitives** were moved into the platform resilience layer, and the **structured reasoning parse** helper was moved into the OpenAI service layer.

### New canonical modules
- `src/platform/resilience/runtimeBudget.ts`
- `src/platform/resilience/runtimeErrors.ts`
- `src/services/openai/structuredReasoning.ts`

### Backward compatibility
The temporary `src/runtime/*` compatibility wrappers have now been retired. Import the canonical modules directly:
- `src/platform/resilience/runtimeBudget.ts`
- `src/platform/resilience/runtimeErrors.ts`
- `src/services/openai/structuredReasoning.ts`

## Why
- `src/platform/*` already contains cross-cutting infra (logging, env, resilience).
- A folder named `src/runtime/` alongside `src/platform/runtime/` created ambiguity.
- Budget/timeouts and abort semantics are resilience concerns.
- OpenAI response parsing belongs in the OpenAI service layer.

## Migration guidance
Prefer:
- `@platform/resilience/runtimeBudget`
- `@platform/resilience/runtimeErrors`
- `@services/openai` (export: `runStructuredReasoning`) or `@services/openai/structuredReasoning`

The old `src/runtime/openaiClient.ts` path was removed earlier and should not be referenced.

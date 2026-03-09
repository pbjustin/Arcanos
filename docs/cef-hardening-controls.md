# CEF Hardening Controls

This document summarizes the current hardening controls around the Command Execution Framework (CEF).

## 1. Handler method whitelists

- CEF handler modules expose explicit `allowedHandlers` lists.
- Current modules:
  - `src/services/cef/handlers/auditSafe.handler.ts`
  - `src/services/cef/handlers/ai.handler.ts`
- Every dispatch path calls `enforceAllowedHandlerMethod(...)` before schema validation or side effects.

## 2. No open-ended handler execution

- `commandCenter` no longer stores generic per-command `execute(payload)` callbacks.
- Commands now route through domain-specific dispatchers:
  - `dispatchAuditSafeHandler(...)`
  - `dispatchAiHandler(...)`
- The remaining brain abstraction was also renamed from `execute(...)` to `runPrompt(...)` to remove the generic execution entrypoint from tracked app code.

## 3. Full boundary tracing

- All handler flows emit CEF boundary traces through `src/services/cef/boundaryTrace.ts`.
- Expected handler events:
  - `cef.handler.start`
  - `cef.handler.success`
  - `cef.handler.error`
  - `cef.handler.fallback`
- Schema failures also emit:
  - `cef.schema.invalid_payload`
  - `cef.schema.invalid_output`

## 4. Schema enforcement

- Payload and output validation happens inside `src/services/cef/handlerRuntime.ts`.
- Validation uses `zod`, which satisfies the "ajv or similar" requirement while staying aligned with the existing CEF type contracts.
- Invalid payloads fail fast before any handler-side effect code runs.

## 5. CI layer-access checks

- `scripts/check-cef-layer-access.js` scans planner and capability source files for direct infrastructure imports.
- The build now runs `npm run check:cef-layer-access` automatically, so CI fails if planner/capability code imports filesystem, DB, storage/infrastructure, or external API modules directly.

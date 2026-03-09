# CEF Hardening Controls

This document summarizes the current hardening controls around the Command Execution Framework (CEF).

## 1. Handler method whitelists

- CEF handler modules expose explicit `allowedHandlers` lists derived from action maps.
- Current modules:
  - `src/services/cef/handlers/auditSafe.handler.ts`
  - `src/services/cef/handlers/ai.handler.ts`
- Every dispatch path calls `enforceAllowedHandlerMethod(...)` before schema validation or side effects.
- Disallowed actions fail closed with `HANDLER_ACTION_NOT_ALLOWED` and HTTP status `403`.

## 2. No open-ended handler execution

- `commandCenter` no longer stores generic per-command `execute(payload)` callbacks.
- Commands now route through explicit domain dispatcher maps and handler action maps:
  - `dispatchAuditSafeHandler(...)`
  - `dispatchAiHandler(...)`
- Protected CEF files are tested to ensure unsafe `execute(payload)` signatures do not reappear.

## 3. Full boundary tracing

- All handler flows emit CEF boundary traces through `src/services/cef/boundaryTrace.ts`.
- Dispatch events:
  - `cef.dispatch.start`
  - `cef.dispatch.success`
  - `cef.dispatch.error`
  - `cef.dispatch.rejected`
- Handler events:
  - `cef.handler.start`
  - `cef.handler.success`
  - `cef.handler.error`
  - `cef.handler.fallback`
  - `cef.handler.retry`
- Schema failures also emit:
  - `cef.schema.invalid_payload`
  - `cef.schema.invalid_output`
- Every persisted trace now includes:
  - `traceId`
  - `command`
  - `handler`
  - `timestamp`
  - `status`
  - `durationMs`
  - `errorCode`
  - `fallbackUsed`
  - `retryCount`

## 4. Schema enforcement

- Payload and output validation happens inside `src/services/cef/handlerRuntime.ts`.
- Validation uses an Ajv-backed registry in `src/services/cef/schemaRegistry.ts`.
- Command input, output, and error schemas are registered centrally in `src/services/cef/schemaDefinitions.ts`.
- Command registration fails closed if any declared schema is missing.
- Invalid payloads fail fast before any handler-side effect code runs and emit `cef.schema.invalid_payload`.

## 5. CI layer-access checks

- `scripts/check-boundaries.js` and `scripts/check-cef-layer-access.js` scan planner/capability/agent boundary files for direct infrastructure imports.
- Blocked imports include filesystem/process modules, path-based storage wiring, DB clients/ORMs, storage adapters, external API clients, and queue clients.
- The build and type-check flows now run both:
  - `npm run check:boundaries`
  - `npm run check:cef-layer-access`

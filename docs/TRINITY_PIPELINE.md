# Trinity Pipeline

## Overview
The Trinity pipeline is the main AI orchestration path in this codebase. It receives a user prompt, applies memory and audit-safe constraints, runs a 3-stage model flow, and returns a structured `TrinityResult`.

Primary entrypoint:
- `src/core/logic/trinity.ts` (`runThroughBrain`)

Core stage modules:
- `src/core/logic/trinityStages.ts`
- `src/core/logic/trinityTier.ts`
- `src/core/logic/trinityGuards.ts`
- `src/core/logic/trinityTypes.ts`

## What It Does
At runtime, Trinity:
1. Classifies prompt complexity (`simple`, `complex`, `critical`).
2. Applies audit-safe mode and captures audit flags.
3. Loads relevant memory context for continuity.
4. Runs the model pipeline:
   - ARCANOS intake framing
   - GPT-5.1 reasoning
   - ARCANOS final synthesis
5. Optionally runs a reflection pass for `critical` prompts.
6. Post-processes final text through a mid-layer translator (artifact stripping and tone cleanup).
7. Writes audit lineage logs, records telemetry, updates per-session token accounting, and returns structured metadata.

## End-to-End Flow
`runThroughBrain(client, prompt, sessionId?, overrideFlag?, options?)` in `src/core/logic/trinity.ts`:

1. Pre-flight
   - Generates `requestId`.
   - Detects tier via `detectTier(prompt)`.
   - Initializes guardrails: invocation budget, retry lineage registration, and later watchdog + semaphore.
   - Resolves audit-safe config (`getAuditSafeConfig`) and memory context (`getMemoryContext`).
   - Computes memory score summary for response metadata.

2. Optional dry run short-circuit (`options.dryRun === true`)
   - Applies audit-safe constraints to the prompt.
   - Builds routing preview only (no model invocation).
   - Returns a `TrinityResult` with:
     - `module: "dry_run"`
     - `dryRun: true`
     - `dryRunPreview` populated
     - fallback flags all false

3. Stage 1: ARCANOS intake
   - Validates configured default model; if unavailable, falls back to `gpt-4.1-mini`.
   - Calls `runIntakeStage(...)`:
     - system prompt: `ARCANOS_SYSTEM_PROMPTS.INTAKE(memoryContextSummary)`
     - user prompt: audit-safe transformed prompt
     - token limit: `TRINITY_INTAKE_TOKEN_LIMIT` (500)
     - temperature: derived from `cognitiveDomain` (if provided)
   - Output is a framed request for reasoning.

4. Stage 2: GPT-5.1 reasoning
   - Calls `runReasoningStage(...)` with framed request.
   - Uses `createGPT5Reasoning(...)` with `ARCANOS_SYSTEM_PROMPTS.GPT5_REASONING()`.
   - Captures reasoning output, model used, and error/fallback state.

5. Stage 2.5: Critical-tier reflection (conditional)
   - Only for `tier === "critical"`.
   - Calls `runReflection(...)` to critique reasoning output for flaws/risk/security assumptions.
   - If successful, appends critique to reasoning output and marks `reflectionApplied`.

6. Stage 3: ARCANOS final synthesis
   - Calls `runFinalStage(...)`:
     - model: `getComplexModel()`
     - token cap enforced by `enforceTokenCap(...)` (hard cap `TRINITY_HARD_TOKEN_CAP = 1200`)
     - messages include:
       - final review system prompt
       - original request
       - GPT-5.1 analysis
       - final response instruction
   - Result text then passes through `MidLayerTranslator.translate(...)` to remove system/audit artifacts and humanize output.

7. Post-processing and observability
   - Validates final output against audit-safe policy (`validateAuditSafeOutput`).
   - Stores successful interaction patterns in memory when safe and no intake/final fallback occurred (`storePattern`).
   - Writes audit lineage log entry (`logAITaskLineage`).
   - Records session token usage (`recordSessionTokens`) and enforces session token ceiling.
   - Detects model downgrade and latency drift; emits Trinity telemetry.
   - Returns `TrinityResult` with:
     - core output/result
     - fallback summary
     - audit + memory context
     - lineage IDs
     - tier/guard metadata

## Tiering (UTAL)
Implemented in `src/core/logic/trinityTier.ts`.

Tier detection logic:
- `critical`: prompt length >= 500 and at least 2 complexity keywords
- `complex`: prompt length >= 300 or at least 1 complexity keyword
- `simple`: otherwise

Injection guard:
- If prompt includes forbidden phrases (for example `"set tier to"`), tier is forced to `simple`.

Invocation budget by tier:
- `simple`: 1
- `complex`: 2
- `critical`: 4

## Guardrails
Implemented in `src/core/logic/trinityGuards.ts`.

1. Concurrency governor (per tier semaphore)
   - `simple`: 100
   - `complex`: 40
   - `critical`: 10

2. Watchdog timeout
   - Default 28,000 ms
   - Throws when exceeded

3. Token caps
   - Hard cap: 1200 tokens (`TRINITY_HARD_TOKEN_CAP`)

4. Session token auditor
   - Per-session limit: 20,000 tracked tokens

5. Retry lineage guard
   - Max retries per lineage: 3

6. Downgrade + telemetry logging
   - Logs if actual GPT-5.1 model differs from requested model family
   - Emits pipeline completion telemetry with tier/tokens/latency/reflection data

## Model Fallback Behavior
`createChatCompletionWithFallback` (used in intake and final stages) attempts:
1. Primary model
2. Primary retry
3. GPT-5.1 fallback
4. Final fallback model

Reasoning stage (`createGPT5Reasoning`) is GPT-5.1-first and validates response model family. On failure, it returns fallback text plus an `error` value that Trinity records in `gpt5Error`/`fallbackSummary`.

## Output Contract
`TrinityResult` (defined in `src/core/logic/trinityTypes.ts`) includes:
- `result`: final user-facing text
- `activeModel`, `gpt5Model`, `routingStages`
- `fallbackFlag` and per-stage `fallbackSummary`
- `auditSafe` status + flags
- `memoryContext` stats and summary
- `taskLineage.requestId`
- `meta` IDs/timestamps/tokens
- optional:
  - `dryRunPreview`
  - `tierInfo`
  - `guardInfo`

## Where Trinity Is Used
Main call sites:
- `src/routes/ask.ts` (`/ask`, `/brain`)
- `src/routes/siri.ts`
- `src/transport/http/controllers/aiController.ts` (`/write`, `/guide`, `/audit`, `/sim`)
- `src/routes/gptRouter.ts`
- `src/services/arcanosPrompt.ts`
- `src/platform/runtime/workerContext.ts`

Behavior difference worth noting:
- `src/routes/ask.ts` is the only route that currently passes `options.cognitiveDomain` into Trinity; most other call sites use default stage temperature behavior.

## Trinity vs Legacy Pipeline Route
There is also a separate legacy pipeline route:
- `POST /arcanos-pipeline` in `src/routes/openai-arcanos-pipeline.ts`
- implementation in `src/services/arcanosPipeline.ts`

That route uses a different multi-step pipeline and is not the same as `runThroughBrain`.

## Quick Test Plan
Minimal verification checklist:
1. Happy path
   - Call `/ask` with a normal prompt and confirm `routingStages`, `fallbackSummary`, `auditSafe`, and `memoryContext` fields are present.
2. Dry run
   - Invoke Trinity with `{ dryRun: true }` and confirm no model calls are made and `module === "dry_run"`.
3. Failure/fallback
   - Force model unavailability and confirm fallback flags/reasons are populated.
4. Critical reflection
   - Send a long, security/architecture-heavy prompt and confirm `tierInfo.tier === "critical"` and reflection metadata behavior.

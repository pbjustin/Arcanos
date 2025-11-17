# Trinity Pipeline Overview

The Trinity brain is ARCANOS' universal AI execution pipeline. Every conversational entry point—including `/ask`, `/brain`, and the Custom GPT dispatcher—delegates to this three-stage workflow so that request validation, GPT-5.1 reasoning, memory recall, and audit logging are consistently applied before a response leaves the server. This document explains how the pipeline is wired into the Express surface area and how each stage collaborates with supporting services such as memory awareness, audit-safe enforcement, and logging.

## Request lifecycle

1. **Client hits a conversational route.** The `/ask` and `/brain` routes share `handleAIRequest`, which runs security middleware, validation, and request logging before handing control to the Trinity brain. 【F:src/routes/ask.ts†L10-L85】
2. **`runThroughBrain` orchestrates the pipeline.** The exported function in `src/logic/trinity.ts` is the canonical entry point for AI processing and is always invoked from the routes above (and any other module that needs a general-purpose response). 【F:src/logic/trinity.ts†L1-L205】
3. **Metadata flows back to the caller.** The result object includes routing stages, memory context, and audit status so upstream clients can understand how the response was produced. 【F:src/logic/trinity.ts†L41-L79】【F:src/logic/trinity.ts†L229-L278】

Because this pipeline is centralized, any new route can opt into Trinity simply by calling `runThroughBrain` with the OpenAI client, prompt, session ID, and optional audit overrides; no additional wiring is required to inherit memory or compliance guardrails.

## Stage 1 – ARCANOS Intake

The intake phase prepares the prompt and decides which base model will chaperone GPT-5.1's reasoning output back into an operator-ready answer.

- **Model validation and fallback.** `validateModel` attempts to retrieve the configured fine-tuned model and falls back to GPT‑4 if the model is unavailable, logging the decision for observability. 【F:src/logic/trinity.ts†L81-L111】
- **Audit-safe framing.** `getAuditSafeConfig` inspects the prompt (and optional `overrideAuditSafe` flag) to determine whether audit-safe mode should stay enabled. The helper can also detect explicit override language and records override metadata. `applyAuditSafeConstraints` then wraps the prompt with compliance instructions and tracks any detected sensitive keywords in `auditFlags`. 【F:src/logic/trinity.ts†L145-L157】【F:src/services/auditSafe.ts†L44-L134】
- **Memory context retrieval.** `getMemoryContext` pulls up to five relevant past entries, prioritizing session continuity, keyword overlap, and recency. The resulting `contextSummary` is inserted into ARCANOS’ system prompt so GPT-5.1 receives continuity hints without every route needing to re-implement memory lookups. 【F:src/logic/trinity.ts†L148-L160】【F:src/services/memoryAware.ts†L200-L281】
- **Intake completion.** With the audited prompt and memory summary in hand, `createChatCompletionWithFallback` runs the ARCANOS intake system prompt, which reframes the request for GPT-5.1. The selected model and fallback state are recorded in `routingStages` (e.g., `ARCANOS-INTAKE:ft-model`). 【F:src/logic/trinity.ts†L158-L172】

## Stage 2 – GPT-5.1 Reasoning

Once the intake step produces a framed request, Trinity unconditionally calls GPT-5.1:

- `logGPT5Invocation` records telemetry and `routingStages` adds `GPT5-REASONING` so clients can confirm GPT-5.1 handled the analysis. 【F:src/logic/trinity.ts†L173-L176】
- `createGPT5Reasoning` runs the dedicated reasoning prompt (see `ARCANOS_SYSTEM_PROMPTS.GPT5_REASONING`) and returns structured data: the model that responded, the synthesized reasoning content, and any transport errors. Successes and failures are logged through `structuredLogging`. 【F:src/logic/trinity.ts†L176-L191】
- The GPT-5.1 output is not returned directly to the user. Instead, it becomes part of the next stage’s conversation so ARCANOS can reinterpret, censor, or contextualize it as needed.

## Stage 3 – ARCANOS Execution

The final stage turns GPT-5.1’s analysis into a user-facing response and enforces safety guarantees:

- `ARCANOS-FINAL` routing: Trinity logs that the response is back under ARCANOS control and injects the memory summary plus audit directives into the system prompt. The GPT-5.1 transcript is supplied as an assistant message so ARCANOS can critique or trim it before answering. 【F:src/logic/trinity.ts†L193-L210】
- **Audit validation.** After generating the final text, `validateAuditSafeOutput` scans for non-compliant patterns. Failed checks append `FINAL_OUTPUT_VALIDATION_FAILED` to `auditFlags`, signaling downstream monitoring that manual review might be required. 【F:src/logic/trinity.ts†L212-L216】【F:src/services/auditSafe.ts†L161-L181】
- **Learning hooks.** Successful, non-fallback runs store a summarized “pattern” that captures the input snippet, GPT-5.1 output, and final message. This feeds the memory-aware service so recurring structures become easier to reuse. 【F:src/logic/trinity.ts†L217-L227】【F:src/services/memoryAware.ts†L337-L351】
- **Audit log entry.** Trinity assembles an `AuditLogEntry` with model pairings, audit-safe state, memory accesses, and routing flags, then persists it via `logAITaskLineage`. 【F:src/logic/trinity.ts†L229-L277】【F:src/services/auditSafe.ts†L137-L156】

The returned payload exposes the selected model, whether any fallback occurred, GPT-5.1 metadata, audit-safe status, memory usage, routing stages, and the request’s lineage ID. Consumers can therefore correlate client-side telemetry with server-side logs when debugging. 【F:src/logic/trinity.ts†L41-L79】【F:src/logic/trinity.ts†L229-L278】

## Supporting services

### Memory-aware reasoning

`src/services/memoryAware.ts` centralizes long-term memory. Trinity only needs to call `getMemoryContext` and optionally `storePattern`; the service handles scoring, logging, and persistence under `/tmp/arc/memory` (or the configured path). Developers can enrich other modules with the same helpers to share context with Trinity. 【F:src/services/memoryAware.ts†L38-L190】【F:src/services/memoryAware.ts†L200-L351】

### Audit-safe enforcement

`src/services/auditSafe.ts` keeps Trinity compliant by default. It determines when overrides are allowed, decorates prompts with audit reminders, and writes both JSON and human-readable lineage logs for every request. Other modules that bypass Trinity should still import these helpers to remain compliant. 【F:src/services/auditSafe.ts†L1-L156】

### OpenAI transport wrappers

`src/services/openai.ts` exposes `createChatCompletionWithFallback` and `createGPT5Reasoning`, abstracting retries, fallback model swaps, and consistent usage logging. Trinity imports these helpers so its core logic stays focused on orchestration instead of low-level API plumbing. 【F:src/logic/trinity.ts†L23-L209】

## Extending the pipeline

- **New HTTP routes:** Build an Express handler that validates input and then calls `runThroughBrain`. The handler automatically receives Trinity’s response structure, so adding telemetry or forwarding metadata to clients is straightforward. 【F:src/routes/ask.ts†L50-L86】
- **Custom GPT modules:** The `/api/ask` shim and GPT router already normalize payloads and tag them with module hints before Trinity runs. By leaning on the dispatcher, custom modules can trust that GPT-5.1 reasoning, audit logging, and memory recall have all executed before their specialized logic fires. 【F:docs/CUSTOM_GPT_ASK_PIPELINE.md†L1-L30】
- **Downstream automations:** If a worker or module needs Trinity-style guardrails but not the whole HTTP layer, import `runThroughBrain` directly. The function accepts any OpenAI client instance and prompt, making it portable across CLI tools, background jobs, and cron tasks.

With this architecture, Trinity serves as the connective tissue between ARCANOS’ security layers, memory service, and AI transports. Centralizing these responsibilities in `src/logic/trinity.ts` keeps every user interaction auditable, reproducible, and enriched with contextual intelligence.

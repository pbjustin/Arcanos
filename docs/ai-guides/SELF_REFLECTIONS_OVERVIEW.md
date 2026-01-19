# Self-Reflection System Overview

This guide explains how ARCANOS generates self-reflections, the components that
power the workflow, and how developers can extend or invoke the system. It
complements the scheduler-specific notes in
[`AI_REFLECTION_SCHEDULER_GUIDE.md`](./AI_REFLECTION_SCHEDULER_GUIDE.md) by
focusing on the core services that produce reflection content.

## Why self-reflections exist

Self-reflections provide short, actionable improvement notes that help engineers
iterate on ARCANOS. Reflections can be triggered manually, scheduled on a timer,
or produced in response to other automation. Every reflection describes the
state of the system, proposes improvements, and records metadata about the
conditions under which it was generated. Reflections are also written to the
self-reflection repository so teams can review historical output or feed it into
other analytics tooling.

## Key components

### AI Reflection Service (`src/services/ai-reflections.ts`)

`buildPatchSet` is the primary entry point for generating a reflection. It
prepares an instruction prompt, invokes the OpenAI gateway, persists the
resulting record, and normalises the result into a "patch set" structure
containing:

- the raw reflection text (`content`)
- a priority bucket (`low`, `medium`, or `high`)
- a category label that callers can control (for example, `component-api`)
- a list of improvement notes that describe what happened inside the service
- metadata, including timestamps, model details, cache usage, the
  `systemAnalysis` snapshot (when enabled), and whether the service ran with
  memory orchestration enabled

The function is highly configurable through its `PatchSetOptions` argument:
callers can toggle memory integration, select a specific model, tune sampling
parameters, override the system prompt, add custom AI metadata, skip system
analysis, and opt in or out of cached responses. If the OpenAI call fails, the
service produces a deterministic fallback patch, persists it to the
self-reflection store, and captures the error so downstream systems can continue
operating.

Two helpers build on top of `buildPatchSet`:

- `generateComponentReflection(component, options)` namespaces the category with
  `component-${component}` so you can target specific subsystems without
  rewriting the orchestration logic.
- `createImprovementQueue(priorities, options)` returns multiple patch sets in
  the requested priority order, which is useful when a workflow wants to process
  several levels of urgency in a single batch.

### Persistence layer (`src/db/repositories/selfReflectionRepository.ts`)

`buildPatchSet` always calls `saveSelfReflection` so that every reflection—real
or fallback—lands in the database. The repository abstracts the storage engine
and lets consumers query historic reflections for dashboards, audits, or manual
reviews. Failures are logged but do not halt the reflection pipeline, ensuring
that transient storage outages do not block automation.

### OpenAI gateway (`src/services/openai.ts`)

The reflection service delegates all model interactions to `callOpenAI`. This
wrapper handles client initialisation, circuit breaking, exponential backoff,
caching, and mock responses. When no API key is configured, `callOpenAI` returns
deterministic mock data so reflections can still be generated during local
development or in restricted environments. The gateway also surfaces whether a
response was served from cache so the reflection metadata can record it.

### Git integration (`src/services/git.ts`)

Reflections often become automated pull requests. The `generatePR` helper
consumes the patch data and can either execute the documented five-step workflow
(force-checkout, hard reset, merge with `ours`, and force push) or simply report
how it would run when a workflow is operating in stateless mode. Turning off the
`verifyLock` flag makes it explicit that the caller is bypassing any long-term
memory locks, which pairs nicely with stateless reflection runs.

### Developer test harness (`tests/test-stateless-pr.ts`)

The repository includes a TypeScript script that exercises the entire reflection
pipeline in stateless mode. It builds a patch set, prints the resulting
metadata, and then drives the PR helper. The test script is a practical example
of how to orchestrate the services without touching the production scheduler.

## End-to-end flow

1. A caller decides to produce a reflection, either manually, through the test
   harness, or via an automation trigger.
2. The caller chooses configuration options (priority, category, memory mode,
   sampling parameters, cache preferences, etc.) and invokes `buildPatchSet`.
3. `buildPatchSet` composes the natural-language prompt and sends it to
   `callOpenAI` along with metadata that is useful for analytics and caching.
4. When a response arrives, the service captures the content, system state
   snapshot (when enabled), and model metadata in a structured object. If the
   call fails, it emits a fallback patch with diagnostic details.
5. The resulting patch set is persisted, can be pushed to GitHub, or fed into
   other automations (for example, to create a pull request via `generatePR`).
6. Optional clean-up or pruning jobs remove stale reflections to keep storage
   tidy. See the scheduler guide for long-running orchestration patterns.

## Configuration reference

`buildPatchSet` reads several environment variables so that default behaviour
can be tuned without code changes:

| Variable | Purpose |
| --- | --- |
| `AI_REFLECTION_MODEL` | Default model identifier (falls back to the runtime default) |
| `AI_REFLECTION_TOKEN_LIMIT` | Maximum tokens requested from the model |
| `AI_REFLECTION_TEMPERATURE` | Sampling temperature used for the reflection prompt |
| `AI_REFLECTION_TOP_P` | Top-p sampling cut-off |
| `AI_REFLECTION_FREQUENCY_PENALTY` | Frequency penalty passed to the API |
| `AI_REFLECTION_PRESENCE_PENALTY` | Presence penalty passed to the API |
| `AI_REFLECTION_SYSTEM_PROMPT` | Override for the system prompt that frames the reflection |
| `AI_REFLECTION_CACHE` | Enables or disables the shared response cache |

If none of these variables are set, the service uses safe defaults so that
reflections remain deterministic and concise.

The OpenAI gateway relies on `OPENAI_API_KEY` (or compatible aliases) and logs a
clear warning when it falls back to mock mode. The scheduler guide covers
additional GitHub and automation variables that apply when reflections are run
on a timer.

## Working with stateless mode

Passing `{ useMemory: false }` into `buildPatchSet` instructs the service to
skip any memory-orchestration logic. This is ideal for local development or
rapid experimentation because it avoids touching long-term state. The generated
metadata records the mode so downstream consumers can make informed decisions.
When combined with `generatePR({ forcePush: true, verifyLock: false, ... })`,
you get a fully stateless pipeline from reflection to automated PR, exactly as
demonstrated in the test harness.

## Next steps

- Consult the scheduler guide if you need a long-running background job that
automates reflections.
- Extend the patch metadata if your workflow needs to record extra diagnostic
information—`aiMetadata` in `PatchSetOptions` is forwarded to the OpenAI call.
- Integrate with other persistence layers or notification channels after a
reflection is generated; the patch structure is intentionally serialisable so it
can be stored as JSON or fed into templating pipelines.

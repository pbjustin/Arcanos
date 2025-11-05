# Why ARCANOS Fine-Tunes with OpenAI

## Context

ARCANOS delivers player assistance that depends on nuanced language understanding, safety-aware reasoning, and fast iteration. To keep those promises we regularly specialize frontier models on curated gameplay transcripts, routing prompts, and escalation guidelines. This document records why OpenAI's managed fine-tuning stack is our chosen path for those specializations.

## Decision summary

- **Model quality stays aligned with the base frontier release.** OpenAI updates the `gpt-4.1` series with safety and reasoning improvements that carry through to derivative fine-tunes. We inherit those updates automatically while retaining our reinforcement data, so new abilities reach ARCANOS without a costly migration cycle.
- **Operational maturity matches our availability targets.** OpenAI's hosting layer absorbs burst traffic from live events and balances regional capacity. We avoid running bespoke GPU fleets while still meeting the latency targets documented in `ARCANOS_IMPLEMENTATION.md`.
- **Integrated safety rails.** Their policy filters, audit logs, and red-teaming hooks dovetail with the safety requirements in `secure-reasoning-engine.md`. Using the managed service lets us plug straight into model-spec audits without rebuilding tooling.
- **Tight fit with our runtime shim.** The SDK and response formats mirror the interfaces described in [`src/services/openai.ts`](../src/services/openai.ts) and [`openai-runtime-overview.md`](openai-runtime-overview.md), so routing logic and memory management stay unchanged when we promote a new fine-tune.
- **Predictable cost of iteration.** Token accounting, queue depth controls, and fine-tune job monitoring are bundled, giving product teams a known marginal cost for each batch of new data.

## Example: current production fine-tune

Our active model is `ft:gpt-4.1-2025-14:personal:arca`, created on **25 Aug 2025 at 01:50 UTC** via supervised fine-tuning on `gpt-4.1-2025-04-14`. The run consumed **1,920,780** training tokens over **3 epochs** with shared data retention to keep evaluation tooling available across teams.

This model powers the production routing profile named **"Arcanos"**, giving us:

- Consistent adherence to escalation scripts gathered from live support reviews.
- Higher accuracy on puzzle classification prompts that inform downstream tool calls.
- Embedded metadata that aligns with the `OpenAIRuntime` session metadata hooks for tracing model provenance.

## Alternatives considered

| Option | Outcome | Why it lost |
| --- | --- | --- |
| Self-hosted open-source (e.g., Llama 3 fine-tunes) | Prototype hit latency spikes and required manual GPU failover. | Hardware orchestration would replicate work we already offload to OpenAI, and we would lose the turnkey policy toolchain. |
| Third-party managed fine-tunes (e.g., Mosaic, Anyscale) | Evaluation passes showed higher moderation drift. | They lack feature parity with the OpenAI routing APIs we rely on, introducing integration risk and rework across `createCentralizedCompletion`. |
| Prompt-only specialization | Easier to ship in the short term. | Prompt complexity grew to the point where the router became brittle, and we could not keep up with the volume of per-title safety adjustments. |

## Operational implications

- **Deployment cadence.** Fine-tune artifacts are versioned by OpenAI; rotating to a new suffix is as simple as updating the model identifier in our configuration files. The runtime shim handles the rest.
- **Monitoring.** Training telemetry, job status, and lineage data are centralized in the OpenAI dashboard, reducing the bespoke monitoring we maintain in `PROBOT_SETUP.md` and the observability integrations described in `BACKGROUND_WORKERS.md`.
- **Compliance.** Data sharing is restricted to internal teams via the "Shared" visibility mode. Audit requests map directly to OpenAI's lineage logs, shortening the evidence cycle we need for the `DOCUMENTATION_AUDIT_SUMMARY.md` controls.

## Future considerations

We will continue to revisit the decision as alternative providers add feature parity in:

1. **Safety tooling** that can enforce multi-layer policy gates without custom engineering.
2. **Streaming latencies** competitive with the managed `gpt-4.1` tier during seasonal load.
3. **Lifecycle automation** that matches the one-click rollback and version pinning currently provided by OpenAI.

Until those criteria are met, OpenAI remains the most efficient and reliable path for keeping ARCANOS' language engine aligned with player needs.

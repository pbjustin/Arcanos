# AI Guides Index

> **Last Updated:** 2025-02-15 | **Status:** Curated for active modules

This directory collects deep dives, recovery playbooks, and historical notes for
Arcanos AI services. Use this index to jump to the most relevant guidance and to
confirm which experiments are still supported by the current codebase.

## Navigation

- **Resilience & Dispatch**
  - [AI_PATCH_SYSTEM_GUIDE](AI_PATCH_SYSTEM_GUIDE.md) – Patch orchestration and
    resilience envelopes for OpenAI calls.
  - [AI_DISPATCHER_REFACTOR_GUIDE](AI_DISPATCHER_REFACTOR_GUIDE.md) – Stateless
    dispatch patterns for router workers.
  - [GPT_DIAGNOSTICS_GUIDE](GPT_DIAGNOSTICS_GUIDE.md) – Debugging and observability
    for GPT-facing services.
- **Memory & Context**
  - [UNIVERSAL_MEMORY_GUIDE](UNIVERSAL_MEMORY_GUIDE.md) – Cross-session memory
    lifecycle and cache invalidation.
  - [MEMORY_OPTIMIZATION](MEMORY_OPTIMIZATION.md) – Tuning recall costs and
    TTLs across store backends.
- **Pipelines & Integrations**
  - [FINETUNE_PIPELINE](FINETUNE_PIPELINE.md) – Dataset checks and rollout
    stages.
  - [GITHUB_INTEGRATION_GUIDE](GITHUB_INTEGRATION_GUIDE.md) – GitHub App
    callbacks and safety rails.
  - [STATELESS_PR_README](STATELESS_PR_README.md) – Stateless PR assistant
    contract.

See `docs/README.md` for how these guides map to production routes and the
current documentation audit priorities.

## Retired

- `CLARKE_HANDLER_GUIDE.md` – Removed because the resilience pattern was folded
  into the OpenAI patch system and dispatcher refactor guides above.

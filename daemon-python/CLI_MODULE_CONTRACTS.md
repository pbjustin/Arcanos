# CLI Module Contracts

This document defines architectural invariants for the modular ARCANOS Python CLI.

## `arcanos/cli/cli.py`
- Allowed: orchestration, command routing, lifecycle wiring, delegation.
- Forbidden: direct trust mutation logic, direct backend request construction, low-level terminal execution internals.
- Mutation owner: none (delegates).

## `arcanos/cli/context.py`
- Allowed: shared data models and context helpers (`ConversationResult`, persona/instance helpers).
- Forbidden: network I/O, backend calls, governance decisions.
- Mutation owner: local context fields only.

## `arcanos/cli/bootstrap.py`
- Allowed: startup guard, first-run setup, update checks, debug server startup.
- Forbidden: backend chat routing, trust-state mutation.
- Mutation owner: startup/update/session bootstrap fields.

## `arcanos/cli/state.py`
- Allowed: trust-state mutation, registry cache state, session hydration from backend payload, prompt assembly.
- Forbidden: direct backend I/O.
- Mutation owner: trust + registry + derived prompt state.

## `arcanos/cli/backend_ops.py`
- Allowed: all backend HTTP operations and metadata propagation.
- Forbidden: UI rendering decisions unrelated to backend responses.
- Mutation owner: backend request/response side effects only.

## `arcanos/cli/local_ops.py`
- Allowed: local GPT, local vision, local voice, and multimodal handler logic.
- Forbidden: direct backend HTTP calls (must delegate to `backend_ops.py`).
- Mutation owner: local modality/request flow state.

## `arcanos/cli/confirmation.py`
- Allowed: confirmation prompt flow and approval/rejection handling.
- Forbidden: direct trust mutation.
- Mutation owner: confirmation flow control only.

## `arcanos/cli/memory_ops.py`
- Allowed: conversation persistence and summarization writes.
- Forbidden: backend HTTP calls and trust mutation.
- Mutation owner: memory/session summary state.

## `arcanos/cli/daemon_ops.py`
- Allowed: daemon thread lifecycle, polling loops, command dispatch.
- Forbidden: direct raw backend request construction (must use `backend_ops.py`).
- Mutation owner: daemon thread lifecycle state.

## `arcanos/cli/ui_ops.py`
- Allowed: rendering, markdown/table output, speech replay helpers.
- Forbidden: backend HTTP calls and trust mutation.
- Mutation owner: presentation-only behavior.

## `arcanos/cli/run_ops.py`
- Allowed: terminal command execution orchestration under governance/idempotency.
- Forbidden: direct trust mutation and backend HTTP calls.
- Mutation owner: run-command execution path only.

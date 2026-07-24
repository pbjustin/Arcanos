# ARCANOS Productivity Capability

## Purpose

`ARCANOS:PRODUCTIVITY` is a protected, API-first productivity capability for conversational clients such as ChatGPT. The conversation interprets and presents; the TypeScript backend validates, authorizes, persists, and explains deterministic results.

The module extends the existing architecture:

```text
ChatGPT
  -> GPT Access Gateway
  -> capability policy and confirmation
  -> ARCANOS:PRODUCTIVITY
  -> productivity service
  -> scoped PostgreSQL repository
```

It does not add a second router, workflow engine, queue, frontend, or Python public protocol. Python remains behind the existing protocol boundary and is not required for canonical productivity operations.

## End-user behavior

The module supports common conversational requests while keeping persistence explicit:

| User intent | Capability | Result |
| --- | --- | --- |
| "Remember this." | `capture.add` | Captures an inbox item. |
| "What should I do?" | `focus.today` | Returns deterministic focus recommendations and reason codes. |
| "I finished that." | `task.complete` | Resolves the reference, validates the transition, and records completion. |
| "Plan my day." | `state.current` / `focus.today` | Returns shared current-state evidence without mutating commitments. |
| "What's going on?" | `context.summary` | Summarizes tasks, projects, reviews, and focus from one projection. |

Mutation responses distinguish saved changes from reads or replays with `persisted`, `changed`, `replayed`, and a concise `effect`.

## Capability catalog

Read-only capabilities execute without confirmation only when their module metadata explicitly classifies them as `readonly`:

- `intent.catalog`
- `intent.resolve`
- `state.current`
- `context.summary`
- `reference.resolve`
- `inbox.list`
- `task.list`
- `project.list`
- `project.health`
- `focus.today`
- `knowledge.find`
- `review.daily`
- `review.weekly`

Mutating capabilities remain confirmation-gated:

- `capture.add`
- `inbox.process`
- `task.create`
- `task.complete`
- `task.defer`
- `task.transition`
- `project.create`
- `project.advance`
- `project.transition`
- `knowledge.store`
- `review.record`

Each action publishes a strict input contract through the existing capability registry. Missing or inconsistent risk metadata fails closed as privileged.

## Canonical lifecycle

Tasks use these states:

```text
inbox -> next | scheduled | waiting | cancelled
next -> scheduled | waiting | done | cancelled
scheduled -> next | waiting | done | cancelled
waiting -> next | scheduled | done | cancelled
done -> terminal
cancelled -> terminal
```

Projects use these states:

```text
active -> blocked | on_hold | completed | archived
blocked -> active | on_hold | completed | archived
on_hold -> active | blocked | completed | archived
completed -> archived
archived -> terminal
```

Invalid transitions return `INVALID_TRANSITION`. Optimistic version mismatches return `STALE_PLAN` so the caller can refresh and replan rather than overwrite newer state.

## Identity and route isolation

Productivity tenancy comes only from server-controlled GPT Access configuration:

```text
ARCANOS_GPT_ACCESS_PRINCIPAL_ID
ARCANOS_GPT_ACCESS_WORKSPACE_ID
```

Caller payloads cannot select a principal, owner, or workspace. The module rejects tenancy aliases recursively.

The module is marked `gptAccessOnly: true` and `exposeLegacyRoute: false`. It is callable through:

```text
GET  /gpt-access/capabilities/v1
GET  /gpt-access/capabilities/v1/ARCANOS:PRODUCTIVITY
POST /gpt-access/capabilities/v1/ARCANOS:PRODUCTIVITY/run
```

It is not exposed through `/modules/:route`, `/queryroute`, public GPT route bindings, or public introspection output.

## Persistence

The additive migration is `migrations/20260724_productivity_core.sql`. It creates:

- `productivity_projects`
- `productivity_tasks`
- `productivity_notes`
- `productivity_reviews`
- `productivity_events`
- `productivity_command_receipts`

Every query is scoped by principal and workspace. Project references use tenant-safe composite foreign keys.

`state.current`, `context.summary`, `focus.today`, project health, and review evidence use one uncapped `REPEATABLE READ READ ONLY` snapshot. Tasks, projects, knowledge totals, and review status therefore describe the same committed point in time rather than a mixture of separate reads.

Each mutation runs in one PostgreSQL transaction:

1. Acquire a tenant/action/idempotency advisory lock.
2. Replay or reject an existing command receipt.
3. Validate current scoped state and optimistic version.
4. Apply the domain mutation.
5. Append outbox-style domain events.
6. Store the deterministic result receipt.
7. Commit.

Only hashes of idempotency keys are stored. Reusing a key with different semantic input returns `IDEMPOTENCY_CONFLICT`. Receipts expire after 30 days; mutations opportunistically remove expired receipts for the same tenant, and an expired key may execute again.

Reference-based retries check the durable command receipt before resolving a title again. A previously successful command therefore remains replayable if later data makes the original title ambiguous.

Outbox events receive a database-assigned `event_sequence` as a stable tie-breaker among committed unpublished rows. Because PostgreSQL sequences are allocated before commit, publishers must continue to select by `published_at IS NULL`; they must not treat sequence values as transaction commit order or skip lower values that become visible later.

## Structured errors

Expected domain failures return stable JSON codes and recovery guidance:

- `NOT_FOUND`
- `AMBIGUOUS_REFERENCE`
- `VALIDATION_FAILED`
- `CONFLICT`
- `IDEMPOTENCY_CONFLICT`
- `STALE_PLAN`
- `INVALID_TRANSITION`
- `PERMISSION_DENIED`
- `DEPENDENCY_UNAVAILABLE`
- `INTERNAL_ERROR`

Ambiguous title references return bounded candidates and do not mutate state.

## Activation

Configure the API service with server-controlled values:

```env
ARCANOS_GPT_ACCESS_PRINCIPAL_ID=operator:primary
ARCANOS_GPT_ACCESS_WORKSPACE_ID=personal
ARCANOS_GPT_ACCESS_SCOPES=capabilities.read,capabilities.run
MCP_ALLOW_MODULE_ACTIONS=ARCANOS:PRODUCTIVITY:*
```

Keep the existing GPT Access bearer token out of source control. Apply the migration through the repository's normal migration process before running write capabilities.

All writes still pass through the existing scope, allowlist, confirmation, audit, and tracing controls.

## Deliberately deferred

The initial module does not claim to implement calendar or email providers, notifications, recurring habits, team delegation, cross-service compensation, AI-owned authorization, or automatic public outbox publishing. Those can be added later through existing adapters, Action Plans, workers, and confirmation boundaries without changing the public productivity contract.

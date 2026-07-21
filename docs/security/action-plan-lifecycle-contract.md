# ARCANOS ActionPlan Lifecycle and CLEAR State Contract

- Status: Phase 2D authoritative contract
- Scope: ActionPlan lifecycle parsing, provenance, cross-field consistency, operation gates, and TypeScript/Python parity
- Baseline branch: `codex/clear-parsing-integrity`
- Baseline commit: `d9830a5f545902d70fe33d3f05f1b1db39a4064a`
- Contract date: 2026-07-17
- Related contract: `docs/security/clear-decision-contract.md`

## Purpose

An ActionPlan is a lifecycle state machine. A coherent CLEAR decision is necessary for policy-sensitive operations, but it is not sufficient to authorize every lifecycle state. This contract separates:

1. field parsing;
2. field provenance and authority;
3. cross-field consistency;
4. transition validity;
5. evidence freshness, where the repository can represent it; and
6. operation-level side-effect permission.

The contract corrects the confirmed Python behavior in which a plan with `status: "blocked"` and a coherent `allow` decision could execute a local command, submit an execution result, and print completion output. The immutable pre-change evidence is recorded in `docs/audits/action-plan-lifecycle/2026-07-17/pre-change-behavior.json`.

This phase does not change CLEAR thresholds or interpretation, queue acknowledgement, execution locking, persistence transactions, cache durability, workers, routes, OpenAI conversion, credentials, or Railway configuration.

## Repository evidence

- `src/shared/types/actionPlan.ts` declares exactly eight lifecycle values: `planned`, `awaiting_confirmation`, `approved`, `in_progress`, `completed`, `failed`, `expired`, and `blocked`.
- `src/stores/actionPlanStore.ts` creates plans as `awaiting_confirmation`, `approved`, or `blocked`. Its approval operation accepts only `planned` and `awaiting_confirmation`.
- `src/routes/plans.ts` and `src/mcp/server/index.ts` require exact `approved` status before the current CLEAR recheck and result writes.
- `daemon-python/arcanos/action_plan_types.py` historically defaulted missing status to `planned` and coerced other values with `str(...)`.
- `daemon-python/arcanos/action_plan_handler.py` historically interpreted CLEAR and expiry but did not gate operations on lifecycle status.
- `prisma/schema.prisma` stores status as an unconstrained string. It has no plan version, revision, confirmation record, confirmation version, block provenance, or policy-evidence version.
- `ExecutionResult` is unique by `(planId, actionId)`, but writing execution results does not transition the plan out of `approved`.

No other lifecycle strings are authorized by this contract. In particular, `cancelled`, `confirmed`, `ready`, `draft`, and `unknown` are not ActionPlan states in the current repository.

## Authoritative data flows

### TypeScript HTTP

```text
HTTP operation
  -> parse route input
  -> load persisted/cache ActionPlan snapshot
  -> lifecycle preflight
  -> operation-specific capability/confirmation gate
  -> current CLEAR recheck, when execution requires it
  -> Phase 2B CLEAR interpreter
  -> lifecycle and policy consistency decision
  -> execution lock, status write, or result write
  -> protocol-specific response
```

### TypeScript MCP

```text
MCP tool call
  -> destructive-tool exposure gate
  -> request-bound confirmation nonce gate
  -> load persisted/cache ActionPlan snapshot
  -> lifecycle preflight
  -> capability gate
  -> current CLEAR recheck
  -> Phase 2B CLEAR interpreter
  -> lifecycle and policy consistency decision
  -> execution lock, status write, or result write
  -> MCP result or stable MCP error envelope
```

The MCP nonce confirms the tool invocation and its supplied arguments. It does not prove that plan actions, lifecycle status, or policy evidence are unchanged.

### Python daemon

```text
generic daemon command payload
  -> ActionPlan field parser
  -> Phase 2C CLEAR interpreter
  -> lifecycle and policy consistency decision
  -> one of:
       coherent block notification
       plan confirmation gate
       action-level confirmation and local command
       no side effect
  -> optional backend result submission
  -> safe console output
  -> existing daemon acknowledgement lifecycle
```

Python must run lifecycle validation before CLEAR display, confirmation prompts, block callbacks, local commands, backend result submissions, or success output. Daemon acknowledgement remains outside this contract.

## Lifecycle states

| State | Category | Producer evidence | Entry operations | Exit transitions | Terminal |
|---|---|---|---|---|---|
| `planned` | preparation | Database default or compatibility record; current trusted creation resolves to another state | approve, block, expire, read | `approved`, `blocked`, `expired` | No |
| `awaiting_confirmation` | awaiting confirmation | Plan creation when CLEAR says `confirm` or confirmation is required | approve, block, expire, read | `approved`, `blocked`, `expired` | No |
| `approved` | executable | Plan creation with `allow` and no required confirmation, or explicit approval | execute, block, expire, read | `blocked`, `expired`; execution currently leaves status `approved` | No |
| `in_progress` | executing | Declared and cache-warmed; no current public writer was found | block, read | `blocked` | No |
| `completed` | terminal success | Declared; no current public writer was found | read | None | Yes |
| `failed` | terminal failure | Declared; no current public writer was found | read | None; no ActionPlan retry operation exists | Yes |
| `expired` | terminal expiry | Manual expiry or stale-plan sweep | read, repeated expire | Idempotent `expired` no-op | Yes |
| `blocked` | policy/operator gated | Creation-time block, operator block, or current recheck block | read, repeated block | Idempotent `blocked` no-op | Execution-terminal |

`blocked` is distinct from operational failure. It may represent an explicit operator or evaluator action, but the current schema does not retain that provenance.

## Field authority and provenance

| Field or evidence | Source | Classification | Contract |
|---|---|---|---|
| Lifecycle `status` in TypeScript | Persisted ActionPlan or store cache | Conditionally authoritative | Exact recognized value controls lifecycle. Unconstrained database strings and cache fallback require runtime validation. |
| Lifecycle `status` in Python | Generic daemon command payload | Untrusted until parsed; then conditionally authoritative snapshot | Must be present and exactly one recognized string. No default, coercion, trimming, or case normalization. |
| Stored `plan.clearScore` | Creation-time one-to-one score record | Historical | It may explain initial state or expose corruption. It cannot authorize a new execution result. |
| Current TypeScript recheck | CLEAR result produced for the current execution attempt | Authoritative for current policy only | It may allow execution or cause `approved -> blocked`; it cannot revive a blocked or terminal lifecycle state. |
| Python command CLEAR evidence | Parsed and coherent daemon payload | Conditionally authoritative, unversioned | It may authorize an operation only when lifecycle is compatible. It cannot override blocked or terminal status. |
| `requiresConfirmation` | Persisted creation configuration | Authoritative configuration, not confirmation evidence | Python accepts only an exact JSON boolean; a missing field retains the compatibility default `true`, while null, coerced, or conflicting aliases are invalid. It determines initial state but does not prove who confirmed, what was confirmed, or when. |
| `approved` status | Persisted lifecycle state | Current compatibility confirmation surrogate | It is the only durable evidence that lifecycle approval occurred, but is not bound to actor, action content, CLEAR version, or plan revision. |
| MCP confirmation nonce | In-memory tool/session/payload digest | Authoritative only for that MCP invocation | It is not lifecycle approval and is not bound to stored plan content or version. |
| Python confirmation response | Immediate local prompt | Ephemeral and conditionally authoritative | It applies only to the current in-memory invocation and does not transition backend lifecycle state. |
| Plan ID | Database UUID primary key or daemon payload | Authoritative in TypeScript; conditionally authoritative after Python parsing | Python accepts an exact string matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; the TypeScript UUID vocabulary is a subset. Missing, null, non-string, whitespace, path-bearing, overlong, or conflicting `plan_id`/`id` aliases cannot reach a callback, command, result write, or success output. No coercion or normalization occurs. |
| Actions | Loaded record or daemon payload | Current snapshot | TypeScript rechecks the loaded actions. Neither language can prove the actions match a prior confirmation version. |
| `updatedAt` | Database/cache timestamp | Historical | It is not a revision and must not be used as one without an expected-value comparison contract. |
| Execution results | Append-only per-action records | Historical execution evidence | They do not by themselves transition or reliably derive plan status. |

### Precedence rules

Precedence is operation-specific rather than universal:

- Lifecycle status is checked before execution policy can authorize work.
- A current policy result cannot revive `blocked`, terminal, missing, or invalid lifecycle state.
- A valid lifecycle state cannot override a current explicit policy block.
- Stored creation policy is history, not a current execution authorization.
- Explicit operator block remains independent of CLEAR and may block an otherwise allowed active plan.
- Missing or malformed evidence is uncertainty or invalidity, never an implicit policy block.

## Operations

The current ActionPlan surface supports these semantic operations:

| Operation | Repository surface | Contract |
|---|---|---|
| create | HTTP/MCP plan creation and `createPlan` | Derive initial state from authoritative creation-time CLEAR and confirmation configuration. |
| approve | HTTP/MCP approve and `approvePlan` | May move only `planned` or `awaiting_confirmation` to `approved`; creation-time block evidence forbids approval. |
| execute | HTTP/MCP execute; Python allow/confirm command path | Requires compatible lifecycle and authoritative current policy evidence. |
| block | HTTP/MCP operator block; current CLEAR block; Python block command path | May move an active nonterminal state to `blocked`. Repeated block is a no-op. |
| expire | HTTP/MCP expire and stale-plan sweep | May expire preparation/confirmation/approved states. Repeated expiry is a no-op. |
| read | get, list, results | Non-mutating and available for recognized states. Invalid stored state may be reported safely for diagnosis. |
| evaluate/recheck | Internal execution step or standalone CLEAR surface | Does not itself authorize execution; its result must be combined with lifecycle. |

There is no current ActionPlan cancel, retry, acknowledge, start, complete, fail, unblock, or override transition. Daemon queue acknowledgement and execution-result retry behavior are separate systems and are not authorized as lifecycle transitions by this document.

## Transition contract

| Current state | Approve | Execute with current/wire `allow` or `confirm` | Current/wire `block` | Explicit block | Expire |
|---|---|---|---|---|---|
| `planned` | Allow -> `approved` | `ACTION_PLAN_TRANSITION_FORBIDDEN` | Allow as block operation -> `blocked` | Allow -> `blocked` | Allow -> `expired` |
| `awaiting_confirmation` | Allow -> `approved` | `ACTION_PLAN_CONFIRMATION_REQUIRED` | Allow as block operation -> `blocked` | Allow -> `blocked` | Allow -> `expired` |
| `approved` | Forbidden | Allow execution; current persistence leaves status `approved` | `ACTION_PLAN_POLICY_BLOCKED`; write `blocked`, no results | Allow -> `blocked` | Allow -> `expired` |
| `in_progress` | Forbidden | `ACTION_PLAN_TRANSITION_FORBIDDEN` | Allow block recording with race caveat | Allow -> `blocked` | Forbidden |
| `completed` | Terminal | `ACTION_PLAN_TERMINAL` | Terminal; no block write | Terminal | Terminal |
| `failed` | Terminal | `ACTION_PLAN_TERMINAL` | Terminal; no block write | Terminal | Terminal |
| `expired` | Terminal | `ACTION_PLAN_TERMINAL` | Terminal; no block write | Terminal | Idempotent no-op |
| `blocked` | Forbidden | Never execute | Coherent only when the requested semantic operation is block | Idempotent no-op | Forbidden |

### Required cross-field decisions

| Combination | Policy provenance | Result | Effects |
|---|---|---|---|
| `blocked` + `allow` or `confirm` | `stored_creation` | Existing lifecycle block remains authoritative; creation evidence is historical, not malformed | No recheck, callback, command, result write, or success output |
| `blocked` + `allow` or `confirm` | `current_recheck` or `daemon_wire` | `ACTION_PLAN_STATE_INVALID` | No side effects |
| `blocked` + `block` | Current, wire, or stored | Coherent idempotent block | No block callback or write; safe denial/read output only |
| `approved` + `block` | `stored_creation` | `ACTION_PLAN_STATE_INVALID`; trusted creation could not produce this combination | No recheck, block write, result write, or execution |
| `approved` + `block` | `current_recheck` or authoritative daemon wire | Valid policy block transition | Exactly one block write/callback; no execution effects |
| `approved` + `allow` or `confirm` | `stored_creation` only | Current policy evidence still required on TypeScript execute | Recheck required; no result write before recheck |
| `approved` + `allow` or `confirm` | `current_recheck` or authoritative daemon wire | Valid execution permission | Adapter-specific execution effects allowed |
| Missing status + any CLEAR result | Any | `ACTION_PLAN_STATE_UNAVAILABLE` | No side effects |
| Unknown, non-string, or case-variant status + any CLEAR result | Any | `ACTION_PLAN_STATE_INVALID` | No side effects |

Python maps an authoritative daemon `block` result to the semantic block operation. It maps authoritative `allow` or `confirm` to execute. This mapping must occur only after exact field and CLEAR parsing.

## Pure lifecycle evaluator

The TypeScript and Python evaluators must accept normalized semantic facts explicitly:

- exact lifecycle status;
- requested semantic operation;
- interpreted CLEAR outcome when the operation uses policy;
- CLEAR provenance: `stored_creation`, `current_recheck`, or `daemon_wire`;
- deterministic expiry fact when available; and
- non-empty plan identity before a mutation boundary.

The evaluator returns a structured result with:

- outcome kind: `allowed`, `recheck_required`, `policy_blocked`, `confirmation_required`, `forbidden`, `terminal`, `invalid`, or `unavailable`;
- stable reason code;
- target status or `null`;
- whether a status write is permitted; and
- whether execution effects are permitted.

It must not perform I/O, log, read environment variables, inspect HTTP or MCP objects, invoke callbacks, generate identifiers, mutate global state, or infer a transition from truthiness.

Adapters must evaluate before every protected boundary. An invalid, unavailable, terminal, stale, contradictory, or forbidden result permits no confirmation callback, block callback, execution callback, local command, execution-result write, or success output. The only exception is an explicitly allowed block transition, which permits exactly its block effect.

## Terminal-state contract

- `completed`, `failed`, and `expired` are hard terminal states for mutation in this phase.
- `blocked` is terminal for execution and has no current unblock transition.
- Reading a terminal plan remains allowed.
- Repeating block on `blocked` or expiry on `expired` is semantically idempotent and performs no write.
- A current allow, confirm, or block result does not reopen or rewrite a hard terminal plan.
- `failed` is not retryable through an ActionPlan lifecycle operation because no retry operation exists.
- An `approved` plan with execution results is not automatically called terminal. Result writes may be partial and the current schema does not encode completion reliably.

## Confirmation contract

- Lifecycle confirmation is represented only by the transition to `approved`.
- `awaiting_confirmation` cannot execute, even when current policy says `allow` or `confirm`.
- A Python local prompt cannot substitute for the persisted approval transition.
- An `approved` plan with current `confirm` remains executable under the established Phase 2B behavior; Phase 2D does not add a second TypeScript lifecycle confirmation.
- Python may retain its additional immediate plan/action prompts after lifecycle validation.
- Python treats `requires_confirmation` and `requiresConfirmation` as protocol aliases: both must be exact booleans and must agree when both are present. Malformed falsey values cannot bypass the prompt.
- The `terminal.run` proposal hash remains an action-level confirmation and is separate from lifecycle approval.
- MCP nonce confirmation remains an operation-level transport gate, not proof of lifecycle approval.
- Confirmation cannot override current block, revive terminal state, or authorize a different known plan identity.

The repository has no confirmation record or version. This phase therefore cannot prove actor identity, bind historical approval to action contents, enforce approval expiry, or detect replay across plan revisions.

## Block contract

The following events are distinct even though current persistence stores only `status: "blocked"`:

- creation-time evaluator block;
- current execution recheck block;
- explicit operator block;
- an existing persisted blocked state;
- invalid or contradictory state that merely refuses an operation; and
- dependency or persistence failure.

Only the first three may create a new blocked status. Invalid, missing, indeterminate, terminal, or failed state does not fabricate a block.

An explicit block may be recorded from `planned`, `awaiting_confirmation`, `approved`, or `in_progress`. A block observed after work is already `in_progress` cannot cancel or undo effects; it only gates future attempts. Repeating block on `blocked` must not call the backend block endpoint again.

## Expiry contract

- `planned`, `awaiting_confirmation`, and `approved` may transition to `expired`.
- An elapsed authoritative expiry prevents execution even if a sweep has not yet persisted the transition.
- Expiry is elapsed when its instant is less than or equal to the controlled current instant in both languages.
- Malformed Python expiry metadata must not be silently treated as unexpired when it is used for an execution decision.
- `in_progress`, `blocked`, `completed`, and `failed` must not be rewritten to `expired` by an operation adapter.
- Repeated expiry on `expired` is a no-op.

## Staleness and version contract

Conceptually, confirmation or policy evidence is stale when it refers to a different plan version, plan ID, action set, or older authoritative evaluation. The current repository cannot represent or enforce most of those facts:

- ActionPlan has no version or revision field.
- Actions have no version or content digest in the lifecycle schema.
- Confirmation has no persisted record or version.
- Stored `updatedAt` is not supplied as an expected version and is not checked atomically.
- The Python daemon payload has no formal versioned ActionPlan schema.
- Persisted blocked status does not record whether an operator or evaluator produced it.

Therefore:

- known plan-ID disagreement is invalid;
- an MCP nonce for different supplied arguments remains invalid under the existing nonce contract;
- claimed version mismatches in shared fixtures are conceptual `ACTION_PLAN_VERSION_CONFLICT` cases but are marked `unavailable_no_authoritative_version` for current adapters;
- missing version evidence does not justify inventing equality or claiming freshness; and
- Phase 2D must not add schema fields, confirmation tokens, action hashes, migrations, or compare-and-swap behavior to imply unsupported guarantees.

## Concurrency contract and limitations

Current TypeScript execution reads and validates a plan, performs capability checks and CLEAR re-evaluation, and only then acquires the execution lock. The lock prevents a concurrent duplicate execution that reaches the same lock boundary, and `(planId, actionId)` uniqueness limits repeated durable result rows. Neither protection is a lifecycle transaction.

Known limitations:

- block may race with execute after the approved snapshot was read;
- status may change after validation and before a side effect;
- the store is cache-first and cannot provide a reliable final freshness read;
- result writes are independent and may partially succeed;
- execution leaves plan status `approved`, so a later duplicate request is detected by lock or result uniqueness rather than terminal lifecycle;
- Python has no shared lock, authoritative refresh, version, or result set at the local-command boundary; and
- a block recorded during `in_progress` cannot cancel work already started.

A final pre-side-effect revalidation is not authorized in Phase 2D because no version/CAS field makes it reliable. Deterministic tests must characterize these races without claiming they are closed. Transactional execution and locking belong to a later bounded concurrency phase.

## Error contract

Stable semantic categories are:

| Category | Meaning | Retryability |
|---|---|---|
| `ACTION_PLAN_STATE_INVALID` | Unknown state or contradictory authoritative fields | Non-retryable until corrected |
| `ACTION_PLAN_STATE_UNAVAILABLE` | Required lifecycle state or identity is missing | Retryable only with corrected authoritative data |
| `ACTION_PLAN_TRANSITION_FORBIDDEN` | Recognized state does not permit the requested operation | Normally non-retryable without a state transition |
| `ACTION_PLAN_TERMINAL` | Requested mutation targets a hard terminal state | Non-retryable |
| `ACTION_PLAN_CONFIRMATION_REQUIRED` | Durable approval must occur first | Retryable after valid approval |
| `ACTION_PLAN_CONFIRMATION_STALE` | Authoritative confirmation evidence is known to target different state | Retryable after new confirmation; not currently representable generally |
| `ACTION_PLAN_VERSION_CONFLICT` | Authoritative version evidence is known to disagree | Retryable after refresh; not currently representable generally |
| `ACTION_PLAN_POLICY_BLOCKED` | Explicit coherent current policy block or existing blocked lifecycle denies execution | Non-retryable without a separately authorized state/policy change |

HTTP and MCP retain protocol-specific envelopes. Existing HTTP 403/409 and MCP `ERR_GATED` behavior should remain where possible. The valid `approved + current block` path retains the existing HTTP “CLEAR re-evaluation blocked this plan” and MCP gated responses. New internal reason codes must not require exposing raw records.

Python console and diagnostic messages must be fixed and non-sensitive. Missing or unknown values must not be interpolated into public messages.

## Audit and diagnostic contract

An accepted or rejected transition may record only allowlisted structured facts:

- plan identifier;
- previous recognized state;
- requested operation;
- intended target state;
- stable outcome and reason code;
- policy provenance and semantic category;
- request or trace identifier;
- actor category when safely available; and
- retryability.

`planVersion` may be recorded only when a future authoritative version exists. Current diagnostics must report version support as unavailable rather than fabricate a value.

Diagnostics must not contain complete plans, action parameters, commands, raw daemon payloads, credentials, headers, request bodies, SQL, filesystem paths, provider bodies, raw dependency messages, stacks, or confirmation secrets.

## Shared fixture contract

The deterministic cross-language corpus uses semantic facts rather than language-specific objects. Each enforceable case contains:

- lifecycle status and whether the field is present;
- requested semantic operation;
- interpreted CLEAR category and provenance;
- expiry fact when relevant;
- expected semantic category and target state;
- operation permission; and
- expected block, confirmation, execution, local-command, result-write, and success-output effects.

Fixtures for version mismatch, stale confirmation, action changes, state changes after validation, duplicate execution, block/execute races, and partial retry must include a runtime-support marker. Unsupported evidence cases remain executable documentation and must not be presented as production enforcement.

## Smallest Phase 2D implementation boundary

The evidence supports only these production corrections:

1. Parse Python lifecycle state exactly, with no missing-state default or string coercion.
2. Add equivalent dependency-light pure lifecycle evaluators in TypeScript and Python.
3. Apply the Python evaluator before all confirmation, block, local-command, result, and success-output boundaries.
4. Apply the TypeScript evaluator at approve, execute, block, and expire operation adapters while preserving protocol-specific response envelopes.
5. Treat stored creation CLEAR as historical and current recheck CLEAR as execution policy authority.
6. Treat a coherent repeated block or expiry as a no-op rather than a redundant write.
7. Preserve current valid allow, confirm, block, operator confirmation, action ordering, duplicate-action handling, and result schemas.
8. Characterize, but do not redesign, duplicate execution, partial result writes, cache durability, or block/execute races.

Phase 2D does not authorize schema migrations, lifecycle frameworks, a global state-machine service, new public states, plan-version fields, confirmation redesign, transaction redesign, lock movement, queue changes, or worker changes.

## Compatibility summary

| Input | Pre-change Python behavior | Contract behavior |
|---|---|---|
| `blocked + allow` | Local command, execute callback, and completion output were possible | Invalid command state; zero side effects |
| `blocked + confirm` | Confirmation could lead to execution | Invalid command state; zero side effects |
| `blocked + block` | Repeated block callback | Coherent idempotent denial; no callback/write |
| `planned + allow/confirm` | Executed because status was ignored | Approval required; zero side effects |
| `awaiting_confirmation + allow/confirm` | Local prompt could bypass persisted approval | Durable approval required; no prompt or execution |
| `in_progress + allow/confirm` | Duplicate local execution possible | Transition forbidden; zero side effects |
| Terminal + any decision | Execution or block callback depended only on CLEAR | Terminal; zero mutation/execution effects |
| Missing status + valid CLEAR | Defaulted to `planned`, then executed | State unavailable; zero side effects |
| Unknown status + valid CLEAR | Coerced and ignored, then executed | State invalid; zero side effects |
| `approved + current allow/confirm` | Executed | Preserved |
| `approved + current block` | Block callback | Preserved as one valid block transition |

## Rollback boundary

The lifecycle documentation, fixture/tests, TypeScript evaluator/adapters, and Python evaluator/adapters should remain separate reviewable commits. Reverting the language-specific enforcement commit restores that language’s prior behavior without requiring a database rollback. A rollback must not delete or rewrite existing ActionPlan or ExecutionResult history, change CLEAR thresholds, or weaken the Phase 2B/2C interpretation contract.

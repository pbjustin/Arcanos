# ARCANOS CLEAR Decision and Disclosure Contract

- Status: Phase 2B authoritative contract
- Scope: ActionPlan CLEAR 2.0 execution rechecks, decision persistence, and MCP error disclosure
- Baseline branch: `codex/clear-decision-integrity`
- Baseline commit: `06d1620b3e776eccab98d99b7802193cc7723ca6`
- Phase 1 audit source: `docs/audits/reusable-code/2026-07-16/`
- Contract date: 2026-07-17

## Purpose

This contract separates four responsibilities:

1. The CLEAR 2.0 evaluator produces a complete result.
2. A pure interpreter validates that result and identifies its authoritative outcome.
3. HTTP and MCP execution adapters apply the persistence policy for that outcome.
4. Protocol adapters present stable public errors while internal diagnostics retain only allowlisted metadata.

This phase does not change CLEAR thresholds, plan construction, action ordering, duplicate actions, rollback detection, confirmation gates, route registration, queue behavior, workers, or the persistence schema.

The Phase 1 characterization is immutable evidence of two pre-change defects: a valid current `allow` recheck was discarded when the stored `ActionPlan.clearScore` relation was `null`, and MCP returned a raw dependency exception. The exact historical test is preserved at commit `06d1620b3e776eccab98d99b7802193cc7723ca6`, Git blob `e089b5b2db2c02d549f362c7850b5997faf5ee33`. Phase 2B intentionally changes those two behaviors. Because the two original active assertions are logically incompatible with the corrected production contract, the current assertions verify the new behavior; the cited commit/blob remains the unmodified historical evidence.

## Authoritative data flow

```text
HTTP POST /plans/:planId/execute
  -> routes/plans.ts recheck payload builder
  -> buildClear2Summary
  -> interpretClear2Outcome
  -> blockPlan OR createExecutionResult[] OR no write
  -> HTTP response/error adapter

MCP plans.execute
  -> mcp/server/helpers.ts recheck payload builder
  -> buildClear2Summary
  -> interpretClear2Outcome
  -> blockPlan OR createExecutionResult[] OR no write
  -> MCP result/error adapter

HTTP POST /clear/evaluate
  -> validated HTTP payload
  -> buildClear2Summary
  -> interpretClear2Outcome
  -> unchanged valid summary OR stable HTTP evaluation error

MCP clear.evaluate
  -> MCP tool arguments
  -> buildClear2Summary
  -> interpretClear2Outcome
  -> unchanged valid summary OR stable MCP evaluation error

Plan creation (trusted local producer boundary)
  -> routes/plans.ts or MCP plans.create
  -> stores/actionPlanStore.ts createPlan
  -> local synchronous buildClear2Summary
  -> nested ActionPlan/Action/ClearScore persistence

Web-search CLEAR summary (trusted local producer, no decision persistence)
  -> services/webSearchAgent.ts
  -> local synchronous buildClear2Summary
  -> returned workflow metadata
```

The two recheck payload builders remain independent in this phase. They continue to preserve action order, duplicate actions, `params`, `timeout_ms`, and the current non-null rollback test.

`createPlan` remains a trusted local producer boundary. It calls the typed, synchronous repository builder directly and requires the full five-principle `ClearScore` shape for its nested write. The Phase 2B interpreter validates only operational `decision`/`overall`; inserting it there would not validate the complete persisted shape or improve nested-write atomicity. The trust invariant is covered by `tests/clear2.test.ts` and `tests/action-plan-store.test.ts`. Revalidation is required before this producer becomes external, dynamic, or replaceable. `webSearchAgent` likewise uses the same local builder but does not write `ExecutionResult.clearDecision`; changing that workflow is outside this phase.

## Authoritative inputs

The ActionPlan CLEAR 2.0 producer contract is `ClearScore` in `src/shared/types/actionPlan.ts` and `buildClear2Summary` in `src/services/clear2.ts`.

A returned evaluation is authoritative only when:

- it is a non-array object;
- `decision` is exactly `allow`, `confirm`, or `block`;
- when `overall` is present and non-null, it is a finite JavaScript number in the inclusive range `[0, 1]`; and
- when a finite `overall` is present, the decision agrees with the repository thresholds: `block` below `0.40`, `confirm` from `0.40` through values below `0.70`, and `allow` at or above `0.70`.

The current recheck result is the authority for an execution attempt. The older persisted `plan.clearScore` relation is lifecycle history and an initial guard; it MUST NOT supply the decision written to a new execution result.

The explicit decision is the operational control field used by all current consumers. An absent or null score is missing audit evidence, but does not erase an explicit decision. A score without an explicit decision is never sufficient to derive one. The five principle scores and notes remain audit metadata; Phase 2B does not recompute the composite from those fields at the adapter boundary. Unknown extra fields are ignored.

## Outcome model

`confirm` is a first-class existing policy result and is retained in addition to the five conceptual outcomes required by the Phase 2B brief.

| Outcome | Trigger | Persistence | HTTP/MCP behavior | Retry | Metrics |
|---|---|---|---|---|---|
| `ALLOW` | Explicit `allow`; score absent/null or present and coherent | Create execution results with current recheck decision `allow`; do not rewrite stored score | Continue the already-authorized execution path | Normal idempotency and lock behavior | No dedicated CLEAR metric was observed; unchanged |
| `CONFIRM` | Explicit `confirm`; score absent/null or present and coherent | Create execution results with current recheck decision `confirm`; do not rewrite stored score | Preserve current approved-plan behavior; do not add another confirmation gate | Normal idempotency and lock behavior | No dedicated CLEAR metric was observed; unchanged |
| `BLOCK` | Explicit `block`; score absent/null or present and coherent | Call `blockPlan`; create no execution results | Preserve HTTP 403 and MCP `ERR_GATED` envelopes | A persistence failure is not reported as a successful block | No dedicated CLEAR metric was observed; unchanged |
| `INDETERMINATE` | Evaluator returned `null` or `undefined`, so no result exists | No status, score, or result write; preserve prior state | Fail the operation with `CLEAR_EVALUATION_UNAVAILABLE` | Retryable when the caller's existing policy permits | No dedicated CLEAR metric was observed; unchanged |
| `INVALID` | Returned value has an unknown decision, malformed present score, or contradictory decision/score | No status, score, or result write; preserve prior state | Fail with `CLEAR_RESULT_INVALID` | Non-retryable without a corrected producer/result | No dedicated CLEAR metric was observed; unchanged |
| `FAILED` | Evaluator, persistence dependency, or operation throws/rejects/times out/aborts | No fabricated decision; writes already completed by existing non-transactional dependencies are not rewritten | Return a stage-appropriate stable error | Dependency/operation policy determines retryability | No dedicated CLEAR metric was observed; unchanged |

An explicit `block` is a policy decision. A missing, null, malformed, unavailable, or failed result is not a block.

## Null, missing, and malformed values

The interpreter MUST use explicit runtime checks and MUST NOT compare an unchecked value to a threshold.

| Returned value | Interpretation |
|---|---|
| `null` or `undefined` result | `INDETERMINATE` |
| Empty object | `INDETERMINATE: missing_decision` |
| Missing, `null`, or `undefined` decision | `INDETERMINATE: missing_decision`; a score alone is not a decision |
| Unknown, non-string, or case-variant decision | `INVALID: invalid_decision` |
| Explicit valid decision with missing, `null`, or `undefined` `overall` | The explicit `ALLOW`, `CONFIRM`, or `BLOCK` remains authoritative; output records `overall: null` |
| `NaN`, positive/negative infinity, string, boolean, object, or array score | `INVALID: invalid_score` |
| Score below zero or above one | `INVALID: invalid_score` |
| Valid score whose threshold result contradicts `decision` | `INVALID: contradictory_result` |
| Evaluator exception, timeout, or abort | `FAILED`; no partial result is authoritative |

The confirmed Phase 1 defect is distinct from an invalid returned score: the returned recheck is complete and says `allow`, while the older stored `plan.clearScore` relation is `null`. A valid recheck remains authoritative in that case.

## Persistence contract

### Writes

- `ALLOW` and `CONFIRM` write one `ExecutionResult` per action using the current recheck decision.
- `BLOCK` updates only `ActionPlan.status` through the existing `blockPlan` behavior.
- `INDETERMINATE`, `INVALID`, and evaluator `FAILED` outcomes perform no Phase 2B decision write.
- Rechecks do not update the stored `ClearScore` row in this phase.
- A previous valid score/decision, including a missing stored relation, is preserved when the current outcome cannot be interpreted.

`ExecutionResult.clearDecision` is required and has no indeterminate enum. Suppressing the write is therefore the only schema-compatible representation of uncertainty. No migration is authorized or required.

### Failure atomicity

Plan creation remains a nested database write. Execution-result creation remains one independent call per action under `Promise.all`; it is not transactionally atomic. A later failure can leave an earlier action result durable. Phase 2B guarantees only that interpretation occurs before these writes and that no invalid outcome initiates them.

The existing store may convert database failures into cache fallbacks. An accepted cache fallback remains the store's current success contract; adapters cannot claim durable database persistence from that result. A rejecting store call is `CLEAR_PERSISTENCE_FAILED` and MUST NOT be reported as success.

### Idempotency, retry, and concurrency

- The existing `(planId, actionId)` uniqueness rule, store cache behavior, and execution lock remain unchanged.
- A repeated successful request remains subject to existing replay/cache semantics.
- A retry after an evaluator or adapter-level persistence failure re-evaluates CLEAR and writes no fabricated decision.
- The lock remains after recheck and around allow/confirm result creation. Block handling remains outside that lock.
- Phase 2B adds no version predicate or transaction. Concurrent block/allow rechecks and cross-process cache divergence remain documented risks.

## Public error contract

The following stable categories are authoritative for this workflow:

| Category | Public message | Use |
|---|---|---|
| `CLEAR_EVALUATION_UNAVAILABLE` | `CLEAR evaluation is unavailable.` | No result or evaluator failure |
| `CLEAR_RESULT_INVALID` | `CLEAR evaluation returned an invalid result.` | Malformed or contradictory result |
| `CLEAR_PERSISTENCE_FAILED` | `CLEAR decision persistence failed.` | Block/result persistence rejection |
| `CLEAR_OPERATION_FAILED` | `CLEAR operation failed.` | Other unexpected operation failure |
| `MCP_OPERATION_FAILED` | `MCP operation failed.` | MCP tool or transport failure outside a more specific CLEAR category |

HTTP and MCP envelopes remain protocol-specific:

- HTTP retains its route status conventions and JSON envelope. The `error` field contains the stable category and `message` contains the fixed public message for new Phase 2B failures.
- MCP retains its `ERR_INTERNAL` transport code for internal failures, fixed public message, `requestId`, and a bounded `details.category` and `details.tool` where applicable.
- Existing policy denials retain HTTP 403 or MCP `ERR_GATED` rather than becoming internal failures.
- No adapter may place a raw thrown value, exception message, cause, stack, request body, header, plan payload, SQL, filesystem path, provider body, credential, or dependency response in public output.

The MCP HTTP transport catch at `POST /mcp` is part of this disclosure boundary and MUST also return only `MCP_OPERATION_FAILED` and its fixed message.

## Internal diagnostic contract

Logging is best-effort and MUST NOT prevent a stable error response. A diagnostic event for this workflow may contain only:

- stable error/category code;
- fixed operation or tool name;
- fixed dependency category;
- request ID and trace ID;
- allowlisted error class such as `Error`, `TypeError`, `TimeoutError`, or a bounded primitive thrown-value class;
- retryability; and
- outcome category or reason code.

It MUST NOT contain:

- raw exception message, cause, or stack;
- credentials, tokens, cookies, session IDs, or authorization content;
- request headers or bodies;
- SQL, database URLs, filesystem paths, provider response bodies, or full plan content;
- arbitrary object serialization; or
- encoded, truncated, hashed, prefixed, or suffixed forms of a sensitive value.

The MCP logger sink MUST apply the repository redactor to allowlisted metadata as defense in depth. CLEAR/MCP error paths still MUST avoid passing raw values to that sink.

## Compatibility matrix

| Surface/input | Previous behavior | Phase 2B behavior | Compatibility risk |
|---|---|---|---|
| Valid recheck `allow`, stored score `null` | Executed and wrote `block` | Executes and writes `allow` | High correctness fix; audit value changes |
| Valid recheck `allow`, stored score `block` after initial guard is bypassed by stale/mock data | Wrote stored `block` | Writes current `allow` | Medium; current evaluation becomes authoritative |
| Valid recheck `confirm` | Wrote the stored decision | Writes current `confirm` | Low; approved-plan execution remains allowed |
| Valid recheck `block` | Status block and policy denial | Same, unless persistence rejects | Low |
| Null/undefined result | Non-block path could continue and coerce stored/missing value | No writes; evaluation-unavailable failure | Low for valid producers; fail secure |
| Explicit decision with absent/null score | Could be coerced through unchecked comparisons or stale stored state | Honor the explicit decision; never infer from absence | Medium; decision remains authoritative |
| Invalid or contradictory result | Non-block path could continue | No writes; invalid-result failure | Low for valid producers; fail secure |
| Evaluator failure | Generic HTTP error; raw MCP error | Stable sanitized failure on both protocols | Medium diagnostic compatibility |
| Persistence rejection | Generic HTTP error; raw MCP error | `CLEAR_PERSISTENCE_FAILED`, no raw detail | Medium error-body compatibility |
| MCP tool/transport exception | Raw exception could be returned | Fixed `MCP_OPERATION_FAILED` | High security fix; clients lose raw text |
| Existing stored allow/block on an invalid recheck | Could supply execution result decision | Preserved but not copied into new results | Medium; operation now fails |

## Related systems and deferrals

The Python daemon parser in `daemon-python/arcanos/action_plan_types.py` defaults a non-empty partial score with no decision to `block`. That is a related violation, but changing it also changes a separate TypeScript-to-Python protocol consumer and an existing daemon test. It is inventoried for a bounded follow-up rather than combined with the confirmed HTTP/MCP persistence correction.

The ActionPlan 0-1 CLEAR model is distinct from the reinforcement 0-10 scorecard and Trinity audit thresholds. Their types, thresholds, and persistence MUST NOT be unified under this contract.

## Evidence-backed remaining risks

| Finding | Evidence and affected files | Observed behavior | Confidence | Risk | Basis | Required prerequisite tests | Suggested phase | Rollback | Deployment required |
|---|---|---|---|---|---|---|---|---|---|
| Result writes are not atomic | `src/routes/plans.ts`, `src/mcp/server/index.ts`, `src/stores/actionPlanStore.ts` | Independent action writes can partially succeed | High | High | Static | Store-level transaction and retry matrix | Later persistence phase | Restore independent writes | Yes |
| Store fallbacks obscure durability | `src/stores/actionPlanStore.ts` | Database failures can return cache success | High | High | Static and existing tests | Durable/cache outcome contract | Later persistence phase | Restore current fallback policy | Yes |
| Recheck precedes locking | Both execute adapters | Future conflicting outcomes can race status/result writes | Medium | High | Static | Deterministic concurrent block/allow test with version semantics | Later concurrency phase | Restore current lock boundary | Yes |
| Python partial score defaults to block | `daemon-python/arcanos/action_plan_types.py`, handler and tests | Missing decision can become explicit block | High | Medium | Static and runtime test | Python protocol malformed-result matrix | Phase 2C candidate | Restore parser default | Yes |
| Stored decision columns are unconstrained strings | Prisma and bootstrap schemas | Invalid strings can exist when written outside typed producers | High | Medium | Static | Migration/backfill and compatibility evidence | Later schema phase | Revert constraint/migration | Yes |

## Rollback

The decision correction and disclosure correction are independently reversible:

1. Revert the commit that introduces and applies the CLEAR interpreter to restore the former execution decision mapping. No database rollback is needed; already-corrected execution rows are historical records and MUST NOT be rewritten automatically.
2. Revert the MCP disclosure commit to restore former messages only if an emergency compatibility decision explicitly accepts the disclosure risk.
3. Re-run the Phase 1 characterization commit to reproduce the original baseline and the Phase 2B focused suites to verify the selected rollback boundary.

Rollback does not authorize deleting or rewriting execution history, changing the CLEAR threshold, or weakening authorization and confirmation gates.

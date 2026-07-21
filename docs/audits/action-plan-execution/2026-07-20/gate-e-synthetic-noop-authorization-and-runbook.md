# Gate E synthetic no-op authorization and runbook

Status: **DRAFT — BLOCKED BY MISSING BOUNDED LIVE HARNESS — NO EXECUTION
AUTHORIZATION**

This document defines the maximum safe Gate E operation. It does not authorize
credential configuration, executor activation, Railway mutation, application
deployment, ActionPlan creation, command execution, or result submission.

## Entry prerequisites

Gate E may be requested only after committed evidence proves:

1. Gate R2 and the repeated Gate C isolation proof passed.
2. Gate G published the exact cumulative source commit.
3. Gate V passed the real PostgreSQL 18 validator target.
4. Gate M applied and verified both additive migration records in the isolated
   preview.
5. Gate D deployed the exact commit and passed startup, health, authentication,
   no-store, fixed-error, and disclosure checks.
6. `ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED=true` is safe, while command
   acceptance and new assignment remain disabled before this gate.
7. The preview contains zero `REQUESTED`, `CLAIMED`, or `RUNNING` runs and no
   legacy Python daemon or competing executor.
8. Production and Phase 2D stable identities remain unchanged.
9. One purpose-built synthetic executor harness has been locally reviewed and
   tested. It must exercise the real HTTP protocol and journal/acknowledgement
   logic without invoking an OS command, shell, provider, bridge, worker, or
   application callback.

## Current blocker

No such live harness is committed. The Python runner in
`daemon-python/arcanos/action_plan_execution_runner.py` accepts only
`terminal.run` and crosses the real local-command boundary after start. A
nominal command such as `true`, `exit 0`, or `echo` is still a real command and
does not satisfy this gate.

The existing unit fixtures in
`tests/fixtures/action-plan-execution-protocol-v1.json` and Python protocol
tests prove semantics locally but are not a live preview executor. The GPT
Railway probes call unrelated provider paths and must not be reused.

Until a bounded harness exists, this authorization cannot be submitted as an
executable request. Do not manually emulate result submission after start;
that would fabricate execution evidence.

## Exact maximum effect budget

One approved Gate E run may create at most:

| Effect | Maximum |
|---|---:|
| Synthetic plan | 1 |
| Action in the plan | 1 |
| Execution command request | 1 |
| Authoritative command row | 1 |
| Execution run | 1 |
| Claim transition | 1 |
| Start transition | 1 |
| Synthetic local execution effect | 0 |
| Result submission | 1 |
| Accepted terminal result | 1 |
| Provider calls | 0 |
| OS/shell/local commands | 0 |
| Worker jobs | 0 |
| Sibling action/result writes | 0 |
| Retries after an ambiguous mutation | 0 without a separate recovery decision |

The harness may perform bounded read-only protocol/status/result checks, but
their exact count must be fixed in its reviewed implementation and
authorization. The one result may represent only the harness's explicit
synthetic no-op outcome. It must not claim that a real action ran.

## Required identity and configuration

The authorization must name exact non-secret values for:

- preview project and environment IDs;
- server-derived expected execution realm;
- requester principal ID;
- operator principal ID, only if plan approval requires it;
- executor principal ID;
- executor instance ID;
- assigned agent ID;
- selected synthetic capability and its authoritative database grant;
- final application source commit and deployment IDs; and
- migration versions and checksums.

Secret values remain unnamed and unprinted. The only credential variable names
that may participate are:

- `ACTION_PLAN_REQUEST_TOKEN`;
- `ACTION_PLAN_OPERATOR_TOKEN`, only for the required approval boundary; and
- `ACTION_PLAN_EXECUTOR_TOKEN`.

The fixed server identity names are:

- `ACTION_PLAN_REQUEST_PRINCIPAL_ID`;
- `ACTION_PLAN_OPERATOR_PRINCIPAL_ID`;
- `ACTION_PLAN_EXECUTOR_PRINCIPAL_ID`;
- `ACTION_PLAN_EXECUTOR_INSTANCE_ID`;
- `ACTION_PLAN_EXECUTOR_AGENT_ID`; and
- Python's non-secret `ACTION_PLAN_EXECUTOR_EXPECTED_REALM` pin.

No credential may be printed, supplied in a request body, placed in command
arguments, saved in the journal, copied from production/Phase 2D, or reused
between roles. The harness must obtain credentials through the preview secret
store and use the dedicated executor credential only for execution protocol
requests.

## Required protocol path

The harness must use the existing strict operations without body-shape
fallback:

1. `GET /action-plan-executions/protocol` — authenticate and verify the exact
   realm, role, schema, and operation set.
2. Create exactly one realm-owned synthetic plan with exactly one action using
   the authenticated requester boundary.
3. Obtain the required explicit operator approval/confirmation through existing
   plan lifecycle boundaries; confirmation does not grant identity.
4. `POST /plans/:planId/execute` — command-only, with one command idempotency
   key, creating exactly one run and no result.
5. Prefer `POST /plans/:planId/executions/:runId/claim` for the known run rather
   than `claim-next`; the exact run, owner, instance, realm, action snapshot,
   generation, and capability must match.
6. `POST /plans/:planId/executions/:runId/start` with one start idempotency key.
7. Invoke the reviewed in-process synthetic no-op seam. It must create no OS,
   shell, process, provider, bridge, or worker effect and must durably record in
   the local journal that the synthetic step completed.
8. `POST /plans/:planId/executions/:runId/result` with one result idempotency key
   and one bounded synthetic result.
9. `GET /plans/:planId/executions/:runId` and
   `GET /plans/:planId/executions/:runId/result` only as bounded acceptance
   verification.

`POST /action-plan-executions/claim-next` is not preferred because it could
select unexpected work. If the reviewed Python harness can only use
`claim-next`, the gate must additionally prove this is the only `REQUESTED` run
for the exact assigned executor before and after the claim, and the gate must
still permit only one claim request.

## Required idempotency identities

The final authorization must predeclare one unique, non-secret test namespace
and exactly one key for each mutating operation:

- command key;
- claim key;
- start key; and
- result key.

Keys are generated for this preview gate, never reused across environments,
never logged raw by the server, and never changed after a request is sent. A
lost response triggers a read/replay decision through the durable journal; it
does not authorize a second key or a second run.

## Activation sequence

The operator must authorize each phase in one bounded Gate E request:

1. Reconfirm exact target, source commit, deployment IDs, schema checksums,
   private topology, zero active runs, and zero competing executors.
2. Configure or verify the dedicated preview executor binding by name/presence
   only. Credential configuration itself requires explicit authority.
3. Enable protocol recovery/drain, then command acceptance, while assignment
   remains off.
4. Create and approve the single plan.
5. Send the single command and capture its single run ID.
6. Enable assignment only for the bounded synthetic harness.
7. Claim the exact run once, start it once, perform the zero-effect synthetic
   seam, and submit one real protocol result for that synthetic seam.
8. Verify the terminal run, bounded result, plan aggregation, ordered events,
   journal acceptance receipt, and acknowledgement.
9. Disable assignment and command acceptance immediately after the accepted
   result. Keep drain/recovery available only long enough to prove zero active
   runs.
10. Stop the harness and record production/Phase 2D non-impact.

No step may infer success from process exit alone. The result is successful
only after the backend returns an accepted or idempotent accepted response and
the journal durably records the acceptance receipt.

## Acceptance matrix

The run passes only if all are true:

- one plan contains one action;
- one command creates one run and no result;
- the assigned authenticated executor alone claims the run;
- start changes only that run to `RUNNING`;
- no provider, shell, local command, worker, bridge, or callback executes;
- one result changes only that run/action to the submitted terminal state;
- no sibling result exists and no plan success is fabricated early;
- event order is requested, claimed, started, result accepted, terminal;
- command, claim, start, and result keys each have one authoritative identity;
- retry/read recovery cannot create a second effect;
- the Python/harness acknowledgement occurs only after durable acceptance;
- logs, events, snapshots, and output contain no credential, authorization
  header, action payload, command, provider data, SQL, path, stack, or raw
  result; and
- production and Phase 2D have no deployment, variable, data, or request
  change.

## Abort rules

Stop before the next mutation on any:

- target, realm, owner, instance, agent, action, snapshot, generation, or
  source-commit mismatch;
- nonzero pre-existing run or competing executor;
- unexpected assignment from `claim-next`;
- provider or real-command attempt;
- second plan, action, command, run, claim, start, or result;
- response ambiguity without a safe journal-backed read/replay path;
- unexpected sibling or plan-level mutation;
- disclosure sentinel match;
- protocol error, journal permission/integrity failure, or malformed response;
  or
- production or Phase 2D change.

An abort grants no retry, cleanup, cancellation, or administrative transition.
Preserve evidence, disable new commands and assignment, keep drain/recovery on
only when needed for the one known run, and request separate containment.

## Rollback

Before a run exists, disable command acceptance and assignment and remove the
synthetic harness deployment under separately authorized cleanup.

After a run exists, do not delete or overwrite it. Disable new commands, leave
recovery/drain available, and resolve only the known run under a separate
recovery authorization. Terminal evidence is immutable. A retry, if later
supported, must create a new attempt/run identity; Gate E does not authorize
one.

The additive schema remains. Application rollback may use only a Phase 2E-
compatible build that preserves authentication and command/result separation.

## Copy-ready authorization request — blocked template

Do not submit this template until the tooling blocker is resolved and every
bracketed field is replaced with committed evidence.

```text
Authorize ARCANOS Phase 2E Gate E synthetic no-op validation only.

Target the isolated Phase 2E preview [project/environment IDs] at exact web
commit/deployment [IDs], with canonical migration
20260717_action_plan_execution_v2 checksum
cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533 and
attempt-history migration 20260718_action_plan_execution_migration_history_v1
checksum 1e08d934d28546a9b3ae642b6bd0c85baecbe797c2c4f5bc19cc1131208c2f8a
verified.

Authorize exactly one synthetic plan, one action, one command, one run, one
claim, one start, and one result submission through the reviewed bounded
synthetic harness [commit/path]. Authorize zero provider calls, zero OS/shell/
local commands, zero worker jobs, zero sibling writes, and no production or
Phase 2D action. Use only the named preview requester/operator/executor
bindings, server-derived realm, fixed capability grant, and predeclared
idempotency identities. Require backend acceptance and durable journal receipt
before acknowledgement.

Stop on any mismatch, extra effect, disclosure, ambiguous mutation, or failed
durability check. Disable command acceptance and assignment after the one
terminal result and return sanitized evidence. Do not push, merge, deploy
production, delete the preview, or perform an administrative retry.
```

## Tooling required before this draft can become executable

1. A preview-only synthetic executor harness with an explicit, default-off
   build/runtime guard and no production registration.
2. Tests proving the guard cannot be enabled in production or Phase 2D and the
   seam cannot invoke `terminal.run` or any provider.
3. A one-plan/one-action provisioning wrapper using strict existing schemas.
4. A fixed effect-count and event-order verifier using parameterized reads.
5. A journal/acknowledgement verifier that emits only stable safe codes.
6. A disclosure and production/Phase 2D non-impact projector.
7. Independent adversarial review and a committed exact Gate E authorization.

# Phase 2E cumulative preview gate runbook

Status: **LOCAL REVIEW ARTIFACT — NO RAILWAY, PUSH/PR, MIGRATION, APPLICATION
DEPLOYMENT, OR EXECUTOR AUTHORIZATION**

Evidence cut: branch `codex/phase2e-advisory-history-gate-r`, commit
`b510a976e09e5ff8e153535d76bdd8da6d69fb3f`. Local implementation and scoped
commits through this evidence cut were separately authorized. This runbook and
the accompanying provenance correction are uncommitted documentation changes;
they do not authorize another live Railway attempt.

This runbook replaces the stale sequencing assumptions in:

- `../2026-07-17/railway-preview-gates-c-d-proposal.md`; and
- `../2026-07-18/postgres18-corrective-validation/gate-v-draft.md` and
  `gate-m-draft.md`.

Those files remain historical evidence. They are not executable instructions.
This document does not declare a live gate passed unless a later committed,
sanitized execution artifact proves it.

## Absolute boundary

Every gate below requires separate explicit operator authorization. A later
gate never inherits mutation authority from an earlier gate.

Production is out of scope. Do not deploy, restart, configure, migrate, query,
write, test, or otherwise touch production. Do not mutate the Phase 2D preview.
Do not push, open a pull request, merge, apply a migration, deploy an
application, or activate an executor unless the corresponding gate expressly
authorizes that exact action.

## Fixed preview identities

These are identifiers preserved by committed evidence, not a claim about live
state after the evidence timestamp.

| Resource | Name or role | Stable ID | Related stable ID |
|---|---|---|---|
| Project | `Arcanos` | `7faf44e5-519c-4e73-8d7a-da9f389e6187` | — |
| Environment | `phase2e-validation-20260717` | `fb99f47d-5ef5-44c1-96c2-acf7b90fab13` | private network `464f2194-3825-4ac1-a705-192566561675` |
| Web service | `ARCANOS V2` | `c4ade025-3f13-4fca-9309-5d0dd81396fe` | no Phase 2E deployment proven |
| Worker service | `ARCANOS Worker` | `1765befb-b805-4051-9af9-28634e986886` | no Phase 2E deployment proven |
| Migration validator | `phase2e-migration-validator-20260718` | `d8d5181a-2f72-48d7-8413-6f05d113876c` | must remain one-shot |
| Compatibility validator | `phase2e-compatibility-validator-20260718` | `febdf999-1c96-48df-8e28-c905b8b27082` | must remain one-shot |
| Original PostgreSQL | quarantined | `b7789306-8aef-4113-add5-02883a6cc087` | volume `35c26093-1e3f-4d34-b699-89c65d2fb92d` |
| Original Redis | quarantined | `434fa5b4-b52c-4caf-aaba-e87c173bf10d` | volume `d3690500-fcc5-4c06-afa6-cf30e91f608d` |
| PostgreSQL R2 | failed and retained offline | `a2a57da4-a928-427f-be30-d4a68b59a117` | volume `2998734d-7530-4f26-b715-cea4780bd437` |
| Redis R2 | retained source-less and offline | `1ac0bd56-50b3-49eb-954c-ea83515ec915` | volume `983c4f0a-9180-4621-b65e-dfdd0b79f2bd` |
| PostgreSQL R3 | prepared offline by R3B1 | `7346b3f6-bf3d-46e1-9d66-79f10847ef89` | service instance `86dde430-50ac-4d5c-95c3-cb27064eff51` |
| PostgreSQL R3 volume | fresh R3B1 volume | `ce93ced0-0c15-48f9-87fc-d9153ffefdc8` | volume instance `c7969acf-79fd-4a6b-83d7-1e6cb442a030` |

Before every mutation, refresh target-scoped metadata and reject any identity,
deployment, volume, network, source, domain, proxy, variable-name, or state
disagreement. Never substitute a similarly named resource.

## Current evidence-backed stop state

- Gate R0 quarantined the original PostgreSQL and Redis deployments while
  retaining their services and volumes.
- PostgreSQL R3A and R3B1 are preserved as `PASS_WITH_LIMITATIONS`.
- PostgreSQL R3B2 performed one authorized activation attempt. Source
  activation and deployment succeeded for deployment
  `b5e45d34-19b8-4253-b230-c3ab0b60b0d7`; the final safe projection recorded
  one active successful deployment, an active private endpoint, and zero TCP
  proxies. Authenticated readiness then stopped with
  `GATE_R_POSTGRES_READINESS_REMOTE_TARGET_MISMATCH`. It was not retried or
  contained, so PostgreSQL R3 remains deployed but Gate R1 readiness is
  incomplete.
- The PostgreSQL readiness wrapper correction is committed at `537c94b5`. It
  is locally tested, but no second live readiness attempt has been authorized
  or observed.
- Redis R2 remains source-less and offline. Target-bound config, activation,
  deployment-status, and readiness tooling is committed at `b510a976`, but no
  live Redis authorization or execution has occurred.
- Gate R2, Gate G, Gate V, Gate M, Gate D, and Gate E have not been executed.
- No Phase 2E application or executor deployment is proven.

Relevant evidence:

- `../2026-07-18/private-only-gate-r/gate-r0-corrective-quarantine-evidence-2026-07-19.json`
- `../2026-07-18/private-only-gate-r/gate-r1-postgres-r3a-execution-evidence-2026-07-20.json`
- `../2026-07-18/private-only-gate-r/gate-r1-postgres-r3b1-execution-evidence-2026-07-20.json`
- `../2026-07-18/private-only-gate-r/gate-r1-postgres-r3b2-authorization-request-2026-07-20.md`
- `../2026-07-18/private-only-gate-r/gate-r1-postgres-r3b2-execution-evidence-2026-07-20.json`

## Gate sequence

```text
R1 PostgreSQL R3B2 corrective readiness
  -> R1 Redis preparation/activation
  -> combined replacement isolation
  -> R2 reference cutover and retirement
  -> full Gate C isolation re-proof
  -> G exact-commit publication
  -> V validator build and PostgreSQL 18 proof
  -> M additive migration validation/application in preview
  -> D exact-commit application deployment with executor disabled
  -> E one bounded synthetic executor protocol run
```

Failure at any arrow stops the chain. It never grants repair, retry,
containment, cleanup, or rollback authority beyond that gate's written scope.

## Gate R1 — finish private replacement readiness

### R1 PostgreSQL R3B2 corrective readiness

The original R3B2 activation and deployment-wait operations have already been
consumed. **Do not rerun them.** They created and latched deployment
`b5e45d34-19b8-4253-b230-c3ab0b60b0d7` for service
`7346b3f6-bf3d-46e1-9d66-79f10847ef89`:

```text
# HISTORICAL ONLY — DO NOT RERUN
node scripts/gate-r1-postgres-r3-source-activation.js --operation activate
node scripts/gate-r1-postgres-r3-deployment-status.js --operation wait --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89

# A future separately authorized readiness-only correction may use these
node scripts/gate-r1-postgres-r3-deployment-status.js --operation verify-success --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --deployment-id <latched-id>
node scripts/gate-r1-postgres-readiness.js --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89
```

For the historical attempt, `<latched-id>` was
`b5e45d34-19b8-4253-b230-c3ab0b60b0d7`. A corrective attempt must re-prove
that exact deployment immediately before and after readiness; it must not
activate source or create another deployment. The readiness correction adapts
to Railway CLI 4.30.2 by supplying one bounded remote command instead of a
nested `sh -lc` argument sequence. Live use requires a new exact
readiness-only authorization and fresh target, exposure, and private-endpoint
preconditions. The approved source string remains
`ghcr.io/railwayapp-templates/postgres-ssl:18.4`; it is tag-pinned, not digest
immutable.

Acceptance requires one successful deployment, authenticated non-SQL
readiness, the exact R3B1 volume and variable-name set, an active private
endpoint, zero Railway/custom domains, zero TCP proxies, unchanged retained
resources, and production/Phase 2D non-impact.

### R1 Redis

Target-bound Redis preparation is now committed in:

- `scripts/gate-r1-redis-r2-config-patch.js`;
- `scripts/gate-r1-redis-r2-source-activation.js`;
- `scripts/gate-r1-redis-r2-deployment-status.js`; and
- `scripts/gate-r1-redis-readiness.js`.

The associated local tests pass. These wrappers bind the retained Redis R2
identity, configuration, pinned source, deployment latching, and authenticated
readiness rather than accepting an arbitrary target or command. They have not
been exercised against Railway.

**Authorization/evidence blocker:** Redis still needs a fresh exact-operation
authorization, current safe projections, exact service-instance and volume
proof, zero-exposure proof, active private-endpoint proof, and an operation
ledger before activation. The historical R2 runbook remains superseded and
must not be executed. No committed local tool result constitutes a live Redis
readiness result.

### Combined R1 acceptance

After both replacements independently pass, a fresh combined projection must
prove both are healthy, private-only, independently credentialed, attached to
fresh volumes, have zero domains/proxies/public-URL variables, and have no
application consumers. Preserve exact deployment IDs and safe readiness codes.

## Gate R2 — reference cutover, retirement, and Gate C re-proof

Gate R2 is destructive and separately authorized. It must:

1. Prove both replacements passed the combined R1 gate.
2. Update only the inactive validator `DATABASE_URL` references to the new
   PostgreSQL private reference, without deploying a validator.
3. Remove stale public-URL variable names from validator/data-service scope.
4. Retire the original PostgreSQL and Redis services and define disposition of
   their old volumes.
5. Retire or explicitly retain-and-quarantine the failed PostgreSQL R2 identity
   and any superseded Redis identity; the authorization must name every target.
6. Prove the old credentials can no longer reach a live service without
   retrieving or comparing credential values.
7. Repeat the complete Gate C isolation proof: distinct private Postgres and
   Redis, fresh volumes, zero domains/proxies, no application/worker/validator/
   daemon/executor deployments, no migration, and production/Phase 2D
   non-impact.

**Tooling blocker:** no current R2 request names the complete R3/R2 topology or
provides reviewed exact-target retirement and reference-cleanup entry points.
The historical runbook contains superseded R2 commands and is not executable.
Do not infer delete commands from service IDs.

Rollback before deletion is to leave the old services offline and retained.
After deletion, restoration is not guaranteed; therefore retirement must be
last and requires a complete pre-delete evidence snapshot.

## Gate G — publish exact source commits

Railway validator deployment is GitHub-triggered, so Gate G is a prerequisite
for Gate V. Gate G must separately authorize publication of:

- the final cumulative Phase 2E commit selected after Gate R documentation and
  validation are complete; and
- the bounded old-application compatibility commit
  `87900e71143781fd9cdea29de23a4763944fa4d9` on branch
  `codex/phase2d1-bounded-compatibility-validator`, if that remains the reviewed
  compatibility source.

The compatibility commit is not an ancestor of this branch. Do not merge or
rewrite it merely to make it deployable. Record remote branch names, pushed
commit hashes, CI status, and repository protections. Push, PR creation, and
merge are independent authorizations.

**Artifact blocker:** no dedicated Gate G request/runbook exists, and neither
branch has a proven remote deployment reference in the current local evidence.

## Gate V — build and real PostgreSQL 18 validator proof

Use only these committed custom Railway config files:

| Purpose | Config | In-container operation |
|---|---|---|
| Plan | `railway.phase2e-validator.json` | `phase2e-validator-entrypoint.sh --plan` |
| Apply | `railway.phase2e-validator.apply.json` | `phase2e-validator-entrypoint.sh --apply` |
| Migration verify | `railway.phase2e-validator.verify.json` | `phase2e-validator-entrypoint.sh --verify` |
| Runtime verify | `railway.phase2e-validator.runtime-verify.json` | `phase2e-validator-entrypoint.sh --verify-runtime` |
| Drain | `railway.phase2e-validator.drain.json` | `phase2e-validator-entrypoint.sh --drain` |
| PostgreSQL 18 integration | `railway.phase2e-validator.pg18-integration.json` | `phase2e-validator-entrypoint.sh --pg18-integration` |

The ordinary `railway.json` is forbidden for validator work. The Phase 2D.1
compatibility service must use
`railway.phase2d1-compatibility-validator.json` from the separately published
compatibility commit; that file is intentionally absent from the cumulative
Phase 2E branch.

Allowed non-system validator variable names are:

- `DATABASE_URL`, as a private reference to the replacement PostgreSQL;
- `PHASE2E_VALIDATOR_EXPECTED_DATABASE_HOST`;
- `PHASE2E_VALIDATOR_EXPECTED_DATABASE_NAME`;
- `PHASE2E_VALIDATOR_EXPECTED_SERVICE_ID`;
- `PHASE2E_VALIDATOR_EXPECTED_SERVICE_NAME`; and
- `PHASE2E_VALIDATOR_EXPECTED_SOURCE_COMMIT`.

The PostgreSQL 18 target additionally requires:

- `ACTION_PLAN_EXECUTION_PG18_INTEGRATION=1`; and
- `ACTION_PLAN_EXECUTION_PG18_RAILWAY_VALIDATION=1`.

Gate V must prove the exact Git commit, custom config, service identity, private
database identity, and PostgreSQL major version before database work. All
validator deployments are one-shot with `restartPolicyType: NEVER`.

**Command blocker:** the repository does not contain a current exact Railway
service/config deployment command for the replacement topology. Do not promote
the stale placeholder `railway up` commands. Gate V must first add an
exact-target, source-commit-pinned request after Gate G and Gate C re-proof.

The validator Docker base is tag-pinned rather than digest-pinned. Record the
resolved build/image digest before treating the build as reproducible.

## Gate M — additive preview migration

The canonical migration is:

```text
version: 20260717_action_plan_execution_v2
checksum: cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533
```

The additive attempt-history migration is:

```text
version: 20260718_action_plan_execution_migration_history_v1
checksum: 1e08d934d28546a9b3ae642b6bd0c85baecbe797c2c4f5bc19cc1131208c2f8a
```

The older Gate M draft's claim that durable attempt history is absent is stale;
`scripts/action-plan-execution-migration-history.mjs` now implements it. Its
existence does not substitute for real PostgreSQL 18 validation.

After a successful Gate V, Gate M must use the one-shot config targets above to
prove, in order: plan; attempt-history installation; canonical apply or bounded
recovery; migration verify; runtime verify; CHECK/index and 22-index readiness;
repeat apply; checksum-mismatch refusal; pinned advisory-lock contention;
active-run drain; Phase 2D.1 old-app/new-schema compatibility; and disposable-
only compensation.

The primary preview schema is additive. Do not drop tables or columns, rewrite
legacy rows, perform an ambiguous backfill, or run compensation against the
primary preview database. Compensation is permitted only in a disposable
validation schema/database under explicit Gate M authority.

Abort on wrong host/name/service/source commit, public URL, checksum mismatch,
partial history/ledger state, invalid constraints/indexes, advisory-lock
failure, nonzero active runs, output disclosure, or any production/Phase 2D
target. A required atomic write failure is a migration failure, never success.

## Gate D — exact-commit application preview

Gate D requires completed Gates R2/C/G/V/M and a new exact deployment request.
The 2026-07-17 proposal's application commit and generic Railway commands are
stale placeholders.

Before deployment, record:

- exact cumulative Phase 2E commit and clean worktree;
- exact web and optional worker service instances;
- exact additive schema/history verification;
- preview-only Postgres and Redis private references;
- exact rollback application commit;
- zero nonterminal execution runs; and
- provider, bridge, healing, worker, and executor controls in fail-closed
  preview mode.

Phase 2E credential/identity variable names, values never printed or committed:

- `ACTION_PLAN_REQUEST_TOKEN`
- `ACTION_PLAN_REQUEST_PRINCIPAL_ID`
- `ACTION_PLAN_OPERATOR_TOKEN`
- `ACTION_PLAN_OPERATOR_PRINCIPAL_ID`
- `ACTION_PLAN_EXECUTOR_TOKEN`
- `ACTION_PLAN_EXECUTOR_PRINCIPAL_ID`
- `ACTION_PLAN_EXECUTOR_INSTANCE_ID`
- `ACTION_PLAN_EXECUTOR_AGENT_ID`
- `ACTION_PLAN_EXECUTOR_EXPECTED_REALM`
- `ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID`
- existing `MCP_BEARER_TOKEN`, only when HTTP MCP is in scope

Tokens must be independently generated with at least 256 bits of entropy and
stored only in the preview secret store. Never print, hash for evidence, place
in arguments, copy from another environment, or reuse across roles. Principal,
instance, and agent IDs are non-secret but still exact, bounded server-side
bindings.

Runtime controls are:

- `ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED`
- `ACTION_PLAN_EXECUTION_ACCEPT_COMMANDS`
- `ACTION_PLAN_EXECUTION_ASSIGN_REQUESTED`
- `ACTION_PLAN_EXECUTION_DRAIN_ENABLED`

Gate D deploys with executor assignment and activation disabled. The execution
realm is server-derived as
`railway:<RAILWAY_PROJECT_ID>:<RAILWAY_ENVIRONMENT_ID>`; no request or client
value may select it.

Deployment order is migration verification, web, health/readiness/security and
passive protocol checks, then worker only if required for compatibility. The
worker is not an ActionPlan executor. Gate D must stop before Python activation,
claim, start, result submission, provider access, or a real command.

Rollback disables command acceptance first, keeps recovery/drain available
until no `REQUESTED`, `CLAIMED`, or `RUNNING` run exists, and restores only an
application build that preserves command/result separation and authentication.
The additive schema remains in place.

**Command blocker:** no current exact-commit Gate D deployment request exists.
Do not use the stale generic `railway up` examples until exact services,
config/source commit, bounded logs, smoke commands, and rollback target are
reviewed.

## Gate E — one bounded synthetic executor protocol run

Gate E is defined in
`gate-e-synthetic-noop-authorization-and-runbook.md`. It is separately
authorized and runs only after Gate D proves the application boundary with
assignment disabled.

Current production Python supports only `terminal.run`; it does not contain a
provider-free, OS-command-free synthetic execution mode. There is no committed
live Gate E harness. Therefore Gate E remains blocked until a purpose-built,
test-only or preview-only synthetic executor path is added and reviewed without
weakening production assignment semantics.

## Universal abort conditions

Stop immediately on:

- target identity, source commit, config, image, volume, private network, or
  realm mismatch;
- missing, ambiguous, stale, or nonzero exposure evidence;
- a credential, connection string, resolved reference, payload, SQL, path,
  stack, provider response, or raw log appearing in output;
- an unapproved deployment, migration, SQL/Redis operation, application,
  validator, worker, daemon, executor, ActionPlan, or provider call;
- unexpected run/event/result counts, sibling mutation, replay conflict, or
  terminal-state regression;
- production or Phase 2D selection or change; or
- a required check that cannot be performed with committed bounded tooling.

Stopping preserves evidence but confers no retry or cleanup authorization.

## Documentation gaps to close before execution

1. Complete and commit the explicit provenance limitations for the blocked
   PostgreSQL R3B2 artifact. Preserve the historical readiness failure; do not
   relabel it as a pass after local correction.
2. Independently review the committed Redis tooling and add a fresh exact
   Redis activation/readiness authorization before any live operation.
3. Add a complete R2 exact-target retirement and Gate C re-proof request.
4. Add a Gate G exact-branch push request for both source commits.
5. Replace Gate V and Gate M drafts with exact service/config deployment
   requests after replacement identities are final.
6. Replace the stale Gate D proposal with an exact-commit, exact-service request.
7. Add the bounded synthetic Gate E harness described by the companion draft.

# PR 1408 Merge Readiness

- Pull request: <https://github.com/pbjustin/Arcanos/pull/1408>
- Branch: `codex/local-agent-preview-hardening`
- Base: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed runtime candidate:
  `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Runtime diff: 125 files, 35,999 additions, 312 deletions
- Review date: 2026-07-24
- Recommendation: **READY FOR REVIEW after the review-artifact commit passes**
- Merge authorization: **not granted**

## Executive summary

Seven independent production-readiness reviewers inspected the complete pull
request, including every changed-file category, tests, migrations,
documentation, CI, Railway changes, and retained preview evidence. Reviewers
did not assume that another role had covered an overlapping concern.

The runtime candidate preserves the intended ARCANOS architecture:

```text
Custom GPT
  -> /gpt-access/*
  -> TypeScript identity, tenancy, contracts, policy, confirmation,
     persistence, jobs, audit, and tracing
  -> existing PostgreSQL job lifecycle
  -> private outbound-only Python daemon
  -> fixed typed handler
  -> structured result
  -> /gpt-access/jobs/result
```

No reviewer reports an open Critical or High finding. No Critical or High
finding was waived. All required CI and isolated-preview gates for
`f7f3a2ca` passed. The remaining findings are bounded Medium/Low operational,
scale, availability, or production-enablement conditions.

All seven reviewers returned **APPROVE WITH CONDITIONS**. Their conditions are
preserved below and in the linked independent artifacts.

The production-readiness review itself found and resolved several material
issues:

- generic job, diagnostics, worker, and MCP surfaces could disclose
  local-agent state outside the protected tenant-bound result path;
- local-agent event timelines were not originally filtered by authoritative
  principal and workspace;
- unsupported Git layouts and external Git metadata needed stronger
  fail-closed handling;
- Windows alternate-data-stream paths could bypass ordinary path policy;
- natural-language confirmation needed binding to the resolved action,
  payload, and execution plan;
- a changed expiry test mixed wall-clock and mocked database time, producing
  a one-millisecond CI race;
- the preview isolation/fail-closed harness existed but was not a required CI
  gate.

The fixes were narrow and architecture-preserving. The final runtime candidate
passed the repeated review and evidence cycle.

## Review method and artifacts

The independent artifacts are preserved under
`docs/reviews/merge-readiness/`:

- [Architecture](reviews/merge-readiness/architecture.md)
- [Security](reviews/merge-readiness/security.md)
- [Database and job semantics](reviews/merge-readiness/database.md)
- [Local Agent](reviews/merge-readiness/local-agent.md)
- [Productivity](reviews/merge-readiness/productivity.md)
- [Release Engineering](reviews/merge-readiness/release-engineering.md)
- [Devil's Advocate](reviews/merge-readiness/devils-advocate.md)

The isolated deployment, migration, E2E, confirmation, observability, and
teardown evidence is in
[PREVIEW_E2E_REPORT.md](PREVIEW_E2E_REPORT.md).

## Architecture review

Verdict: **APPROVE WITH CONDITIONS**

The TypeScript/Python authority boundary remains intact:

- TypeScript owns public capability contracts, authentication,
  authorization, tenancy, confirmation, persistence, idempotency, lifecycle
  rules, job creation, audit, tracing, and public response behavior.
- Python has no public HTTP API, no PostgreSQL access, and no independent
  authentication, confirmation, queue, or workflow engine.
- `ARCANOS:PRODUCTIVITY` and `ARCANOS:LOCAL_AGENT` remain separate protected
  modules under `/gpt-access/*`.
- Legacy routes and `/gpt/:gptId` do not expose either protected control
  plane.
- Existing `job_data`, `job_events`, ActionPlan, worker, audit, and trace
  infrastructure is reused.
- No generic shell capability was introduced.

The remaining architecture conditions are operational: production migration
planning, retention and scale bounds, private mutation workspaces, and the
documented process-local confirmation limitation before horizontal scaling.

## Security review

Verdict: **APPROVE WITH CONDITIONS**

The review verified:

- trusted principal, workspace, and device context is server-controlled;
- local-agent jobs and timelines are inaccessible through generic inspection
  surfaces and are tenant-filtered at the database query boundary;
- `tests.run` and `patch.apply` require exact, one-time challenge evidence;
- confirmation cannot be supplied in model payload fields or bypassed by
  trusted/manual modes;
- local-agent executor credentials use a dedicated audience, fixed scopes,
  device identity, rotation overlap, and revocation behavior;
- paths are normalized and restricted to registered roots, with secret-file,
  reparse/symlink, ADS, Git metadata, hooks, filters, includes, alternates,
  submodules, and linked-worktree defenses;
- `tests.run` defaults to disabled and production-capable execution requires
  a bounded, non-root, network-restricted container sandbox;
- output is bounded, control-sequence sanitized, and treated as untrusted
  data;
- logs and evidence contain no actual credentials.

The main accepted security residual is filesystem time-of-check/time-of-use
risk when a hostile local process can modify a patch workspace concurrently.
Mutation roots must remain private to the daemon account, and uncertain
mutation outcomes require manual reconciliation.

## Database review

Verdict: **APPROVE WITH CONDITIONS**

The database review confirmed:

- database-enforced uniqueness is authoritative for local-agent idempotency;
- tenant, device, action, key, payload fingerprint, expiry, and reuse
  semantics are explicit;
- claims, terminal results, expiry transitions, and per-job lifecycle events
  use transaction boundaries and row predicates that fail closed under races;
- bounded expiry recovery uses per-job savepoints, so one failed event does
  not collapse the batch;
- result submission repeats database-clock expiry and lease predicates;
- productivity mutations atomically persist domain state, event/outbox data,
  and command receipts;
- task optimistic version checks and project timestamp checks reject stale
  plans;
- the production timeline query returns matching-tenant local-agent events,
  hides foreign and unscoped local-agent events, and preserves ordinary event
  behavior.

Production enablement still needs an operator-reviewed migration/startup-DDL
runbook, terminal local-agent retention/audit policy, and productivity receipt
cleanup and projection scale policy.

## Productivity review

Verdict: **APPROVE WITH CONDITIONS**

The review verified:

- task and project lifecycles are deterministic and invalid transitions fail;
- trusted tenancy cannot be selected by model-supplied owner/workspace fields;
- reference ambiguity, stale plans, idempotency conflicts, and structured
  recovery errors are explicit;
- `state.current`, `context.summary`, focus, project health, and reviews share
  a consistent derived interpretation;
- mutations return explicit persisted/effect results;
- capability metadata, risk, confirmation, routing, action contracts, and
  generated OpenAPI remain synchronized;
- natural-language confirmation binds the original request and resolved
  action, payload, runner, and risk;
- exact-preview productivity discovery and read scenarios passed.

Before materially increasing tenant volume, the full-workspace current-state
projection and broad repository reads need pagination or bounded query plans.
OpenAPI output schemas can be made more specific, and the initial
single-operator tenancy posture must remain explicit.

## Local Agent review

Verdict: **APPROVE WITH CONDITIONS**

The review confirmed:

- the Python daemon reuses typed existing handlers through one generated
  catalog and registry;
- heartbeat, atomic claim, job expiry, idempotent replay, result correlation,
  cancellation, crash recovery, and offline behavior are fail-closed;
- workspace roots are registered locally and server jobs cannot supply root,
  principal, workspace, device, authorization, or confirmation authority;
- repository search, Git status/diff, test execution, and patch
  preview/application use fixed handlers and fixed command profiles;
- no generic command capability or public Python API exists;
- Linux descriptor-safe and symlink/link-race tests, Windows Python tests,
  container sandbox tests, and catalog parity passed;
- exact-preview local-agent jobs returned correlated six-event timelines;
- `patch.preview` did not mutate the fixture and exact-candidate
  `patch.apply` stopped at `CONFIRMATION_REQUIRED`.

Production-capable `tests.run` must remain sandboxed-only. Patch workspaces
must be daemon-owned and private. Manual reconciliation remains mandatory for
an uncertain local mutation result.

## Deployment review

Verdict: **APPROVE WITH CONDITIONS**

The isolated preview uses:

- environment `arcanos-preview-bf8ac3bd`
  (`99d9eeae-c618-4a77-8498-85dd0d7444cc`);
- API deployment `ce5a974e-a087-4634-9e74-992b4c44144e`;
- worker deployment `87baaf0a-ac51-42a0-abdc-5044cd71f122`;
- preview-owned PostgreSQL and Redis services;
- preview-only GPT Access and local-agent credentials;
- public preview
  `https://arcanos-api-bf8ac3bd-arcanos-preview-bf8ac3bd.up.railway.app`.

The API and worker reported `SUCCESS`, served the exact runtime candidate, and
were paired by server-controlled deployment metadata. The initial Phase 2E
Redis selection was not modified. Production databases, Redis, variables,
credentials, deployments, and the production Custom GPT were not touched.

The preview remains temporary and has not been torn down. Its credentials,
domain, local device registration, stateful services, fixture data, and
temporary GPT must be removed using the retained teardown plan when human
review is complete.

## Devil's Advocate review

Verdict: **APPROVE WITH CONDITIONS**

The adversarial review independently attempted to falsify the core security,
tenancy, confirmation, job, migration, filesystem, sandbox, productivity, and
deployment claims. It found no remaining Critical or High issue and waived no
finding. The review confirmed that the material defects found in earlier
rounds are resolved in `f7f3a2ca` and covered by regression or preview
evidence.

Its six Medium residual conditions are carried into this report: patch
filesystem TOCTOU within the documented private-workspace threat model,
uncapped productivity snapshots, semantic prompt injection in repository
output, process-local confirmation availability, executor credential exposure
until revocation, and sensitive local journal storage. These are operational,
scale, or availability constraints; none grants authority to Python or bypasses
TypeScript policy.

## Validation results

### Required CI on `f7f3a2ca`

| Gate | Result |
|---|---|
| Build on Node 20.19.0 | Passed |
| Lint and typecheck | Passed |
| Unit suite | 4,944 passed, 14 skipped |
| Integration suite | 84 passed, 9 skipped |
| Windows Python | 551 passed, 13 platform skips |
| Linux sandbox and link-race suite | 29 passed |
| Local-agent PostgreSQL concurrency | Passed |
| Security audit | Passed |
| Railway compatibility | Passed |
| Deployment Readiness | Passed, including preview harness 18/18 |
| Convergence Gate | Passed |
| External build-test | Passed |
| Railway API and worker contexts | Passed |
| All Checks Complete | Passed |

### Local and preview validation

| Command or scenario | Result |
|---|---|
| `npm run build` | Passed |
| `npm run type-check` | Passed |
| `npm run lint` | Passed, 0 errors and 84 existing warnings |
| `npm run validate:railway` | Passed |
| `npm run test:preview-e2e` | 18 passed |
| Local-agent repository suite | 14 passed |
| Formerly flaky expiry case | 20 consecutive passes |
| Full Python daemon suite | 546 passed, 18 expected platform/container skips |
| Focused final reviewer suites | Passed |
| `npm run docs:check` | 281 passed |
| `npm run sync:check` | 0 errors, 0 warnings, 5 legacy information items |
| Preview PostgreSQL suite | 6 passed |
| Exact-deployment authenticated read-only E2E | Passed |
| Exact-deployment `patch.apply` challenge-only test | Passed; no retry or mutation |
| API/worker bounded log scan | 0 fatal and 0 actual credential findings |

One `a3d2251f` unit run failed because a changed test mixed `Date.now()` with a
fixed mock database clock. Runtime code continued to use PostgreSQL `NOW()`.
The test-only `0808eb1f` fix aligned the test with the database clock; the
focused suite, 20-run stress check, and complete `f7f3a2ca` CI then passed.

A broad local Windows test invocation also encountered unchanged,
platform-sensitive baseline tests involving projector identity/session state,
POSIX exit-code assumptions, and line-ending contracts. Their files were
unchanged from the PR base, and the authoritative Node 20.19.0 Linux unit and
integration jobs passed. This distinction is retained rather than describing
the local command as successful.

No current-candidate privileged retry was executed. The previously approved
`tests.run` and `patch.apply` mutations were exact one-time operations on
earlier preview commits. At `f7f3a2ca`, only read-only operations,
non-mutating preview, and a fresh unapproved confirmation challenge were used.

## Residual risks

| Risk | Severity | Required condition |
|---|---|---|
| Patch filesystem TOCTOU and Windows descriptor limitations | Medium | Keep mutation roots private to the daemon account; retain identity rechecks, quarantine, backup, and manual reconciliation. |
| Process-local confirmation and rate-limit state | Medium | Use one/sticky API replica or move ephemeral state to an approved shared store before horizontal scaling. |
| Productivity full-workspace projections | Medium | Add pagination/bounds and load tests before materially increasing tenant volume. |
| Production migration and startup-DDL promotion | Medium | Use an operator-reviewed production runbook, backup, rollback/compensation, and exact target proof. |
| Terminal job and receipt retention | Medium | Define audited retention, cleanup, and legal/operational evidence requirements before production scale. |
| Sandbox image and runtime supply chain | Medium/Low | Pin immutable images, preserve non-root/no-socket/no-privileged controls, and add provenance/SBOM policy before broader distribution. |
| Semantic prompt injection in repository/test output | Medium | Continue treating all daemon output as untrusted data; never convert it into authority. |
| Executor credential theft until rotation or revocation | Medium | Use a dedicated OS account and secret store, alert on unexpected device behavior, and keep rotation/revocation procedures tested. |
| Local SQLite journal and bearer credentials at rest | Medium | Restrict the daemon account and filesystem, rotate/revoke on loss, use encrypted platform storage, and apply a retention policy that preserves unresolved reconciliation evidence. |
| OpenAPI output-schema specificity | Low | Tighten response schemas without changing TypeScript authority. |
| Existing lint/dependency debt | Low/repository-wide | Track the 84 warnings and existing default-branch dependency advisories separately; none was introduced as a hidden pass claim. |
| Temporary preview resources and cost | Operational | Retain only for review, then follow the exact preview-only teardown plan. |

## Reviewer confidence

| Reviewer | Verdict | Confidence | Open Critical | Open High |
|---|---|---:|---:|---:|
| Architecture | Approve with conditions | 0.95 | 0 | 0 |
| Security | Approve with conditions | 0.95 | 0 | 0 |
| Database and job semantics | Approve with conditions | 0.96 correctness / 0.88 production ops | 0 | 0 |
| Local Agent | Approve with conditions | 0.97 | 0 | 0 |
| Productivity | Approve with conditions | 0.95 | 0 | 0 |
| Release Engineering | Approve with conditions | 0.96 | 0 | 0 |
| Devil's Advocate | Approve with conditions | 0.96 | 0 | 0 |

## Merge recommendation

The runtime candidate is suitable to leave Draft and enter human review after:

1. the final review/documentation-only artifact commit is pushed;
2. required checks on that artifact-only head pass;
3. the artifact diff is confirmed to contain no runtime changes; and
4. all seven reviewers remain at **APPROVE** or
   **APPROVE WITH CONDITIONS**.

This is a recommendation to mark the pull request **Ready for Review**, not to
merge it. Human reviewers must decide whether to accept the documented
Medium/Low residuals and production-enablement conditions. This report does
not authorize a production deployment, production migration, production
Custom GPT change, or merge.

# Architecture Review — PR 1408

## Review identity

- Review round: 2
- Reviewer: independent architecture and boundary reviewer
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Reviewed head: `87788342f862d59c60fa3ea830da47c39950dabf`
- Round 1 baseline: `77d6e6c9b7b0db1adeb9c7243dfc19cac87957b9`
- Scope: all 111 changed files, including 55 source/package files, 34 test
  files, four migration artifacts, nine documentation files, and deployment
  or preview configuration
- Verdict: `REQUEST_CHANGES`
- Confidence: high

The implementation preserves the intended ARCANOS architecture. The current
request-changes verdict is caused by an exact-head validation gap, not by a
request to redesign the system.

## Executive assessment

The core boundary remains:

```text
Custom GPT
  -> /gpt-access/*
  -> TypeScript identity, tenancy, policy, confirmation, contracts, and jobs
  -> existing job_data / job_events lifecycle
  -> private outbound Python daemon
  -> fixed typed Python handler
  -> correlated structured result
  -> tenant-bound /gpt-access/jobs/result
```

The PR does not introduce a Python public API, Python PostgreSQL ownership, a
second server queue, a second workflow engine, a generic shell capability, a
parallel authentication system, or a `/gpt/:gptId` execution path for either
protected module.

The two protected modules remain separate:

- `ARCANOS:PRODUCTIVITY` owns deterministic productivity domain behavior and
  tenant-scoped persistence.
- `ARCANOS:LOCAL_AGENT` owns only the TypeScript contract and durable dispatch
  boundary for fixed local operations.

The local SQLite database is a private crash journal. It is neither canonical
ARCANOS state nor a competing server queue.

## Round 1 architecture-relevant dispositions

| Concern | Round 2 disposition | Evidence |
| --- | --- | --- |
| Protected modules could leak into legacy module, GPT routing, or introspection surfaces | Remediated | Both modules set `gptAccessOnly: true` and `exposeLegacyRoute: false` in `src/services/arcanos-local-agent.ts:106` and `src/services/arcanos-productivity.ts:173`; the module router, GPT map, and introspection all exclude protected modules in `src/routes/modules.ts:174`, `src/platform/runtime/gptRouterConfig.ts:101`, and `src/routes/introspection.ts:109`. |
| Local-agent jobs could be observed or controlled through generic public job routes | Remediated | Status, result, cancellation, and stream routes return local-agent jobs exactly like missing jobs in `src/routes/jobs.ts:38`. Tenant-bound access remains under GPT Access. |
| `tests.run` did not have the same strict one-time confirmation semantics as `patch.apply` | Remediated | Both actions require a consumed challenge bound to actor, principal, workspace, exact action, and exact payload in `src/routes/gpt-access.ts:111` and `src/routes/gpt-access.ts:469`. |
| Local-agent executor authority could overlap the broader ActionPlan executor realm | Remediated | The executor has role `local-agent-executor`, audience `local-agent-protocol`, and four narrow protocol scopes in `src/services/actionPlanExecution/auth.ts:31`. Credential collisions with GPT Access and ActionPlan roles fail closed. |
| Generic workers or recovery paths could claim local-agent jobs | Remediated | Generic claim, stale recovery, cleanup, and failed-job requeue paths explicitly exclude `job_type = 'local-agent'` in `src/core/db/repositories/jobRepository.ts:1339`, `:1612`, `:1834`, and `:2531`. |
| Advisory locking was the only local-agent idempotency correctness boundary | Remediated | `local_agent_job_idempotency` adds tenant/device/action/key and job uniqueness in `migrations/20260724_local_agent_job_hardening_v1/01_local_agent_job_idempotency.sql:104`; repository creation binds the logical job inside the existing transaction in `src/core/db/repositories/localAgentJobRepository.ts:419`. |
| Per-job expiry observability could collapse into aggregate batch behavior | Remediated | Expiry/reconciliation operates per job with transactional event persistence and savepoint isolation in `src/core/db/repositories/localAgentJobRepository.ts:784`. |
| Git metadata indirection or executable local Git configuration could escape a registered root | Remediated with a documented compatibility condition | `daemon-python/arcanos/local_agent/secure_fs.py:71` requires a standalone worktree, contained Git/common/object directories, safe local configuration, and link-free metadata before every Git or patch operation. Linked worktrees and submodule roots using `.git` files now fail closed. |
| Productivity replay/no-op wording could claim a new mutation and future review writes were under-constrained | Remediated | `src/services/productivity/productivityService.ts` now distinguishes replay/no-op effects and rejects explicitly future `reviewDate` writes; focused service tests cover both. |

## Round 2 findings

### ARCH-R2-001 — Exact PR head lacks recorded full preview E2E evidence

- Severity: High
- Confidence: high
- Status: open
- Merge impact: blocks Ready for Review under the requested acceptance gates

The retained preview report identifies
`b2821e8053610fd983c024d81b82e9b781a828f4` as the exact commit used for the
final complete runtime validation (`docs/PREVIEW_E2E_REPORT.md:13`). The PR
head is `87788342f862d59c60fa3ea830da47c39950dabf`.

The intervening head commit is not report-only. It changes authentication and
confirmation behavior, local-agent HTTP routing and rate limiting, generic job
visibility, database idempotency verification, expiry semantics, productivity
behavior, Python Git/path validation, journal retention, tests, and CI. The
report's allowance for a later report-only commit
(`docs/PREVIEW_E2E_REPORT.md:45`) therefore does not cover this head.

GitHub reports successful Railway API and worker deployment contexts attached
to `87788342`, and the public preview `/health` endpoint returned healthy
during this review. Those facts prove deployment/liveness, but they do not
replace the authenticated discovery, productivity, local-agent, idempotency,
timeline, offline/recovery, and exact-confirmation matrix required by the PR.

Required disposition:

1. Run the preview verifier and the applicable confirmation/sandbox scenarios
   against the exact reviewed head and the explicitly selected isolated
   preview resources.
2. Record the new API/worker deployment IDs, exact commit, migration
   verification, E2E results, and audit/trace evidence.
3. Update `docs/PREVIEW_E2E_REPORT.md` before changing the PR from Draft.
4. If any runtime code changes after that run, repeat the exact-head check.

### ARCH-R2-002 — Canonical implementation/security docs describe obsolete deployment state

- Severity: Medium
- Confidence: high
- Status: open
- Merge impact: architecture-preserving documentation correction

The historical preview report says the isolated preview, migrations, Linux
sandbox checks, Windows sandbox checks, and E2E matrix completed. In contrast:

- `docs/LOCAL_AGENT_CAPABILITY_BRIDGE.md:653` says no Railway deployment or
  migration has occurred.
- `docs/LOCAL_AGENT_CAPABILITY_BRIDGE.md:700` says the controls are not
  operationally proven.
- `docs/security/LOCAL_AGENT_CAPABILITY_BRIDGE_SECURITY_REVIEW.md:208`,
  `:255`, and `:288` still label the sandbox, migration, and Linux gate as
  pending.
- `docs/security/LOCAL_AGENT_CAPABILITY_BRIDGE_SECURITY_REVIEW.md:380` says no
  deployment or migration occurred.

The conservative wording is safer than falsely claiming success, but it leaves
the maintained guides internally inconsistent and makes the actual readiness
gate unclear. Update these sections after exact-head E2E so they distinguish:

- code-level remediation;
- the completed historical preview at `b2821e80`;
- the current exact-head validation result;
- remaining production operational requirements.

### ARCH-R2-003 — Standalone-worktree support is an intentional compatibility limit

- Severity: Medium residual risk / human acceptance condition
- Confidence: high
- Status: documented, not a merge-blocking defect by itself

The shared Git/patch core is reused by the outbound local agent, interactive
patch orchestration, and loopback CLI bridge. Its new fail-closed validation
rejects linked worktrees, submodule roots that use `.git` files, external
common/object directories, local includes, executable filters, nested
repositories, and gitlink changes.

This is the correct least-privilege choice for the initial capability bridge,
but it changes existing Python patch entry-point compatibility. The limitation
is disclosed in `docs/LOCAL_AGENT_CAPABILITY_BRIDGE.md:325` and the security
review. A human should explicitly accept that registered local-agent and
shared patch workflows support only a standalone main worktree. Restoring
linked-worktree support later would require a separately reviewed,
containment-preserving design.

### ARCH-R2-004 — `git apply` remains path-based during the final mutation

- Severity: Medium when a hostile local writer shares the workspace; Low for
  the required private daemon-owned fixture
- Confidence: high
- Status: accepted residual only under documented operating constraints

Pre/post validation, exact payload authorization, SHA-256 binding, reparse and
symlink denial, and manual reconciliation substantially reduce risk.
Nevertheless, an external `git apply` process cannot make every target write
descriptor-relative and atomic against a concurrent hostile local process.

Required operating conditions remain:

- use a private daemon-owned registered workspace;
- use a disposable fixture for preview mutation tests;
- do not share mutation roots with an untrusted local writer;
- treat interruption or identity drift as
  `LOCAL_EFFECT_OUTCOME_UNKNOWN`;
- require manual reconciliation rather than automatic replay.

This is a disclosed implementation boundary, not evidence of a parallel
architecture.

## Boundary review

### Public protocol and routing

- TypeScript remains the only public protocol authority.
- Capability input/output/risk/timeout/device/file metadata is defined in
  `src/services/localAgent/contracts.ts`.
- Generated TypeScript and Python catalogs are checked for exact parity.
- `ARCANOS:LOCAL_AGENT` publishes exactly seven fixed actions and no arbitrary
  command action.
- Protected capability execution stays under `/gpt-access/*`.
- Public GPT routing, legacy dynamic modules, `/queryroute`, and public
  introspection omit both protected modules.
- The private daemon protocol is mounted under
  `/gpt-access/local-agent/*`, uses its dedicated authentication middleware,
  and has independent pre- and post-authentication rate limits.
- `/gpt-access/openapi.json` exposes contract metadata, not credentials or a
  Python endpoint.

### Authority and confirmation

- Principal, workspace, device, root, authorization decision, and
  confirmation state are server-controlled.
- Capability payload schemas recursively reject tenancy or authority aliases.
- The daemon receives only an authorized assignment and does not implement a
  competing confirmation system.
- `tests.run` and `patch.apply` require a one-time challenge consumed for the
  exact identity, action, and payload.
- Natural-language dispatch cannot execute confirmation-required local-agent
  actions.

### Queue, persistence, and workflows

- The bridge reuses `job_data`, `job_events`, the existing PostgreSQL
  transaction helper, and existing audit/trace correlation.
- `local_agent_job_idempotency` is a uniqueness binding, not a second queue.
- The Python SQLite journal is bounded local recovery evidence, not canonical
  state.
- Local-agent jobs are excluded from generic worker ownership and recovery.
- Simple productivity mutations remain synchronous domain commands; the PR
  does not introduce a competing workflow engine.
- Productivity persistence stays behind the
  capability -> service -> repository -> PostgreSQL boundary.

### Python boundary

- Python initiates outbound heartbeat, claim, job-heartbeat, and result
  requests.
- It exposes no new listener and has no local-agent PostgreSQL client.
- The fixed handler registry reuses existing repository, Git, test, and patch
  implementations after security refactoring.
- Test execution uses fixed profiles. There is no model-supplied argv,
  environment, root, or generic shell action.
- Production-capable `tests.run` is container-sandboxed and fails closed when
  the immutable runtime is unavailable.

### Deployment architecture

- The preview report identifies isolated API, worker, PostgreSQL, Redis,
  credentials, device, and domain resources.
- The Phase 2E Redis validation service is explicitly excluded.
- Preview migrations use an exact target identity, checksum, advisory
  migration lock, transaction, schema verifier, and preview-only confirmation.
- GitHub Railway contexts currently show API and worker deployments for the
  reviewed head, but ARCH-R2-001 remains open until the full exact-head runtime
  matrix is recorded.

## Independent validation

Commands executed by this reviewer:

```text
npm run check:boundaries
npm run check:routing-boundaries
npm run sync:check
npm run validate:backend-cli:contract
npm run validate:backend-cli:offline
node scripts/run-jest.mjs --testPathPatterns=local-agent-module-contract --testPathPatterns=modules.productivity-legacy-isolation --testPathPatterns=gpt-router-config.gpt-access-only --testPathPatterns=gpt-access-openapi-capability-catalog --testPathPatterns=action-plan-execution-auth --testPathPatterns=jobs.route --testPathPatterns=local-agent-http-protocol --testPathPatterns=local-agent-service --testPathPatterns=productivity-module-contract --coverage=false --runInBand
python -m pytest daemon-python/tests/test_local_agent_handlers.py daemon-python/tests/test_local_agent_protocol_runner.py daemon-python/tests/test_local_agent_sandbox_security.py daemon-python/tests/test_cli_policy_security.py -q -rs
npm run test:preview-e2e
npm run db:local-agent-hardening:plan
npm run validate:railway
git diff --check 59989445b6bf206c0f73bc9fb11f6d47f3494214...87788342f862d59c60fa3ea830da47c39950dabf
gh pr checks 1408
```

Results:

- CEF and routing boundary checks: passed.
- TypeScript/Python protocol contract validators: passed.
- Cross-codebase synchronization: zero errors and zero warnings; five
  pre-existing informational recommendations.
- Focused TypeScript suites: 9 suites, 71 tests passed.
- Focused Python suites: 76 passed, 11 skipped on the local Windows host.
  The skips were Windows symlink-privilege or POSIX descriptor-specific cases;
  the head's required Linux sandbox CI job passed.
- Preview verifier unit tests: 18 passed.
- Migration artifact plan/checksum validation: passed.
- Railway compatibility validation: passed.
- Diff whitespace validation: passed.
- GitHub head checks observed as passed included lint/typecheck, build,
  integration, Linux sandbox, PostgreSQL concurrency, Windows Python,
  Railway compatibility, security audit, convergence, API endpoint tests,
  documentation audit, and both Railway deployment contexts. The root unit
  matrix was still running at the observation time and must finish
  successfully.
- Live public preview `/health`: healthy.
- Authenticated exact-head preview E2E: not executed by this reviewer because
  no preview bearer or Railway credential was present in this process.

## Residual conditions

1. Close ARCH-R2-001 with exact-head preview evidence.
2. Update the maintained bridge/security docs after that run.
3. Require all GitHub checks to complete successfully.
4. Human accepts standalone-main-worktree-only support.
5. Human accepts the documented private-workspace condition around
   path-based `git apply`.
6. Keep Python outbound-only, local-agent credentials purpose-bound, and
   production `tests.run` sandbox-only.

## Recommendation

`REQUEST_CHANGES`

There are no architectural redesign requests. The TypeScript/Python,
protocol, module, tenancy, confirmation, persistence, queue, and routing
boundaries are sound at `87788342`. Do not mark the PR Ready for Review until
ARCH-R2-001 is closed and the final documentation/CI state matches the exact
head. After those conditions are verified without new runtime changes, this
review can move to `APPROVE_WITH_CONDITIONS` for the two explicit local
workspace compatibility/residual-risk constraints.

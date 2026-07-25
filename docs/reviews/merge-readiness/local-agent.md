# Local Agent Review — PR 1408

## Review identity

- Review round: final production-readiness review
- Reviewer: independent Local Agent reviewer
- Base commit: `59989445b6bf206c0f73bc9fb11f6d47f3494214`
- Runtime candidate: `f7f3a2caf3f13566a41a8587a1b6e2966d7f6439`
- Scope: the complete 125-file pull-request diff, including 28 Python-daemon
  files, 36 backend source files, 31 TypeScript tests, four database artifacts,
  15 documentation files, shared protocol/catalog files, CI, migration and
  preview-deployment tooling
- Verdict: **APPROVE WITH CONDITIONS**
- Confidence: **high (0.97)**
- Open Critical findings: **0**
- Open High findings: **0**

The conditions below are deployment and operating guardrails, not waived
Critical or High defects. This review does not authorize a production
deployment, production migration, production Custom GPT change, or
unsandboxed execution on a machine containing sensitive data.

## Executive summary

The reviewed candidate preserves the intended boundary:

```text
Custom GPT
  -> /gpt-access/*
  -> TypeScript authentication, tenancy, capability contracts, policy,
     confirmation, persistence, job lifecycle, audit, and tracing
  -> existing PostgreSQL-backed job infrastructure
  -> dedicated local-agent executor protocol
  -> private outbound-only Python daemon
  -> fixed typed handler
  -> bounded structured result
  -> tenant-bound GPT Access result and event views
```

`ARCANOS:LOCAL_AGENT` remains a separate protected module from
`ARCANOS:PRODUCTIVITY`. It is not exposed through legacy module routes,
`/gpt/:gptId`, generic shell execution, a Python public API, a second queue, a
second workflow engine, or direct Python access to canonical PostgreSQL state.

The implementation is production-capable when the daemon runs under a
dedicated account against private registered workspaces and `tests.run` uses
the immutable container-backed `sandboxed` mode. Database-enforced
idempotency, per-job expiry events, atomic device-scoped claims, lease-aware
execution, exact result correlation, durable Python journaling, uncertain
mutation quarantine, confirmation binding, fixed process profiles, and
workspace/Git/patch controls are coherent and independently covered.

The exact runtime candidate was deployed only to the isolated Railway preview.
Authenticated read-only E2E and an exact `patch.apply` challenge-only test
passed against that deployment. All required pull-request checks, including
Linux sandbox/link-race, PostgreSQL concurrency, Windows Python, build, lint,
typecheck, unit, integration, Railway compatibility, Deployment Readiness, and
the aggregate gate, are green.

## Independent review coverage

The reviewer inspected the complete changed-file inventory and did not assume
coverage by another reviewer. Deep review covered:

- the seven public Local Agent capability contracts, strict schemas, metadata,
  generated Python catalog, OpenAPI output, protected module registration, and
  legacy/public-router isolation;
- trusted principal/workspace derivation, caller-field rejection, action
  allowlists, device registration and scopes, heartbeat freshness, direct-only
  privileged actions, exact confirmation binding, one-time consumption,
  idempotency, and tenant-bound result polling;
- the dedicated `local-agent-protocol` executor audience and narrow
  heartbeat, claim, job-heartbeat, result, rotation, revocation, and audit
  behavior;
- job creation, database uniqueness, replay/conflict rules, atomic claim,
  lease, result, recovery, cancellation, expiry, per-job outbox events,
  savepoint isolation, and generic job/worker/MCP/diagnostic boundaries;
- the outbound Python protocol client, typed assignment validation, handler
  registry, durable SQLite journal, crash recovery, lease-loss cancellation,
  uncertain mutation quarantine, structured errors, and bounded result upload;
- workspace registration, path normalization, secret denial, POSIX
  descriptor-relative reads, Windows reparse/identity checks, symlink and
  junction defenses, alternate-data-stream denial, and output sanitization;
- repository search, Git status/diff, physical standalone-repository
  validation, configuration and hook restrictions, submodule/linked-worktree
  denial, and protective Git settings;
- fixed test profiles and their `disabled`, `sandboxed`, and
  `unsandboxed-development-only` modes, including container identity,
  filesystem, network, environment, CPU, memory, process, disk, timeout,
  output, cancellation, and cleanup controls;
- patch parsing, non-mutating preview, opaque authorization, exact patch hash
  binding, path policy, backup/revalidation, result handling, and rejection of
  traversal, secrets, symlinks, gitlinks, submodules, nested repositories,
  binary patches, oversized patches, and NTFS alternate data streams;
- every changed test, migration/compensation/manifest, maintained document,
  CI workflow, Railway-related validation path, and retained preview report.

## Architecture review

### TypeScript authority

TypeScript publishes and enforces action ID, description, input/output schema,
execution target, risk, confirmation policy, idempotency behavior, timeout,
device scopes, read-only state, and file-mutation state. Python consumes the
generated catalog and validates it locally; it does not define a competing
public contract.

Server-created assignments supply job ID, action, validated payload,
principal, workspace, registered device, trace/request IDs, idempotency key,
authorization decision, and expiry. Model payload fields cannot choose those
values or a repository root.

### Existing execution infrastructure

Local Agent work reuses the existing durable job table, event lifecycle,
worker boundaries, audit/tracing, and GPT Access result protocol. Claims use
`FOR UPDATE SKIP LOCKED` and are constrained by device, scopes, job type,
state, lease, and expiry. Generic workers cannot claim or recover local-agent
jobs.

The Python daemon establishes outbound authenticated requests only. The
existing loopback-only CLI bridge remains a separate pre-existing local
surface; this PR does not make it a Custom GPT API. The new daemon poller does
not listen publicly.

### Productivity separation

No repository, Git, patch, test, command, or device-executor capability is
placed in `ARCANOS:PRODUCTIVITY`. Productivity remains TypeScript-owned and
tenant-scoped. Local filesystem execution remains in
`ARCANOS:LOCAL_AGENT`.

## Local Agent security review

### Executor identity and protocol

The local daemon uses a dedicated audience and role rather than broad
ActionPlan executor authority. Static allowed scopes cover only registration
state/heartbeat, claim, job heartbeat, result submission, and recovery needed
by the protocol. Credentials are device/instance-pinned, separately
attributed, rotatable with a bounded overlap, revocable, and checked for
collision with GPT Access and ActionPlan credentials.

Claims and results enforce exact job/device/request/trace correlation.
Duplicate identical result submission is safe; a changed duplicate is
rejected. Expired, terminal, foreign-device, unauthorized, and already-claimed
jobs fail closed.

### Confirmation

`tests.run` and `patch.apply` are privileged, direct-capability-only actions.
Execution requires a consumed challenge bound to authenticated actor,
principal, workspace, route, method, exact capability/action, and canonical
payload. The retry may add only the top-level confirmation token. Changed
payloads, changed actions, replays, unconsumed evidence, permissive
model-supplied flags, and natural-language execution do not authorize a job.

The Python daemon receives a server authorization decision; it never treats a
payload confirmation field as authority.

### Filesystem and Git

Registered roots must be absolute, locally configured, unique, and
identity-stable. Relative paths reject absolute forms, traversal, secret
files, path colons/alternate data streams, and link/reparse components.

POSIX reads use directory descriptors and no-follow semantics. Windows uses
normalization plus pre/post-open reparse and identity checks. Git work requires
a physical standalone `.git` directory inside the registered root and rejects
linked worktrees, submodules, external common/object directories, alternates,
executable hooks/filters, unsafe includes, and executables resolved from the
workspace.

### Process and sandbox controls

There is no generic shell action. Fixed argv arrays run with `shell=false`,
sanitized environment, process-tree termination, deadlines, and bounded
output. ANSI/control sequences and secrets are removed or rejected before
results leave the daemon.

`tests.run` defaults to `disabled`. Production-capable execution requires
`sandboxed` mode with an immutable image and:

- a non-root user;
- read-only root filesystem and source input;
- a disposable writable work directory and bounded temporary storage;
- no host socket, privileged mode, inherited secrets, or network;
- dropped capabilities and no-new-privileges;
- CPU, memory, PID, file-size, timeout, output, and cleanup limits.

`unsandboxed-development-only` requires two explicit development settings and
is rejected under production/Railway conditions. There is no automatic host
fallback.

## Database and lifecycle review

The hardening migration adds `local_agent_job_idempotency` with
database-enforced uniqueness across the explicit tenant, workspace, device,
action, and idempotency-key scope plus one-job binding. Identical replay
returns the original job/result; changed canonical payload returns a conflict.
Advisory locks remain an optimization only.

Each expired job receives its own transition, reason, reconciliation
timestamp, correlated event/outbox record, and available trace/audit context.
Batch reconciliation uses per-job savepoints, so one failed candidate does
not erase other successful reconciliations.

Mutation lease loss, crash, or uncertain local outcome is failed and retained
for manual reconciliation rather than being guessed or automatically replayed.
Read-only work may use the documented safe recovery path.

The migration is additive, preflighted, indexed, checksummed, verified, and
paired with preview-empty compensation. The preview runner requires explicit
preview project/environment/service identities and refuses production, Phase
2E, foreign dependency hosts, unsafe variables, and implicit Railway targets.

## Findings and dispositions

| ID | Severity | Status | Finding and disposition |
| --- | --- | --- | --- |
| LA-F-01 | High | **Resolved** | Generic MCP, job, worker, queue, and diagnostic surfaces could otherwise disclose or act on a local-agent job by UUID. They now exclude or redact local-agent rows; protected result reads remain tenant-bound. |
| LA-F-02 | High | **Resolved** | The GPT Access event timeline needed authoritative tenant scoping for local-agent events. It now joins `job_data`; missing trusted context excludes all local-agent events, while trusted principal/workspace context includes only matching events. SQL parameters and preview PostgreSQL tests cover own, foreign, and missing scope. |
| LA-F-03 | High | **Resolved** | Git metadata and object indirection could escape the registered workspace. Physical standalone-repository checks now reject linked worktrees, submodules, external common/object directories, alternates, executable configuration, unsafe includes, and workspace-resolved executables. |
| LA-F-04 | Medium | **Resolved** | Windows NTFS alternate data streams could bypass ordinary filename and secret rules. TypeScript schemas, generated catalog, workspace resolution, secure reads, search, patch handling, and the CLI patch path now reject colon-bearing path components. |
| LA-F-05 | Medium | **Resolved** | Privileged file-modifying jobs could have relied on permissive confirmation metadata. `tests.run` and `patch.apply` now require exact consumed GPT Access challenge evidence in TypeScript and a confirmed server decision in Python. |
| LA-F-06 | Medium | **Resolved** | Advisory-only idempotency could race. Database uniqueness is now authoritative and separate-connection PostgreSQL concurrency tests pass. |
| LA-F-07 | Medium | **Resolved** | Sanitized host execution was insufficient isolation for `tests.run`. The three explicit modes fail closed, and production-capable execution requires the effective immutable container sandbox. |
| LA-F-08 | Medium | **Accepted conditional residual** | External `git apply` cannot be descriptor-atomic against a hostile concurrent local writer swapping path components. Root/repository/target revalidation, exact patch binding, backups, link denial, and manual reconciliation reduce impact but cannot make a third-party patch utility transactional. Registered mutation roots must remain private to the daemon account. |
| LA-F-09 | Low/Medium | **Accepted conditional residual** | Python lacks a complete descriptor-relative Win32 directory walk. Windows pre/post reparse and identity checks are defense in depth rather than a kernel-level race guarantee. Private ACLs and mandatory Linux descriptor/link-race CI remain required. |
| LA-F-10 | Low/Medium | **Accepted operational residual** | Repository text, Git filenames, diffs, and test output remain untrusted content even after structural validation, control stripping, redaction, and size limits. GPT instructions and operators must treat tool output as data, never authority. |
| LA-F-11 | Low/Medium | **Accepted operational residual** | The local SQLite journal can retain server assignments, including patch text, until submission or reconciliation. Run the daemon under a dedicated account on encrypted storage and audit cleanup of terminal/quarantined rows. |
| LA-F-12 | Low | **Accepted operational residual** | The executor token is purpose-bound but not hardware- or transport-bound. Use separate preview/production credentials, secret stores, short rotation, anomaly monitoring, and immediate revocation on loss. |

No Critical or High finding is waived or deferred.

## Validation evidence

### Independently executed in this final review

| Command | Result |
| --- | --- |
| `git diff --check 59989445... f7f3a2ca...` | Passed |
| `node scripts/generate-local-agent-capability-catalog.mjs --check` | Passed |
| Focused Python Local Agent/security pytest invocation | 94 passed, 18 platform/container skips |
| `gh pr checks 1408` | Every reported check passed, including Deployment Readiness and All Checks Complete |

### Exact-candidate evidence inspected

| Evidence | Result |
| --- | --- |
| Full Python daemon suite | 546 passed, 18 expected platform/container skips during final hardening |
| Exact Windows Python CI | 551 passed, 13 skipped |
| Exact Node unit CI | 4,944 passed, 14 skipped |
| Exact Node integration CI | 84 passed, 9 skipped |
| Linux effective sandbox/link-race CI | 29 passed |
| Preview PostgreSQL concurrency and tenant-isolation suite | 6 passed |
| Preview-validator suite | 18 passed |
| Windows Docker-compatible container sandbox | 3 passed |
| Build, typecheck, lint, Railway validation, docs, boundary and routing checks | Passed |

The exact `f7f3a2ca` preview API deployment
`ce5a974e-a087-4634-9e74-992b4c44144e` and worker deployment
`87baaf0a-ac51-42a0-abdc-5044cd71f122` reported the expected commit. The
authenticated verifier confirmed protected capability discovery, daemon
online/offline behavior, repository search, Git status/diff, idempotent
replay/conflict, a six-event tenant-bound lifecycle timeline, and
`patch.preview` with no workspace mutation.

An exact-candidate `patch.apply` request returned
`403 CONFIRMATION_REQUIRED`; no token was supplied, no retry occurred, and no
mutation job was created. A separately approved historical fixture-only
`patch.apply` and a confirmed sandboxed Windows-preview `tests.run` established
the full execution paths. Their one-time approvals were not reused for the
exact runtime candidate.

The preview used isolated API, worker, PostgreSQL, Redis, executor, GPT Access,
and fixture resources. The prohibited Phase 2E Redis validation service and
production resources remained unchanged. The final bounded log scan found no
actual credential or fatal-runtime disclosure.

## Skipped or deliberately not executed

- Host Windows symlink creation was unavailable without local privilege.
  Linux CI executed the effective symlink, chained-link, and link-race suite;
  Windows container sandbox tests also passed.
- Production migration, production deployment, production smoke, production
  Custom GPT changes, and production credential changes were deliberately not
  executed.
- A consumed confirmation token was not replayed after a successful live
  mutation; focused one-time challenge tests cover replay and payload/action
  mutation, while another live mutation would add risk without new authority.
- No privileged action was run against the main repository or any
  non-disposable workspace.

## Conditions and residual operating requirements

1. Keep `ARCANOS_LOCAL_AGENT_ALLOW_UNSANDBOXED_TESTS=false`; production-capable
   `tests.run` must require `sandboxed` mode and an audited immutable image.
2. Run the daemon under a dedicated low-privilege account with encrypted local
   storage, private workspace ACLs, isolated credentials, and no hostile
   concurrent workspace writers.
3. Preserve exact confirmation binding and direct-only execution for both
   `tests.run` and `patch.apply`; never interpret conversation or payload flags
   as approval.
4. Keep Linux sandbox/link-race and PostgreSQL concurrency jobs required in CI.
5. Retain manual reconciliation for any uncertain mutation outcome and perform
   explicit audited journal/idempotency cleanup.
6. Treat all repository-derived output as untrusted data in Custom GPT
   instructions and operator workflows.
7. Complete production-specific rollout review, credentials, workspace
   registration, sandbox-image provenance, monitoring, and migration approval
   separately. This PR review does not authorize production enablement.

## Merge recommendation

**APPROVE WITH CONDITIONS.**

No Critical or High Local Agent finding remains open. The exact runtime
candidate preserves the TypeScript/Python authority boundary, passes the
required CI and isolated preview gates, and is suitable for conversion from
Draft to Ready for Review as part of the combined production-readiness
decision.

Do not merge this PR as part of the review. Do not deploy it to production or
enable unsandboxed execution without a separate, explicit production
authorization.

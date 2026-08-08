# Repository health-audit progress

Status: current non-GPT-OSS dashboard through merged PR
[#1423](https://github.com/pbjustin/Arcanos/pull/1423), plus protected-digest
tooling draft PR [#1424](https://github.com/pbjustin/Arcanos/pull/1424)

Original audit capture: 2026-07-28

Last reconciled: 2026-08-08 UTC

This report is advisory evidence. Current tracked source, tests, required CI,
maintained documentation, and freshly read provider state supersede every
statement here. Nothing in this report authorizes a deployment, database or
provider operation, configuration change, GitHub setting change, or live-memory
action. GPT-OSS is explicitly excluded from the active queue.

## Report map

- This file is the compact current dashboard and implementation order.
- [findings.md](findings.md) is the normalized open/closed finding register
  through PR #1423 plus the current protected-digest draft.
- [evidence.md](evidence.md) is the PR and validation ledger through PR #1423,
  with separately bounded draft-candidate evidence.
- [history-through-2026-07-31.md](history-through-2026-07-31.md) preserves the
  former long-form tracked narrative and its dated anchors.

The reorganization intentionally separates current state from chronology.
Future updates should change the tables below and add one compact evidence
dossier; they should not append another full chronological audit.

## Current reconciled snapshot

| Area | Current state |
| --- | --- |
| Remote `main` at reconciliation | PR #1423 merge `6a3ef8763e3d97ef10e5345d3061268527d87373`; tree `55fe0200366bf7a06ad9f752b05e6c9e65b54093` |
| PR #1423 source identity | Base `7bc83f469e571cd19626dbd2fa9360a8596b38e7`; reviewed head `58754e5632bd4bea4640ba83fc79b3a5f9a551e2`; the reviewed head and merge commit are tree-identical |
| Latest closed product slice | Backend `REQUEST_TIMEOUT` truthfulness: removed the parsed-but-unused Node/backend `config.limits.requestTimeout` and its millisecond-valued backend claims without inventing a server property or response-only race; preserved the Python daemon's distinct live seconds-valued timeout controls |
| Current draft candidate | Protected-digest tooling draft [#1424](https://github.com/pbjustin/Arcanos/pull/1424) on branch `codex/repository-health-progress-1423`, rooted at #1423 merge `6a3ef8763e3d97ef10e5345d3061268527d87373`; published implementation commit `51b7bfb117f6a6632f3244628c6b950f71a20559` adds canonical generation/comparison, exact runtime-candidate adapters, and the six-runtime-pin startup gate |
| Required PR-head evidence | CI/CD run `31240522180` passed all 13 jobs and the fail-closed aggregate; API, Documentation Audit, PR CI, Codecov, Copilot review, approval-policy, and both exact-head Railway preview contexts passed. The contained native preview passed 68/68 application checks at the exact reviewed head |
| Exact-merge evidence | CI/CD run `31245091797` passed all 13 jobs and verified all 11 aggregate dependencies; Documentation Audit passed 311/311 with current indexes; repository-registration workflow passed although its non-critical backend registration request returned HTTP 400; the known auxiliary documentation-analysis fixture failed again. Railway Auto Deploy run `31245615516` enforced the coordinated-writer hold and skipped production, while repository integration separately started 18 deployments across nine environments marked non-production, ending with six successes and 12 failures |
| Production credit | Production was last reconciled on 2026-08-02 at the PR #1415 generation. A 2026-08-08 Railway CLI readback found the same web deployment at commit `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8` and its paired worker deployment healthy; no production rollout is credited for PRs #1416–#1423 |
| Promotion control | Exact-merge rollout run `31245615516` enforced coordinated-writer hold `20260727-dag-snapshot-generation-v1` and skipped production job `93073631689`. The hold does not govern every Railway repository-connected environment; a green merge or preview does not imply production promotion |
| Current implementation slice | Review draft PR #1424; exact-head CI, review disposition, and merge remain required before source closure |
| Next untouched implementation slice | Successful non-GPT terminal retention |
| Explicit exclusion | GPT-OSS remains outside this queue and is not made ready by any result in this report |

## Protected-digest tooling draft PR #1424

The current working tree implements one versioned semantic-digest owner shared
by runtime integrity checks and operator tooling. The command covers all seven
manifest entries, distinguishes the six runtime-owned pins from the generic
manual-only entry, derives runtime-selected sources rather than accepting a
substitute during complete checks, and fails closed on malformed pins,
candidate data, environment overrides, source changes, and mismatches. Explicit
source-workspace commands build before evaluating compiled code; identified
already-built runtime images use the direct compiled command.

Normal tracked Railway web and worker startup now runs the digest comparison
after mounted volumes are available and before the role launcher. The automatic
gate skips only when none of the six runtime-owned pins is configured. The exact sealed native-PR preview
launcher remains direct and unchanged. Automatic reports omit candidate and
expected digest values, and signal handling prevents an interrupted comparison
from racing into service startup.

Local Node 20.19.0 evidence includes successful build, type-check, lint with no
errors, 82/82 focused protected-digest/startup/Railway/GPT/runtime tests, Railway
configuration validation, native-preview import-boundary validation, generated-
index verification, and direct compiled generation/pre-cutover smoke checks.
The broad non-GPT sweep passed 7,600 tests and reported two load-sensitive
Windows process-timing failures; both affected suites then passed 28/28 in an
isolated rerun. The only failure in the unfiltered root suite was an unchanged,
explicitly excluded GPT-OSS CRLF fixture. None of those unrelated failures is
treated as protected-digest evidence or repaired in this slice.

This is published draft evidence at implementation commit
`51b7bfb117f6a6632f3244628c6b950f71a20559`. It establishes a GitHub branch
and draft PR identity, not a reviewed exact head, terminal CI result, preview,
merge, deployment, provider change, database action, or production credit.

## PR #1423 closure

PR #1423 merged on `2026-08-08T06:57:44Z` as
`6a3ef8763e3d97ef10e5345d3061268527d87373`. Its exact base is
`7bc83f469e571cd19626dbd2fa9360a8596b38e7`, its reviewed head is
`58754e5632bd4bea4640ba83fc79b3a5f9a551e2`, and both head and merge resolve to
tree `55fe0200366bf7a06ad9f752b05e6c9e65b54093`. It contains two commits, nine
changed files, and +80/-8 lines.

The merged slice removes the unused Node/backend
`config.limits.requestTimeout`, the backend `REQUEST_TIMEOUT=30000` example,
and the corresponding millisecond-valued backend documentation claim. It does
not add an HTTP-server timeout property, a response-only `Promise.race`, or any
other substitute that could falsely imply cooperative cancellation of admitted
work. The Python daemon remains separate: `BACKEND_REQUEST_TIMEOUT=15` and
`REQUEST_TIMEOUT=30` are seconds-valued controls with maintained consumers, and
the documentation names their bounded scope rather than implying universal
coverage.

Focused local validation passed the two-test Node/documentation contract, all
six daemon OpenAI-adapter tests including exact timeout propagation, the
311/311 documentation audit with current generated indexes, and
`git diff --check`. Independent Node/runtime, daemon-contract, tests/CI, and
generated-artifact reviews found no merge blocker. The optional test-hardening
recommendation and daemon-consumer wording correction were implemented; the
final Copilot review produced no inline comments, and no review thread remained.

At the exact reviewed head, CI/CD run `31240522180` passed all 13 jobs,
including Security Audit, PostgreSQL, Node, Python, Redis, Railway compatibility,
deployment readiness, and `All Checks Complete`. API Endpoint Tests run
`31240522159`, Documentation Audit run `31240522158`, and PR CI run
`31240522167` passed, as did Codecov, approval-policy, Copilot, and both Railway
preview contexts. The bounded native runner passed 68/68 requests against
environment `b9067c39-49b8-49f6-bffe-148e5b2de058`, with exact served-head
identity and stable web/worker readiness. That preview is sealed component
evidence, not proof of a Node request deadline, normal provider/database work,
or production rollout.

At the exact merge, CI/CD run `31245091797` passed all 13 jobs and
`All Checks Complete` verified all 11 required results. Documentation Audit run
`31245091796` passed 311/311 with current generated indexes. Repository-
registration run `31245091806` was workflow-green although its non-critical
backend registration request returned HTTP 400. Auxiliary documentation-
analysis run `31245091805` failed for the already recorded missing
`ARCANOS_JOB_READ_CAPABILITY_SECRET` startup fixture. Railway Auto Deploy run
`31245615516` enforced hold `20260727-dag-snapshot-generation-v1` and skipped
production job `93073631689`.

Railway repository integration separately started 18 web/worker deployments
across nine environments marked non-production and distinct from the #1423
preview environment; six succeeded and 12 failed. Commit-status history
does not prove current lifecycle state or cleanup. No production deployment,
database operation, provider/model call, live-memory mutation, or provider-
configuration change is credited to #1423.

## Active implementation queue

This order supersedes every older queue in the historical narrative.

| Order | Priority | Slice | Completion contract |
| --- | --- | --- | --- |
| 1 | Older ranked | Protected-digest tooling | Draft PR #1424 publishes the canonical generator/validator and automatic pre-cutover comparison for all six runtime-owned pins; exact-head review/CI and merge remain open |
| 2 | Older ranked | Successful non-GPT terminal retention | Re-integrate the previously isolated candidate on current `main` and revalidate the five required database suites |
| 3 | Older ranked | Predictive/reactive self-heal approval | Re-integrate the explicit-approval candidate on current `main`; preserve policy ownership and prove no predictive path performs an unapproved reactive effect |
| 4 | Older ranked | Hard versus advisory worker budgets | Ratify the product semantics, implement them at the authoritative ownership seam, and align readiness/diagnostic claims |
| 5 | P2/P3 | Localized security, observability, Redis, architecture, scale, warning, and cleanup slices | Preserve the residuals enumerated in [findings.md](findings.md): dispatch quota ordering, broader pre-admission parsing, generic-model and GPT-log cardinality, rate-policy epoch, corrupt-counter integrity, real-Redis capability proof, public-health minimization, and raw-path pre-decode bounds; then continue shadow MCP registry, ActionPlan transport duplication, measured stale-recovery/worker-discovery/index planning, GPT Access contract extraction, provider-option/Trinity limits, and behavior-preserving warning or excluded-test cleanup |

Do not combine these into a broad refactor. Each slice needs its own red
characterization, smallest safe implementation, focused regression evidence,
and current-source review.

## Bounded follow-ups

| Follow-up | Deadline or trigger | Current disposition |
| --- | --- | --- |
| Repair the auxiliary Analyze Documentation Updates startup fixture by supplying its required sealed `ARCANOS_JOB_READ_CAPABILITY_SECRET` test value | Next workflow-maintenance slice | Still open. Exact-merge run `31245091805` for #1423 repeated the known fixture-only failure; maintained Documentation Audit run `31245091796` passed |
| Re-review and remove the temporary npm-audit platform-profile exception rather than extending it silently | 2026-08-10 | Still open and time-bounded. PR #1422 patched Hono to `4.12.34` and removed the obsolete Hono and `@hono/node-server` exceptions; the remaining exact platform profiles still require their scheduled re-review |
| Reverify preview teardown and other provider lifecycle state | Before claiming cleanup | The #1422 preview was previously read back as deleted. A read-only 2026-08-08 Railway project inventory listed 18 current environments and did not contain #1423 preview `b9067c39-49b8-49f6-bffe-148e5b2de058`, so that environment's absence is attested; this does not prove deletion of every historical deployment or artifact. Its merge status history separately records 18 attempts across nine non-production environments, with six successes and 12 failures |
| Reverify production topology, edge policy, logs, retained-job inventory, and drain readiness | Before any future production promotion | A bounded 2026-08-08 readback confirmed the current web and worker ready at the 2026-08-02 baseline, but it did not re-attest the full topology, logs, retained-job inventory, drain behavior, or readiness for a future promotion |

## Production and rollout state

The last authorized production reconciliation was performed on 2026-08-02 at
the PR #1415 generation (`8bb0b80350d39a663c5dde0eefd81abfe27e4bf8`).
That operation applied and verified the job-claim, DAG-snapshot, and worker
statistics database contracts, restored the original database access policy,
rotated a credential exposed in private tool output, and ended with healthy web
and worker deployments. The provider backup existed, but restorability was not
tested.

A read-only Railway CLI reconciliation on 2026-08-08 confirmed production
environment `fb583147-6c39-4343-9267-500f357d25ab` still serving web deployment
`147279ab-faa7-45a6-8c70-404ed2a1a9c9` at that exact August 2 commit, with
worker deployment `bdf7cbb8-e5ab-460b-a424-a0204fe6fb23` active. Web readiness
reported healthy OpenAI, database, Redis, public-provider-admission, and startup
checks; worker readiness reported ready bootstrap/database and configured
provider. Both endpoints returned HTTP 200. This is current health and
  provenance evidence for the older baseline, not #1423 rollout evidence.

PRs #1416 through #1423 changed merged source after the August 2 reconciliation.
Their CI, review, and credential-empty preview results are not production
evidence. The #1422 and #1423 merges each triggered 18 Railway repository-
integration web/worker deployments across nine environment IDs distinct from
production and their respective preview environments; each ended with six
successes and 12 non-success (failed/stopped) outcomes. This is external
provider activity outside those known targets, not production credit, and it
shows that the workflow-owned hold does not suppress every repository-connected
deployment.
Before any later rollout, freshly reverify exact deployment provenance,
database schema and writer compatibility, integrity pins, retained jobs,
dedicated and API-hosted consumers, old-replica restart prevention, drain
behavior, provider configuration, and the coordinated-writer hold.

## Current repository-health verdict

| Dimension | Verdict |
| --- | --- |
| Architecture | Substantially improved. Executable dependency boundaries and cycle gates exist; remaining debt is localized to named coordination and transport seams rather than repository-wide spaghetti |
| Correctness | Stronger database/job/DAG/Backstage/Research contracts and fail-closed required PostgreSQL/aggregate CI truth are merged. Protected-digest tooling is published only as draft PR #1424; successful non-GPT retention, self-heal approval, and worker-budget semantics remain explicit work |
| Security | The scoped ingress, disclosure, admission, Backstage, Research, exact MCP body-cap, Hono-remediation, and backend-timeout truthfulness findings addressed by PRs #1409–#1423 are closed in merged source. Protected-digest generation and the six-runtime-pin startup gate are published in draft PR #1424 but not source-closed; broader dispatch/pre-admission parser, log/metric, Redis-integrity, and public-health residuals remain open in the finding register |
| Scalability | Public provider admission, bounded DAG/Backstage/Research persistence, stale-recovery batching, and Research aggregate cancellation are present. Replica-policy assumptions, successful non-GPT retention, and hard/advisory worker budgets still need explicit contracts and measured evidence |
| Maintainability | Ownership and documentation improved materially. Large coordinators, duplicate transport contracts, warnings, and stale/manual tests remain isolated cleanup candidates |
| Delivery and operations | Required CI and contained previews provide strong merge evidence. Production trails merged source, the writer hold governs the workflow-owned production job rather than all repository integrations, stale non-production fan-out needs lifecycle cleanup, and the auxiliary documentation-analysis workflow still has a known startup-fixture failure |

## Delivered program summary

PRs #1408–#1423 delivered the capability foundation and the repository-health
remediation program in reviewable stages. The durable merge ledger and exact
evidence through PR #1423 live in [evidence.md](evidence.md). In broad terms,
the program:

- introduced protected productivity and local-agent capabilities with a
  TypeScript-owned protocol boundary and a private outbound Python daemon;
- removed dependency cycles and established executable layer/cycle gates;
- hardened authentication, credential isolation, pre-parser ingress,
  confirmation, disclosure, filesystem/process containment, and public error
  shaping;
- normalized OpenAI, queue, cancellation, runtime-admission, and terminal-state
  semantics;
- added job-claim and DAG-snapshot generation fencing, serialized cancellation,
  bounded retention, and PostgreSQL concurrency evidence;
- hardened release provenance, dependency policy, documentation checking,
  Railway preview containment, and production-promotion gates;
- contained memory, worker diagnostics, generic-job reads/cache behavior,
  dispatch/provider admission, and GPT metric identities;
- bounded worker accounting, stale recovery, Backstage mutation/roster/storyline
  lifecycles, Research inputs/storage and aggregate execution, and effective MCP
  pre-parser admission; and
- made required PostgreSQL commands and the aggregate CI gate fail closed,
  patched the transitive Hono runtime, retired its obsolete audit exceptions,
  and removed an inert Node/backend timeout setting while preserving the
  Python daemon's distinct live seconds-valued controls.

## Update discipline

Within this audit bundle, each future slice should update only:

1. the source identity and latest closed slice in **Current reconciled
   snapshot**;
2. the ranked **Active implementation queue**;
3. the affected row in [findings.md](findings.md);
4. one compact dossier in [evidence.md](evidence.md) containing base, reviewed
   head, merge, tree, final validation, review disposition, preview or production
   proof, limitations, and external mutations; and
5. the production row only after exact deployed-revision attestation.

Do not duplicate full command logs, intermediate green reruns, commit-by-commit
narratives, worktree inventories, or repeated authorization disclaimers.

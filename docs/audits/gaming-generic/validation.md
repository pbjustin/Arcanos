# Gaming generic-engine validation and release evidence

This record supports [issue #1532](https://github.com/pbjustin/Arcanos/issues/1532). It separates observed baseline evidence, local preparation, candidate checks, and unavailable release evidence. Local/CI tests and draft PRs are authorized. Merge, production deployment, production configuration, active production probes, paid provider calls, and incident-workflow replay are not authorized.

## Baseline and production metadata

Initial repository HEAD and remote main were `200463b3aac65eb494f71d842c1e2b0378530bfb`. [The baseline audit](2026-10-10-baseline.md) records the merged repair and six production source failures.

A fresh read-only Railway metadata observation during this task independently matched the production pair from [deployment run 38017893814](https://github.com/pbjustin/Arcanos/actions/runs/38017893814) and [job 114112194665](https://github.com/pbjustin/Arcanos/actions/runs/38017893814/job/114112194665):

| Role | Exact service | Active deployment | Observed status |
| --- | --- | --- | --- |
| Web | `c4ade025-3f13-4fca-9309-5d0dd81396fe` | `bffea2cd-58fb-44a7-9eb0-9bd6b32aa0ac` | `SUCCESS`, created `2026-10-10T02:45:54.582Z` |
| Worker | `1765befb-b805-4051-9af9-28634e986886` | `e3c6e158-1459-459a-8b0e-df59404d936c` | `SUCCESS`, created `2026-10-10T02:42:08.955Z` |

The explicit project was `7faf44e5-519c-4e73-8d7a-da9f389e6187`; production environment was `fb583147-6c39-4343-9267-500f357d25ab`. Deployment lists and environment health metadata were read without variables, credentials, production application requests, or production logs. GitHub deployment-job logs were processed into bounded timestamps, deployment IDs, SHA matches, and status fields; raw logs are not retained in this audit. Their exact checkout and enqueue/success chain corroborates the initial SHA. Railway native `meta` contains only `reason=deploy`, so independent immutable uploaded-tree-to-SHA attestation remains unavailable. Historical authorization in that run does not apply to this task.

## Toolchain and test isolation

The initial system Node `24.19.0` and npm `11.9.0` did not match the repository pins. Local canonical checks use Node `24.18.1` and npm `11.16.0` from `/workspace/task-tools/node-v24.18.1-linux-x64/bin`; each execution must record its actual versions. No runtime or package pin was changed.

Root Jest runs through `scripts/run-jest.mjs`, which imports `scripts/test-env.mjs`. The wrapper removes production database/Redis/Railway variables, disables external calls and active workers, and supplies synthetic test defaults. Individual integration suites are still inspected because this wrapper is not a guarantee that every test is offline. Focused tests use explicit `--runTestsByPath`; direct Jest consumers require current shared-package builds. Normal application startup, worker startup, `db:init`, production smoke, and general live E2E scripts are not substitutes for these checks.

## Disposable PostgreSQL 18

The managed Docker daemon was checked through its local Unix socket with inherited endpoint/context/TLS selectors removed for that command. Docker version was `28.4.0`. The container is task-owned, uses synthetic local credentials, exposes only a loopback port, and keeps PostgreSQL data in tmpfs. It has no production network or database target.

| Item | Observed exact preparation |
| --- | --- |
| Image | `postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` |
| Container | `arcanos-gaming-generic-pg18-1532`, ID `f805a0e8790ced2944abd477a0d452186c3b00c828aa7f54cd9ec7d7eb6c6507`, `--rm`; ownership `arcanos.task=gaming-generic-1532`, `arcanos.owner=safety-validation-audit` |
| Storage | tmpfs at `/var/lib/postgresql`; no named volume or host data bind |
| Listener | `127.0.0.1:55433` only |
| Database | `arcanos_audit_pg18_20260727` |
| Required sentinel | `ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1` |
| Connection scope | Dedicated `*_TEST_DATABASE_URL` variables only; never `DATABASE_URL` |
| Initial preparation result | Container healthy; SQL over container-local socket and host loopback both report exact disposable database and `server_version_num=180006` (PostgreSQL 18.6). Execution and final cleanup results are recorded below. |

The database guard in `tests/integration/postgresTestDatabase.ts` requires a loopback host, explicit port, exact disposable database name, credentials, no query/fragment, and PostgreSQL 18. Missing URLs fail under the required sentinel. Gaming's durable suite reads `JOB_CLAIM_FENCING_TEST_DATABASE_URL`. Its repository transactions, JSONB, ranking, and revision behavior execute in PostgreSQL; acquisition/provider seams are mocked. Each suite owns and drops its random test schema.

The task-local wrapper `/workspace/task-tools/gaming-generic-validation/run-pg18.sh` sets the pinned toolchain, required sentinel, and all eleven dedicated URLs to the synthetic disposable target. Reproduction commands are:

```sh
bash /workspace/task-tools/gaming-generic-validation/run-pg18.sh \
  node scripts/run-jest.mjs --runTestsByPath \
  tests/integration/gaming-durable-rag.pg18.integration.test.ts \
  --coverage=false --runInBand

bash /workspace/task-tools/gaming-generic-validation/run-pg18.sh \
  npm run test:local-agent-postgres

bash /workspace/task-tools/gaming-generic-validation/run-pg18.sh \
  npm run test:postgres-fencing
```

Both package commands are needed for the sixteen guarded PostgreSQL suite set; `test:postgres-fencing` alone is not the full PostgreSQL CI job. Completion evidence must include passed/failed/skipped test and suite counts, server version, exact tested commit/tree, and cleanup/absence. A skipped SQL suite is not SQL evidence. The separate Swift/device E2E in the PostgreSQL CI job remains independently required by the full CI aggregate.

Preparation does not constitute candidate test evidence. The initial required SQL checks below were explicitly authorized against the uncommitted integration tree; their results are not immutable-head evidence.

## Required candidate checks and exact-head CI

Required local evidence includes focused Gaming regressions and benchmark tests; `npm run type-check`; `npm run lint`; `npm run build`; full `npm test` and relevant integration checks; `npm run validate:railway`; existing offline preview/import safety suites; disposable PostgreSQL; and maintained documentation checks. Structural source changes also require generated-index review. Security controls remain enabled: commit guardrails, complete-range redacted secret scanning, production npm-audit policy, license policy, Python dependency audit, and existing prompt-injection/authentication/source-access tests.

The authoritative workflow is `.github/workflows/ci-cd.yml`, named `CI/CD Pipeline`. A same-repository draft PR receives pull-request CI, whose default checkout is the PR merge ref. Such a run must retain its tested checkout SHA and head/base binding; it must not be relabeled as a direct head checkout. For direct immutable-head evidence, the existing manually dispatched workflow can run against the pushed candidate branch:

```sh
gh workflow run ci-cd.yml --repo pbjustin/Arcanos --ref <candidate-branch>
```

Before dispatch and after completion, independently resolve the remote candidate branch and PR head to the intended full SHA. Select the resulting workflow run by exact `head_sha`, repository, workflow path, event, and creation window; inspect its own immutable checkout evidence. Require terminal success of every required dependency and `All Checks Complete`. The aggregate verifier rejects missing, extra, failed, cancelled, or skipped dependency results. Its eleven direct dependency IDs include the matrix test group, security, PostgreSQL, runtime Redis admission, Python Windows, convergence, Railway compatibility, and deployment readiness. Pull-request receipts are bounded supplemental SHA bindings; a receipt emitted before aggregate completion does not itself establish workflow success.

A candidate-branch CI dispatch does not target production. The separate production workflow accepts only its protected default-branch paths and still enforces `20260830-job-events-worker-budget-v1`. Do not dispatch production workflows, alter the hold, change release gates, merge a candidate, or retarget services for this task.

## Sealed Railway preview limitation

The existing trusted lifecycle requires an open, same-repository PR targeting `main`, exact `railway-preview` opt-in label, and `draft=false` in `scripts/railway-pr-preview-lifecycle.mjs` (`decideLifecycleAction`). The user requires stopping at draft PRs. Therefore a hosted lifecycle preview cannot be created through the supported path while honoring the requested state. Do not convert the PR to ready, weaken lifecycle admission, invent a second lifecycle, or deploy manually to avoid this condition.

Existing offline preview contracts and source/compiled import gates can still run. Report hosted exact-head sealed Railway verification as **not run: draft admission unsupported** unless an already-authorized eligible exact-head target exists. An older preview is not evidence for the candidate. Sealed fixture success demonstrates bounded component behavior with synthetic data and passive workers; it does not establish live publisher acquisition, real provider/Trinity generation, active workers, or SQL atomicity.

## Candidate result ledger

Initial precommit results are preserved below; subsequent immutable PostgreSQL checks establish the published P0 head separately. Local PostgreSQL execution used Node `24.18.1`, npm `11.16.0`, PostgreSQL `18.6`, and required sentinel `1`. A separate safe runtime check after loading `scripts/test-env.mjs` verified all eleven dedicated bindings target the owned disposable database and production `DATABASE_URL` is empty.

| Initial integration-tree check | Actual result |
| --- | --- |
| `test:local-agent-postgres` | **PASS**: 1 suite, 6 tests; 0 failures, skips, or TODOs. |
| `test:postgres-fencing` | **FAIL**: 14 passed / 1 failed suites; 201 passed / 1 failed tests; 0 skips or TODOs. |
| Gaming durable SQL subset | 8 passed / 1 failed tests. The short structured acquired-source fixture at `tests/integration/gaming-durable-rag.pg18.integration.test.ts:178` expected `accept`/`qualityEligible=true`, received `clarify`/`false`; claim-support gate remained verified. This is a confirmed candidate regression, not a production SQL root-cause finding. |
| Initial combined required SQL set | 16 evaluated suites / 208 evaluated tests: 207 passed, 1 failed, 0 skipped. The affected regression was subsequently corrected and revalidated below. |
| Focused Gaming SQL revalidation after short-table correction | **FAIL**: 8 passed / 1 failed tests, 0 skips; same source-acceptance assertion. The 111-file fingerprint set was unchanged throughout this rerun, aggregate `17f51a4e4b132833561db52fe760f96e0cb05175b58e2797d904810be9863b99`; HEAD still included uncommitted integration edits. The current identity validator requires independent acquired context beyond a primary h1 repeated into a record. The fixture lacks that second anchor; its intended security classification must be resolved without permitting metadata self-corroboration. |
| Focused Gaming SQL revalidation after sparse exact-game-heading correction | **PASS**: 1 suite / 9 tests, 0 failures, skips, or TODOs. The existing SQL fixture was preserved. A parser-owned exact bare-game heading can scope an intact relevant tuple; a generic guide h1 or prose body still cannot self-corroborate. The 111-file fingerprint set was unchanged throughout execution, aggregate `1228b1e43ab1f5b1b05d82fc905e1836ded1b3817fe60f8c5a9c3ef590d349dc`. This resolves the observed candidate regression on the uncommitted integration tree; it is not an immutable-head full SQL rerun. |
| Working-tree binding | HEAD remained baseline `200463b3aac65eb494f71d842c1e2b0378530bfb` plus uncommitted candidate edits. A 111-file Gaming/SQL fingerprint aggregate changed from `2285c76527c9a906be8424fb548f26378a63382fc7822cf61ad69f1ae6d02719` before execution to `6bbf1f623033ffec799389c4d3692433b1d9829cfc01beeb1aa11860d0877826` afterward. `gamingGameRegistry.ts` and `gamingStructuralEvidence.ts` changed during integration. The run therefore does not attest a fixed candidate tree. |
| Local result artifacts | Bounded Jest JSON and file hashes reside outside the repository under `/workspace/task-tools/gaming-generic-validation/`; raw test console logs are not included in this audit. |
| Cleanup | Initially retained for authorized follow-up tests; final scoped removal and absence are recorded below. |

## Immutable PostgreSQL results and cleanup

The earlier frozen, unpublished foundation commit `17e8f98d366f9d68b9f27e40dcd1be07fecde6db`, tree `0806ee0acb9fe2a619934f08bb58b86352d06965`, passed all sixteen required PostgreSQL suites and 208 tests with zero failures, skips, or TODOs. Its HEAD, tree, and 2,227 relevant source/test fingerprints stayed unchanged throughout execution. That result remains historical local evidence; later identity corrections required a new run rather than reusing the earlier tree's result.

The published P0 runtime checkpoint below was tested in stationary detached checkout `/workspace/gaming-foundation-validation`. Its tracked source was clean; its sole untracked entry was the inspected `node_modules` dependency symlink to the task's installed dependencies. Direct Jest commands performed no build, source edit, or Git transition. Later quotation-boundary corrections require fresh exact-head CI; this checkpoint must not be relabeled as their immutable-head result.

| Published checkpoint SQL evidence | Observed result |
| --- | --- |
| Tested published commit | `0d3e1d7f2ddde12fb081946ab318c7609366a7e9` |
| Tested Git tree | `3dcb1a56eb2bca553458a19ff760f0294622ae62` |
| Toolchain and database | Node `24.18.1`, npm `11.16.0`, PostgreSQL `18.6` / `server_version_num=180006` |
| Test isolation | Required sentinel `1`; eleven dedicated URLs verified against the owned loopback disposable database after test-environment loading; production `DATABASE_URL` empty |
| `test:local-agent-postgres` | **PASS**: 1 suite / 6 tests; 0 failures, skips, or TODOs |
| `test:postgres-fencing` | **PASS**: 15 suites / 202 tests; 0 failures, skips, or TODOs; includes all 9 durable Gaming SQL tests |
| Combined required SQL set | **PASS**: 16 suites / 208 tests; 0 failures, skips, or TODOs |
| Source integrity | HEAD and tree unchanged before/after; all 2,227 tracked relevant files unchanged; SHA256 aggregate `a6870bf15b129ab3543cf429e7e792e28ecfef593712b37ba683cb3b3784e42d` |
| Artifacts | Sanitized result proof and bounded Jest JSON outside the repository in `/workspace/task-tools/gaming-generic-validation/published-foundation-pg18-proof.json` and the two `published-foundation-*-pg18.json` result files |
| Post-test database | Exact disposable database/version reverified; zero remaining test schemas before shutdown |
| Cleanup authorization and identity | Task-owned exact container ID `f805a0e8790ced2944abd477a0d452186c3b00c828aa7f54cd9ec7d7eb6c6507`, name `arcanos-gaming-generic-pg18-1532`, both ownership labels, tmpfs, and automatic removal reverified before the authorized exact-ID stop |
| Verified absence | At `2026-10-10 15:29:28 UTC`, stop returned exit 0; exact-name inventory was empty; exact-ID inspection returned `No such object`; loopback port 55433 was absent. No unrelated or production resource changed. |

These local SQL results do not claim the separate real Swift/device E2E, Redis admission, live publisher acquisition, Trinity/provider generation, hosted sealed preview, or terminal CI aggregate. Their independently executed evidence belongs in the final release ledger. No source/runtime change occurred as a side effect of SQL validation or cleanup.

Benchmark results, local broad checks, and exact-head CI run links must be recorded before a candidate readiness claim. Any precommit check must identify its included working tree and must not be presented as immutable-commit evidence. The unrelated Backstage SQL microbenchmarks emitted during fencing tests do not measure Gaming evidence acceptance.

## Canonical local checks and environment findings

The immutable integrated runtime checkpoint `07f56f41bf5fc3aa3f43a0ea76edb30ef7c6d5de` was checked with the pinned Node/npm toolchain. Subsequent runtime repairs and their final validation are recorded separately; a checkpoint success is not a final-head claim.

| Check | Checkpoint result and scope |
| --- | --- |
| `npm run type-check` | **PASS**, including source boundaries and shared-package builds |
| `npm run lint` | **PASS**, zero errors and 77 warnings; warnings were not suppressed |
| `npm run build` | **PASS**, including emitted aliases and reviewed compiled preview import graph |
| `npm run validate:railway` | **PASS**, static local compatibility only; no deployment |
| `npm run validate:backend-cli:contract` | **PASS** |
| `npm run validate:backend-cli:offline` | Initially failed at import because the system Python lacked `openai`; subsequently **PASS** in task-private CPython 3.11.16, using the existing script, synthetic mock credentials, disabled dotenv hydration and a socket audit guard; zero network attempts |
| Focused Python contracts | **PASS**, 84/84 tests, zero skips; five existing mocked/shared-contract files, task-private hash-pinned CI dependency subset within `pyproject.toml` bounds; `pip check` passes |
| Production npm audit policy | **PASS**, raw audit exit zero; policy report `ignored=[]`, `actionable=[]` |
| Documentation and generated indexes | **PASS**, documentation audit and `reindex:check`; local links 696/696, zero failures; 104 external URLs intentionally not checked over the network |
| Completed broad root Jest checkpoint | **FAIL**, 878 passed / 9 failed / 13 skipped suites; 17,044 passed / 16 failed / 167 skipped tests, 822.951 s. Runtime/source remained at `07f56f41`; report-only edits occurred during execution. Final revalidation must be bound separately. |

The preloaded `node_modules` did not match the lockfile: it contained `proxy-addr` 2.0.7 while the lock requires 2.0.8. IPv4-mapped-address security failures were reproduced on pristine baseline source before a canonical pinned-toolchain `CI=true npm ci --no-fund` restored the locked dependencies. The lockfile and security assertions were not changed. Missing PowerShell also caused local projector tests to fail; task-private PowerShell 7.6.6 was installed from the official release with its published SHA-256 verified. Four affected environment/security suites then passed 100 tests with two platform-specific skips. An earlier moving-tree full Jest attempt was aborted and is not a completed full-suite result.

The existing device expiry fixture reads `Date.now()` separately for issuance and expiry. A deterministic invocation of the real validator shows a gap above 1 ms produces a lifetime above the allowed hour and correctly returns `DEVICE_AUTH_INVALID` before expiry validation. Seven relevant authentication/test files are byte-identical to baseline. Focused current and pristine-baseline runs each passed the selected test (289 unrelated tests intentionally skipped). The actual clock gap in the failed broad run was not captured; its precise trigger remains a hypothesis. No authentication policy or fixture was weakened.

The completed broad run also exposed a confirmed single-quote scope regression, stale expectations for early identity diagnostics, an incorrectly rebound synthetic DLC record, and the native scanner child's inability to resolve the newly separated TypeScript profile-data alias. These receive generic runtime or narrowly scoped test-harness corrections; no rejected source is admitted to make a test pass. Five preview-related suites also exceeded existing timeouts under four workers on a two-CPU cgroup; contention is a hypothesis until lower-concurrency revalidation. Timeout limits remain unchanged.

The superseded foundation exact-head CI [run 38063303896](https://github.com/pbjustin/Arcanos/actions/runs/38063303896) checked out `0d3e1d7f2ddde12fb081946ab318c7609366a7e9`: ten jobs succeeded, unit and aggregate failed, and readiness was skipped. Unit results were 880 passed / 4 failed / 13 skipped suites and 17,026 passed / 6 failed / 167 skipped tests. The four failing suites correspond to quotation, early-diagnostic/test binding and native scanner harness corrections. The aggregate correctly refused the failed test dependency. PostgreSQL, real device E2E, security, build, lint/type, Redis, Python Windows, convergence and static compatibility succeeded on this checkpoint; they do not attest subsequent repairs.

## Review and release boundaries

The stack stops at open draft PRs, with foundation A+B first, optional corroboration D second, and benchmark/audit F last. Grouping C/E into reuse and data/versioning changes avoids unmeasured adapters or duplicate cache/recovery infrastructure. Current publication heads and terminal exact-head workflow outcomes are recorded in each draft PR description and the final handoff; those remote facts must be refreshed before any later release review.

The main branch-protection endpoint returned HTTP 403 to the installed integration. Repository ruleset listing returned an empty list, which does not establish absence of branch protection or satisfy unknown approval requirements. Required owner approvals therefore remain unverified. No merge-ready claim follows from green CI.

Production readiness remains **NOT READY** pending independent benchmark qualification, publisher-family provenance review, supported hosted preview and separately authorized live acquisition/generation validation. Production promotion and merge remain unauthorized even if checks pass.

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
| Preparation result | Container healthy; SQL over container-local socket and host loopback both report exact disposable database and `server_version_num=180006` (PostgreSQL 18.6). No candidate tests ran. |

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

No candidate immutable commit has been tested yet. Initial local PostgreSQL execution used Node `24.18.1`, npm `11.16.0`, PostgreSQL `18.6`, and required sentinel `1`. A separate safe runtime check after loading `scripts/test-env.mjs` verified all eleven dedicated bindings target the owned disposable database and production `DATABASE_URL` is empty.

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
| Cleanup | Container retained for authorized follow-up tests. Final exact-ID ownership and absence checks remain pending. |

Benchmark results, local broad checks, exact-head CI run links, the candidate immutable SHA, full immutable-head SQL validation, and final cleanup must be recorded before a candidate readiness claim. Any precommit check must identify its included working tree and must not be presented as immutable-commit evidence. The unrelated Backstage SQL microbenchmarks emitted during fencing tests do not measure Gaming evidence acceptance.

Production readiness remains **NOT READY** pending candidate gates, independent benchmark qualification, and review. Production promotion and merge remain unauthorized even if checks pass.

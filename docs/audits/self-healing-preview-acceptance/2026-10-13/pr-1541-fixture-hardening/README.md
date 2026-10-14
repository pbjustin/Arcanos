# PR #1541 independent verification and fixture hardening

This is a dated synthetic verification record for [PR #1541](https://github.com/pbjustin/Arcanos/pull/1541), not production acceptance or deployment authorization. The owner authorized fixture repairs, local validation, and commits/pushes to the existing PR branch. Merge, deployment, promotion, rollback, production connections, secret changes, and hold removal were excluded. The maintained operational contract remains [Railway deployment](../../../../RAILWAY_DEPLOYMENT.md).

## Identity and evidence boundaries

- Base/main: `f5e1d8f7266d906a1dd4adaaa10bb742be0d2e94`.
- Expected and observed initial PR head: `2a235722a345d9ece6752f9f7eec6b19a4d2cc6a`.
- Branch: `codex/inspection-certificate-chain-20261013`.
- The initial seven-file diff contained the certificate trust correction, its fixtures/checksum, and related documentation. No unrelated initial change was found. The original `/workspace/Arcanos` checkout was preserved; work used an isolated worktree.
- This hardening changes the loopback TLS suite, process fixture inventory/generator/runner, outer proof validator, harness tests, selected existing Gaming preview test time limits, and this dated audit. The six preview files are outside inspection functionality and address reproducible validation failures discovered during this task. It does not change the production collector, application code, dependencies, lockfile, workflow permissions, deployment admission, target IDs, or writer coordination.
- The committed report identifies its own publication revision by the commit containing this file. The exact final SHA, fresh remote checks, and post-commit fixture hashes are recorded separately in `final-attestation.json` after publication, avoiding a self-referential commit hash. Its authoritative SHA is also returned in the final review response.

The checked-in `working-*` artifacts deliberately record `relevantWorktreeDirty: true` and the original parent SHA. They bind the actual changed source bytes through SHA-256; they are not claimed as clean committed-head evidence. A separate exact-head matrix is required after committing. Synthetic GitHub context and loopback aliases exercise the unchanged collector's real entrypoint without claiming actual GitHub or Railway authority.

The complete non-audit diff against base comprises these sixteen files; this audit directory contains the added evidence:

```text
docs/RAILWAY_DEPLOYMENT.md
docs/audits/self-healing-preview-acceptance/2026-10-12/production-promotion-inspection-follow-up.md
scripts/railway-production-readonly-inspection.mjs
scripts/run-railway-inspection-e2e.mjs
tests/fixtures/railway-production-inspection/cases.mjs
tests/fixtures/railway-production-inspection/expired-certificate.mjs
tests/fixtures/railway-production-inspection/run-fixtures.mjs
tests/gaming-clear-preview-failure.test.ts
tests/gaming-currentness-preview-failure.test.ts
tests/gaming-durable-rag-preview-failure.test.ts
tests/gaming-generation-budget-preview-failure.test.ts
tests/gaming-progress-recovery-preview-failure.test.ts
tests/native-pr-preview-application.test.ts
tests/railway-auto-deploy-supply-chain.test.js
tests/railway-inspection-e2e-harness.test.js
tests/railway-production-inspection-tls.test.js
```

## Artifact index

| Artifact | Purpose |
| --- | --- |
| [security-baseline.md](security-baseline.md) | Initial remote CI, production secret metadata limitation, and security/supply-chain review. |
| [dependency-baseline.json](dependency-baseline.json) | Existing default-branch alert banner, unchanged dependencies, and the HTTP 403 limit on assessing alert impact. |
| [original-reproduction.json](original-reproduction.json) | Original implementation identity, failed positive tests, and successful negative-expectation proof on both PostgreSQL versions. |
| [timing-regression-summary.json](timing-regression-summary.json) | Real PostgreSQL control fails with the former timing order; corrected order passes independently of background cleanup. |
| [working-matrix.json](working-matrix.json) | Source file hashes, dependency versions, image IDs, isolation, case totals and container removal. |
| [working-pg17-proof.json](working-pg17-proof.json) | All 39 PostgreSQL 17 collector cases, separate setup rejection, real SQL/session evidence and teardown. |
| [working-pg18-proof.json](working-pg18-proof.json) | All 40 PostgreSQL 18 collector cases, separate setup rejection, real SQL/session evidence and teardown. |
| [working-artifact-checksums.json](working-artifact-checksums.json) | Independent SHA-256 verification of all 69 generated receipt files plus proof/source artifacts. |
| [full-jest-partial-summary.json](full-jest-partial-summary.json) | The incomplete local full attempt, every observed failed test, and the raw-log checksum. |
| [full-jest-context.json](full-jest-context.json) | Exact local full-run command, versions, environment isolation and execution budget. |
| [powershell-prerequisite.json](powershell-prerequisite.json) | Direct evidence of the missing executable and verified task-local prerequisite installation. |
| [preview-timeout-investigation.md](preview-timeout-investigation.md) | Source identities, actual preview workloads, timeout assumptions and investigation limits. |
| [focused-test-inventory.json](focused-test-inventory.json) | All 112 passing focused test names, grouped by suite, and their raw-result checksum. |
| [skipped-test-inventory.json](skipped-test-inventory.json) | All 167 skipped test names and prerequisite reasons, matching the initial baseline. |
| [timeout-reproduction-summary.json](timeout-reproduction-summary.json) | The original covered rerun's exact failures, including the separate assertion mismatch. |
| [timeout-repaired-summary.json](timeout-repaired-summary.json) | The ten-wrapper repair's 112 passing tests and newly observed recovery timeout. |
| [native-repaired-summary.json](native-repaired-summary.json) | All 79 native-suite assertions passing after the eleventh correction, with global coverage still required separately. |
| [offline-validation-summary.json](offline-validation-summary.json) | Five offline commands, exact counts, exits and log hashes. |
| [validation-summary.json](validation-summary.json) | Consolidated local outcomes, explicit incomplete full-suite evidence, prerequisites and remaining hosted-CI gate. |
| [final-static-validation-summary.json](final-static-validation-summary.json) | Final type-check, lint, build and static Railway commands, exits, timings and hashes. |
| [verify-artifacts.py](verify-artifacts.py) | Independent verifier for clean committed source, every receipt, process outcomes, isolation and teardown. |

Full local logs, negative-run artifacts and individual sanitized receipts are retained under `/workspace/pr1541-evidence/`; no production credentials, private keys or raw production logs are included in this tracked evidence set. Certificate keys are generated inside temporary fixtures and removed during teardown. Random synthetic keys/credentials vary between runs; expected security outcomes and invalid certificate dates are fixed.

## Original defect reproduction

The original production collector was executed byte-for-byte from base/main. Its SHA-256 is `94ababb34f2bc052c64281c085411e0fa52e8b172da8b57ef9cc115cf6881c68`. A separate detached checkout copied only the original PR's fixture additions, leaving that collector untouched.

The unmodified positive acceptance fixture failed on PostgreSQL 17 and 18 at `database-issuer-signed-pin_EXIT_CODE_UNEXPECTED`. The self-signed `complete-catalog` path succeeded first. A second run changed only the two signed-certificate fixture expectations to require rejection, allowing both shapes to be observed: the ordinary signed leaf and Railway-template signed authority each produced `BLOCKED`, stage `connecting`, zero SQL statements, and a closed connection. The 23/24-case negative-expectation matrices passed; both containers were removed. This is a deliberately adapted test oracle for the historical implementation, not a production validation bypass.

The loopback suite independently reconstructs the pre-fix options by removing only `allowPartialTrustChain`. Both signed shapes reject with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, then accept with the corrected options. This identifies the TLS authentication boundary more precisely than the collector's intentionally sanitized `INSPECTION_READ_FAILED` receipt.

The corrected collector remains SHA-256 `78e901fb57355eb6552080ab77d383880b0d00390e83684e5f4e4281bd531503`. With an explicitly pinned peer, both signed shapes complete real read-only collection on PostgreSQL 17.11 and 18.6. Synthetic reproduction does not prove the cause of the earlier production failure.

## Security matrix and intended policy

| Boundary | Expected and observed evidence |
| --- | --- |
| Valid pinned self-signed certificate | ACCEPT; complete catalog transaction and receipt. |
| Pinned issuer-signed leaf outside system trust | ACCEPT without its issuer, through real TLS and both PostgreSQL versions. |
| Railway-template signed authority | ACCEPT with `CA:TRUE` and digitalSignature/nonRepudiation/keyEncipherment/dataEncipherment KeyUsage. |
| Expired or not-yet-valid pin | REJECT; OpenSSL validity remains enforced. |
| Wrong fingerprint, chain-valid alternate peer, same-issuer sibling | REJECT; trusting a certificate does not admit a different peer. |
| Wrong requested hostname | REJECT, including suffix/prefix, case, trailing-dot and empty-name variants in the TLS helper. The collector separately rejects a substituted database target before connection. |
| Certificate SAN differs from fixed proxy host | ACCEPT only for the exact reviewed pin and fixed requested proxy host, as the existing contract explicitly intends. Pin identity replaces SAN matching in this mode. |
| No configured pin | Ordinary system trust remains enabled; the fixture's untrusted peer is BLOCKED. Absence is not universally invalid for a publicly trusted server. |
| Malformed/truncated/invalid DER PEM or multiple certificates | REJECT before provider or database use. |
| Missing/incorrect project token or database password | REJECT; TLS pinning does not bypass metadata or PostgreSQL authentication. |
| Server certificate/key mismatch | PostgreSQL startup REJECT, separately labeled setup evidence with no collector execution; loopback also rejects mismatched key material. |
| TLS downgrade | REJECT when PostgreSQL refuses SSL; loopback rejects TLS 1.1 negotiation. |
| ExtendedKeyUsage | serverAuth and serverAuth+clientAuth ACCEPT; clientAuth-only REJECT. |
| KeyUsage | digitalSignature-only ACCEPT; keyCertSign-only REJECT. |
| Trust scope | Default Node CA set and TLS environment unchanged; an unpinned connection still rejects the previously pinned untrusted peer. |

The 28 TLS test cases and final 40/41 process inventories are listed by executable test names in the source and proof JSON. The checked-in `working-*` predecessor evidence contains 39/40 cases; the additional timing regression is described below and must pass on the final committed head. Related scenarios intentionally share fixtures where they exercise the same boundary. Certificate validity, exact fingerprint, fixed target and authentication checks remain enforced; no production deadline, assertion or coverage threshold was relaxed. Selected preview tests' Jest wall-clock limits were raised as explicitly described below.

## Process lifecycle and failures

Successful collection uses the real CLI, `pg` driver and PostgreSQL TLS/authentication. It issues exactly `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SET LOCAL search_path = pg_catalog, public`, the four fixed catalog SELECTs, and `ROLLBACK`. The server's transaction-read-only state, real TLS session, inventory invariants, unchanged database fingerprint, bounded receipt, and session disappearance are independently observed.

The additional 17 collector cases per version cover future/sibling certificates, malformed/bundle pins, missing/wrong credentials, target substitution, SSL refusal, connection refusal, query failure, query timeout, connection loss, cleanup timeout, interruption, and independence of collector-exit timing from fault cleanup. The existing metadata/CLI bounds, catalog-secret redaction, immutable receipt, source-authority and catalog-shape cases remain.

- The transaction-failure case revokes actual catalog SELECT permission, producing a PostgreSQL error inside the read-only transaction and an observed ROLLBACK. It does not claim that BEGIN itself was rejected.
- Query timeout locks the actual catalog and pauses the observed collector backend for a bounded interval. It resumes the backend and proves rollback, closed sessions and unchanged data.
- Connection loss terminates the observed disposable backend. Cleanup timeout pauses it during rollback. Both produce `DATABASE_CLEANUP_FAILED`; cleanup timeout conservatively records `connectionClosed: false`, while the harness independently proves eventual session disappearance after recovery.
- SIGTERM interrupts the actual collector while its transaction is open. No success receipt/output marker is accepted; PostgreSQL closes the session and implicitly rolls back. An explicit ROLLBACK statement is not claimed for this path.
- Every pause/lock is restored in teardown; complete success requires stopped PostgreSQL, removed temporary files, zero paused backends and host-confirmed container removal. No database port is published. Runtime containers have no network route, an empty credential environment, resource limits and only a proof-directory bind mount.

The outer runner now rehashes each retained receipt independently and validates version, setup and teardown evidence. Unit regressions accept an intact artifact bundle and reject changed valid-JSON bytes with an unchanged claimed hash. Failed or partial fixture evidence cannot become a complete PASS.

The disposable collector child trusts a separate generated HTTPS metadata certificate through `NODE_EXTRA_CA_CERTS`. That certificate does not issue the PostgreSQL certificates; the unpinned database still rejects. This is synthetic provider setup, not a production trust modification. The separate loopback TLS regression directly verifies that the production pin helper leaves Node's default trust and TLS environment unchanged.

## Repairs and validation history

No additional production collector defect was found. Missing regression coverage and artifact-integrity checks were added. JSDoc was added to touched named helpers to address the reported documentation warning without changing its gate.

The first published hardening candidate, `6a3b29701bda8711a754b7e2b31b26af446466a9`, passed its 39/40 process matrices, but [refreshed review](https://github.com/pbjustin/Arcanos/pull/1541#discussion_r4264412306) found that elapsed time was measured after waiting for background fault cleanup. A 5.5/6.5-second injected pause could therefore make a prematurely exited collector appear to satisfy the timeout lower bound. Those runs remain historical evidence and are insufficient for the corrected timing claim. The repair records elapsed time immediately when the actual collector exits, then still awaits fault recovery and teardown.

The new `collector-interrupted-during-backend-pause` case reaches an actual read-only transaction, pauses its disposable PostgreSQL backend for 6.5 seconds, and terminates the real collector with SIGTERM. It requires collector exit in less than five seconds, no new receipt or success marker, eventual session removal and unchanged data. A separate PostgreSQL 17 control with the former measurement order failed exactly this guard, recording 6,713 ms after 29 preceding passes. The corrected 40-case run passed and recorded actual collector exit at 200 ms despite the same 6,500 ms backend pause. Both runs retained complete teardown and unchanged data. Final inventories are 40 PostgreSQL 17 cases and 41 PostgreSQL 18 cases, plus two separate server key-mismatch setup checks, with 69 receipt files. The committed independent verifier checks the new timing evidence explicitly; the four focused suites also passed all 112 tests after this correction.

The same review [identified stale audit wording](https://github.com/pbjustin/Arcanos/pull/1541#discussion_r4264412289) about the completed 79-test native rerun; the investigation now records its actual result and retained coverage limitation. Its updated docstring advisory measured 75.86% (22 of 29 supported functions). The seven remaining undocumented helpers were identified exactly: three nested DER helpers in each certificate generator and the harness proof factory. Concise JSDoc was added to those seven; the final remote review must confirm the resulting metric.

The [original CodeRabbit advisory](https://github.com/pbjustin/Arcanos/pull/1541#issuecomment-6152067146) reported 50% docstring coverage against an 80% threshold, analyzing six functions across five files with two unsupported items skipped. Its status was successful despite the warning. Added documentation addresses the affected helpers; the final remote review determines the updated advisory result.

The first expanded process run stopped before collector cases because its key-mismatch assertion recognized only PostgreSQL's wording. The actual server rejected startup, but OpenSSL's loader wording differed. The assertion now accepts only the two specific key-mismatch diagnostics, still requires failed startup and absence of a server PID, and subsequently passed on both versions. This failed run remains in the evidence directory.

Type-check, build and static Railway validation passed. Lint reported zero errors and the same 77 warnings as both initial head and base CI. The first full local Jest attempt overlapped Docker work and hit an unchanged preview test's five-second timeout; it was retained and stopped after 22 passing suites. The same test later passed in isolation without coverage and with its original timeout (4,775 ms). Its test and directly exercised application sources match main.

The separate one-worker full run with coverage and no Docker overlap reached its 45-minute execution limit after 794 passing suites and six failed suites. It did not emit a final Jest JSON or complete coverage report and is **INCOMPLETE_FAILED**, not a full pass. One failure was the proven missing `pwsh` executable. Five Gaming preview suites reported seven default five-second test timeouts while executing the unchanged large synthetic guide-proof chain. Their application code, dependencies and runner configuration match main; the changed TLS/harness suites had not reported execution before those failures. This establishes change scope and concrete timing assumptions, not a specific scheduler cause. Corrective prerequisite tests, unchanged-deadline covered reruns and the final hosted CI results must be considered separately.

An isolated coverage-enabled rerun of the six affected preview suites, retaining the original five-second limits, produced four failed suites and two passing suites: 12 failed and 101 passed tests. Eleven failures were timeouts; one was an actual mock-call-count mismatch (expected one, received two). Unfinished timed-out requests overlapping later mock resets are a plausible explanation for that mismatch, not an independently established cause. The full failure details remain in the evidence.

The repository already gives complete served-guide proof tests 30 seconds in guide-assistance, structured-evidence, hybrid and source-acquisition suites. These requests execute ten proof stages, including large source and chunk-limit fixtures, without a five-second performance contract. The first repair aligned ten affected test/table wrappers across six files with that convention. Its covered rerun passed all 12 originally failing tests, including the mock-count assertion, and finished with 112 passes and one newly observed timeout in the unchanged large-source failure/recovery test. That test executes a failed request followed by a real successful full-guide request and retained the five-second default. The final repair also aligns this eleventh wrapper, raising only the selected Jest limits from 5 to 30 seconds. Assertions, global Jest configuration, coverage gates and production request/query/TLS budgets remain unchanged. This is an explicitly disclosed test-duration change, not a production security relaxation.

The four focused suites passed all 112 tests without skips: TLS 28, read-only inspection 39, harness 40 and supply-chain 5. The skip/prerequisite run passed 11 suites and 132 tests after PowerShell installation. It reproduced exactly 13 fully skipped suites and 167 skipped tests: 155 require opt-in PostgreSQL, four Redis, three iOS, three an external server, and two Windows. Both PowerShell suites passed their runnable tests. The five separate offline command groups passed all 445 tests (16, 234, 18, 42 and 135 respectively), with zero skips. These subset results are not added together to invent a complete root-suite total.

The final native-only coverage-enabled rerun passed all 79 tests, including failure/recovery, in 116.106 seconds. Together with the other five unchanged suites' 34 passing tests from the preceding covered run, every one of the 113 affected preview assertions passed after its last source change. These focused coverage commands still exit nonzero because they do not exercise unrelated globally required coverage targets; no coverage gate was disabled. Complete coverage acceptance requires the final hosted full-suite run.

Post-commit verification must refresh the remote head/base, required checks and review threads; a changed relevant revision invalidates affected prior evidence. Final hosted CI counts, coverage, URLs and clean committed-head process evidence are recorded in the post-publication attestation, separately from the failed local full attempts above.

After the final test edits, type-check, lint, build and static Railway validation all passed again. Lint retained exactly 77 warnings and zero errors. Documentation checks and generated indexes passed; the maintained local-link audit passed all 716 local targets, with external URL network checks intentionally skipped. Dated-audit relative links were additionally resolved directly. The staged secret/artifact guard passed and is repeated immediately before committing.

## Reproduction commands

Run from the repository root with Node `24.18.1` / npm `11.16.0` and locked development dependencies. Docker must be the local managed daemon. The fixture builder preserves proxy/CA trust for image acquisition, while runtime uses `--network none` and no published ports.

The broader root suite also invokes Python with `jsonschema`/`referencing` and PowerShell (`pwsh`). Local PowerShell 7.4.6 was installed only under the task toolchain after the full run exposed the missing executable; its official archive SHA-256 was independently matched to `6f6015203c47806c5cc444c19d8ed019695e610fbd948154264bf9ca8e157561`. The resulting failed attempt is recorded separately from any corrected rerun. CI uses its hosted runner prerequisites and Python 3.11; local Python was 3.12.14.

```bash
npm run type-check
npm run lint
npm run build
npm run validate:railway
node scripts/run-jest.mjs --runTestsByPath tests/railway-production-inspection-tls.test.js tests/railway-production-readonly-inspection.test.js tests/railway-inspection-e2e-harness.test.js tests/railway-auto-deploy-supply-chain.test.js --coverage=false --runInBand
npm run test:railway-inspection:e2e -- --output-directory /absolute/new-proof-directory
python -I docs/audits/self-healing-preview-acceptance/2026-10-13/pr-1541-fixture-hardening/verify-artifacts.py "$PWD" /absolute/new-proof-directory
npm test -- --maxWorkers=1 --workerIdleMemoryLimit=768MB --json --outputFile=/absolute/full-jest.json
npm run test:live-pr-preview:offline
npm run test:live-validation:offline
npm run test:preview-e2e
npm run test:native-pr-preview-e2e
npm run test:stacked-draft-preview
npm run docs:check
npm run docs:links -- --local-only
git diff --check
```

For the historical reproduction, create a separate detached worktree at base SHA `f5e1d8f7266d906a1dd4adaaa10bb742be0d2e94`, install the same locked dependencies, and copy `tests/fixtures/railway-production-inspection/{cases,run-fixtures}.mjs` from initial head `2a235722a345d9ece6752f9f7eec6b19a4d2cc6a`. Run each PostgreSQL major separately: the positive signed-pin case must fail. To capture both historical rejection receipts, add only `errorCode: 'INSPECTION_READ_FAILED', stage: 'connecting', metadataCalls: 1, sql: 'none'` to the `database-issuer-signed-pin` and `database-template-signed-pin` calls in that reproduction checkout. Run both majors again and verify the original collector hash above remains unchanged. Never apply these negative expectations to the fixed PR branch.

For the timing regression control, use a separate detached worktree at `6a3b29701bda8711a754b7e2b31b26af446466a9`, copy the final revision's `cases.mjs` and `run-fixtures.mjs`, and move only `const elapsedMs = Date.now() - startedAt;` below the `await currentCase.backgroundFault` statement in `executeCase`. Run `npm run test:railway-inspection:e2e -- --postgres-major 17 --output-directory /absolute/new-timing-control-directory`; it must fail the new interrupted-during-pause timing guard. The unmodified corrected runner must pass the same PostgreSQL 17 command with a different new output directory. The production collector stays byte-identical in both runs.

## Production evidence and remaining prerequisites

Production certificate verification is BLOCKED. A metadata-only request for `RAILWAY_PRODUCTION_DATABASE_CERTIFICATE` returned HTTP 403; current existence, content, authenticity and freshness are unknown. No production certificate, private key or secret value was retrieved. No authenticated production handshake or inspection was performed in this task.

The earlier [production inspection](https://github.com/pbjustin/Arcanos/actions/runs/38441786338) remains historical BLOCKED evidence, not proof that this synthetic defect caused it. Owner action must obtain and authenticate the actual public server certificate through an authorized administration channel, then configure/verify the existing Actions secret. Public-proxy trust bootstrapping, private-key retrieval and certificate rotation are not authorized here.

Production release also requires the existing writer, migration, source-provenance and quiet-window evidence. Hold `20260830-job-events-worker-budget-v1` remains enforced. Live self-healing acceptance remains deferred. `COLLECTION_COMPLETE` supplies inventory only; compatibility, running-source and historical-continuity verdicts remain separate.

Residual trust assumptions include reviewed main-branch code, locked dependencies, the authenticated origin of the operator-supplied certificate, and selected catalog text. Known-credential redaction does not prove that arbitrary unknown sensitive literals cannot exist in administrator-controlled schema definitions. These are documented boundaries, not newly demonstrated regressions. Synthetic verification may support merging this repair; it supplies no production release authorization.

GitHub's push response reported 19 existing default-branch dependency alerts: two critical, 11 high and six moderate. A single read-only request for alert metadata returned HTTP 403, so their packages and applicability to this collector could not be established or cleared. The complete PR changes no dependency manifest or lockfile. This is an unresolved baseline visibility limit, not evidence that this PR introduced those vulnerabilities; it remains separate from the inspected workflow and fixture supply-chain safeguards.

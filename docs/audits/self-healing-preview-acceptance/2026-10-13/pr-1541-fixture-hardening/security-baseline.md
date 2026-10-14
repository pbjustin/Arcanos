# PR #1541: security and CI baseline

Recorded 2026-10-13T19:27:36Z. Read-only investigation; no repository edits, secret values, certificate retrieval, live TLS handshake, workflow dispatch, deployment, database connection, or provider call by this reviewer. This baseline was prepared outside the repository and subsequently included in the audit. Other reviewers were concurrently editing the shared worktree; the source review below concerns the original remote head unless explicitly qualified.

## Remote identity and merge gates

- PR: https://github.com/pbjustin/Arcanos/pull/1541
- Head: `2a235722a345d9ece6752f9f7eec6b19a4d2cc6a` (`codex/inspection-certificate-chain-20261013`).
- Base/main: `f5e1d8f7266d906a1dd4adaaa10bb742be0d2e94`.
- Refreshed at the start of this audit: OPEN, non-draft, MERGEABLE, CLEAN, reviewDecision null, no labels, zero review threads; pagination exhausted.
- `gh pr checks --required` identifies exactly `All Checks Complete` and `docs:check`; both pass. Required-check evidence: https://github.com/pbjustin/Arcanos/actions/runs/38444620386/job/115467796723 and https://github.com/pbjustin/Arcanos/actions/runs/38444620159/job/115459647651.
- Repository rulesets and effective branch-rules endpoints return empty arrays. Classic branch-protection REST and GraphQL inspection return integration HTTP 403. Exact approval-rule internals therefore remain unavailable; current visible merge state has no approval blocker.
- All 15 Actions runs associated with this head were completed success or skipped; no `action_required`. Railway App, Cursor, and coderabbitai had queued zero-check suites; these did not produce a required pending context or an unclean merge state. CodeRabbit status and Codecov patch check passed.

## CI evidence actually read

The PR CI/CD run https://github.com/pbjustin/Arcanos/actions/runs/38444620386 is successful and associated with the exact remote head above. The unit job's archived log directly establishes:

| Metric | Result |
| --- | --- |
| Jest suites | 904 passed, 13 skipped, 917 total |
| Jest tests | 17,665 passed, 167 skipped, 17,832 total |
| Snapshots | 0 |
| Statements | 93.57% (42,348 / 45,258) |
| Branches | 87.32% (7,199 / 8,244) |
| Functions | 95.79% (957 / 999) |
| Lines | 93.57% (42,348 / 45,258) |

Unit log: https://github.com/pbjustin/Arcanos/actions/runs/38444620386/job/115460484164. These are existing remote CI results, not a newly executed local full suite. The workflow's ordinary PR checkout may use GitHub's merge ref; the run's `head_sha` establishes association with the PR head, not an independent claim that every job checked out that raw head.

Lint was independently read through the GitHub connector from both the head job https://github.com/pbjustin/Arcanos/actions/runs/38444620386/job/115459649796 and the base job https://github.com/pbjustin/Arcanos/actions/runs/38439233559/job/115441165932. Both say `77 problems (0 errors, 77 warnings)`. After timestamp removal all warning annotation lines are identical, supporting the pre-existing-warning classification.

The base CI/CD run https://github.com/pbjustin/Arcanos/actions/runs/38439233559 is successful on `f5e1d8f7266d906a1dd4adaaa10bb742be0d2e94`. Its maintained audit records 904 passed suites, 17,662 passed tests, 13 skipped suites and 167 skipped tests. Those base test counts were not independently re-read here: the run archive exposed no logs, direct job-log redirect downloads were forbidden, and the connector returned `Transport closed` for the large base unit log on two attempts. The base lint log remained accessible. A transient GitHub 401 recovered without credential changes. No raw redirected URLs or credentials are retained in this report.

The original PR CI run https://github.com/pbjustin/Arcanos/actions/runs/38444619883 succeeded. Later same-head PR CI https://github.com/pbjustin/Arcanos/actions/runs/38447707127 is skipped: its build job runs only for opened/reopened/synchronize events, while the workflow also accepts label/ready events. Inspection fixture CI https://github.com/pbjustin/Arcanos/actions/runs/38447707245 and Railway preview jobs require the absent `railway-preview` opt-in label; skipped jobs are not executed proof. Scheduled-discovery jobs skip on non-scheduled events. No label was added or workflow rerun.

The 13 skipped Jest suites and 167 skipped tests are distinct from skipped workflow jobs. Their exact per-test reason inventory was not recoverable from the aggregate summary; do not call them passed or equate them all to one skip condition. The separate required PostgreSQL and Redis jobs passed in CI. This reviewer did not rerun those database suites.

## Production certificate verification

One metadata-only request was made to `GET /repos/pbjustin/Arcanos/actions/secrets/RAILWAY_PRODUCTION_DATABASE_CERTIFICATE`, asking only for name and timestamps. It returned HTTP 403 `Resource not accessible by integration`. This does not establish whether the secret exists, is absent, is current, or holds the intended certificate. No secret value, credential, public certificate, or private key was requested. No authenticated production certificate comparison or live handshake was performed; that verification is BLOCKED/UNVERIFIED from this execution context.

The prior production inspection https://github.com/pbjustin/Arcanos/actions/runs/38441786338 failed on base/main, not this PR head. Job metadata independently confirms failure at `Collect bounded read-only production receipt`, successful sanitized-artifact upload, and skipped promotion jobs. The tracked release audit records `BLOCKED`, connecting stage, `INSPECTION_READ_FAILED`, connection closed, and no SQL. That generic receipt does not prove certificate trust was the cause. The same audit records an empty certificate input at that earlier run; it is historical evidence, not present secret metadata.

Production follow-up requires authenticated owner access to obtain and review the actual server certificate and configure/verify the existing Actions secret. This audit does not perform or authorize that action. The current coordinated-writer hold and separate writer/migration/provenance/quiet-window requirements remain intact. Live self-healing acceptance remains owner-deferred and is not established by synthetic TLS or PostgreSQL fixtures.

## Security and supply-chain review

No new security blocker demonstrated in the original PR diff. The only production collector behavior change is `allowPartialTrustChain: true` in the explicit single-certificate-pin branch, plus explanatory comments. Application code, dependencies, lockfile, target IDs, SQL, production workflow, and rollout hold are unchanged. The collector digest was intentionally updated in the security contract test from `94ababb34f2bc052c64281c085411e0fa52e8b172da8b57ef9cc115cf6881c68` to `78e901fb57355eb6552080ab77d383880b0d00390e83684e5f4e4281bd531503`.

- **TLS identity:** missing/empty pin retains `{ rejectUnauthorized: true }` and ordinary system trust. Explicit pin accepts one bounded PEM certificate, rejects bundles/extra content, trusts that exact certificate as the anchor, and requires the requested fixed proxy hostname plus an exact peer-certificate SHA-256 fingerprint. The certificate's DNS name need not match in pin mode by design; fingerprint identity replaces that check. `rejectUnauthorized` and OpenSSL validity validation remain enabled. Existing real loopback tests cover self-signed pins, issuer-signed leaf and template-shaped CA certificates, expiry, substituted certificate, changed destination hostname, and malformed pins. These are synthetic tests, not proof of the production peer.
- **Fixed reads and target binding:** the collector binds exact project/environment/service IDs, exact PostgreSQL proxy host/port/database, no URL query/fragment, bounded Railway variable-list CLI output, and metadata snapshots before/after. GraphQL uses one fixed metadata query, HTTPS, no redirect following, a five-second budget and two-MiB response cap. The Railway helper uses fixed argument arrays with `shell: false`, time/byte bounds, and omits raw stdout/stderr from errors.
- **SQL meaning of read-only:** the selected database statements comprise four fixed catalog `SELECT`s plus `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SET LOCAL search_path = pg_catalog, public`, and `ROLLBACK`. Connection options default transactions to read-only and apply statement/lock/idle-transaction timeouts. The identity SELECT verifies `transaction_read_only = on`. These statements do not write application data or schema. Session/transaction settings, locks and normal server observability effects are permitted; read-only does not mean literally no server-side activity.
- **Output and cleanup:** rows, names, types, catalog strings, metadata and formatted receipt size are bounded. Known project-token and decoded database-password strings are rejected from retained catalog text. Raw driver/provider failures collapse to fixed error codes. Cleanup attempts rollback and close; timeout cleanup attempts stream destruction and records failure. The receipt uses one fixed filename, exclusive creation, mode 0600, and refuses pre-existing files/symlinks. Workflow upload requires the collector's successful-write marker and retains the private artifact for seven days.
- **Production workflow:** inspection is manual/current-main-only; it verifies live default ref, immutable checkout identity and trusted workflow/source SHA, shares a non-cancelling production concurrency group, and excludes both deployment jobs. Inspection permissions are only `contents: read`. Pinned checkout/setup/upload action SHAs and a version/checksummed Railway CLI precede `npm ci --ignore-scripts --no-audit --no-fund`. The project token and certificate reach only the collector step, after token-free setup. The supplied public certificate is not a private key. The protected source checksum and complete privileged step bodies are covered by tracked supply-chain tests.
- **Fixture and preview workflows:** fixture CI runs only same-repository non-draft opted-in PRs, uses contents-read permissions, exact-head checkout with no persisted credential, pinned actions, no production secrets and install scripts disabled. It launches synthetic PostgreSQL 17/18 fixtures through the existing network-disabled harness. Preview lifecycle's privileged `pull_request_target` controller checks out `github.workflow_sha`, with PR evidence/verifier work separated onto a runner without the lifecycle token. Its declaration includes status-write permission only on the trusted controller/reporter jobs. These controls do not make arbitrary malicious PR code safe in a credentialed platform environment; repository policy still requires platform isolation and trusted opt-in.
- **CI permissions:** ordinary PR workflows are `contents: read` and do not introduce production credentials. The final aggregate adds `actions: read` for bounded receipt collection. Ordinary CI includes existing version-tagged actions and lifecycle-enabled dependency installation; this PR does not change those baseline trust assumptions. Production inspection uses the stricter immutable action/CLI pins and disabled install scripts described above.

## Precise limits

`COLLECTION_COMPLETE` means inventory collection, not catalog compatibility, runtime source attestation, every-writer inventory, native-trigger verification, historical continuity, live recovery, or promotion approval. Those verdicts deliberately remain `NOT_EVALUATED`, `UNVERIFIED`, or `NOT_INSPECTED`. Metadata before/after equality only detects changes visible in the selected projection during the observation window. The catalog receipt retains selected schema definition text; known-secret rejection is not a proof that arbitrary unknown sensitive literals could never exist in an administrator-controlled schema. Main-branch code and locked runtime dependencies are trusted; same-step credential scoping and checksum tests are review controls, not a sandbox against malicious approved source/dependencies. No hypothetical issue above was promoted to a demonstrated PR regression.

Production rollout hold remains `20260830-job-events-worker-budget-v1` in `.github/workflows/railway-auto-deploy.yml:34`. `docs/CI_CD.md` explicitly separates successful CI from production promotion/live readiness. A repair can merge while these distinct release prerequisites remain unresolved; this report grants neither merge nor production-operation authorization.

# PR #1539 production promotion: read-only inspection repair

Recorded 2026-10-13. The owner subsequently authorized production promotion and
continued investigation of the release blockers. Live self-healing fault
acceptance remains deferred; no historical staging attempt is reclassified.

## Source and production baseline

PR #1539 was merged by the owner at
`b486354ab03b229e629667605e395fe95708d233`. Its complete tree is identical to the
reviewed PR head `031cf38acea5f022a867bf3e0899fc3584a80c21`. Main CI/CD run
`38322630689` and documentation run `38322630759` passed.

Production project: `7faf44e5-519c-4e73-8d7a-da9f389e6187`.
Environment: `fb583147-6c39-4343-9267-500f357d25ab`.

| Role | Service | Active successful deployment |
| --- | --- | --- |
| Web | `c4ade025-3f13-4fca-9309-5d0dd81396fe` | `9afcb60f-4989-4c07-9190-bdb1b1f2d174` |
| Worker | `1765befb-b805-4051-9af9-28634e986886` | `24848102-a998-48b3-98f1-96afd891bdeb` |
| PostgreSQL | `6647b5b1-d796-4783-b5f0-b8e356019ca6` | `7bb12602-2ebb-4901-96a6-a232fba5c279` |
| Redis | `81e4a1cf-7ae4-48bf-8321-23641bb23c0e` | `aeae0e09-e4bb-406f-92ea-cf5ca81294ac` |

Read-only `/readyz` observations were healthy for web and worker. Those responses
prove readiness only. The current pair's metadata claims the older CLI upload
`b6c81d46794700447f9d22ca226dcee36d1cd981`; it does not independently identify
the running source. Its image digests also differ from the original October11
paired upload. Do not credit it as a verified deployment of PR #1539.

The active hold `20260830-job-events-worker-budget-v1` correctly blocks automatic
promotion. [PR #1514](https://github.com/pbjustin/Arcanos/pull/1514) records both
ordered six-phase migration passes and a September29 catalog inspection, but
explicitly leaves the historical one-hour quiet interval unverified. These are
historical observations, not a fresh catalog or all-writer receipt.

## Reproduced inspection gap and repair

This executor has no general raw-TCP route or configured VPN. Its management
HTTPS reads do not provide PostgreSQL or native SSH connectivity. No new SSH key,
proxy, service, environment or project was created. The obsolete Railway CLI
relay was not used as a workaround. A direct database attempt failed before
connecting or executing SQL.

The existing production workflow previously offered only promotion. Four new
wiring assertions failed before the repair: the inspection job/input did not
exist, and the deployment admission lacked a separate mode. The focused suite
then passed after adding `operation=inspect` to the existing workflow. This is
an operational inspection gap, not a newly reproduced self-healing defect.

The repair retains the hold and existing paired deployment command bodies. It
adds one manual, current-main-only job sharing the non-cancelling production
lock. Both promotion jobs explicitly exclude inspection. Locked dependencies
install without lifecycle scripts before the project token reaches the single
collector step. No new live-verification workflow or infrastructure is created.

The collector binds exact resource IDs and the preexisting public PostgreSQL
proxy, captures projected metadata before and after, and uses bounded enforced
`READ ONLY` catalog queries. It records dependency/key vectors and index states
without application startup, migration imports, DDL, job submission, Redis
mutation or provider calls. It supports the actual default-null replica shape
and PostgreSQL17/18 inventory. Raw errors and variable maps are excluded.

The fixed private receipt is uploaded only after the writer reports that it
successfully created sanitized output. It cannot upload a rejected preexisting
file. A collected inventory retains separate `NOT_EVALUATED` and `UNVERIFIED`
contract, source and historical-window verdicts. It never clears the hold.

The PR blocker repair requires authenticated database TLS. System trust is the
default; the optional `RAILWAY_PRODUCTION_DATABASE_CERTIFICATE` Actions secret
pins one operator-reviewed server certificate for self-signed deployments while
preserving chain and validity checks. Trust failure blocks collection. Live
certificate provisioning and production collection remain unverified.

## Initial implementation validation

Pinned Node `24.18.1`, npm `11.16.0`.

- Focused Jest: 5 suites, 147 tests passed, 0 skipped. Command:
  `node scripts/run-jest.mjs --runTestsByPath tests/railway-production-readonly-inspection.test.js tests/railway-coordinated-rollout-guard.test.js tests/railway-auto-deploy-supply-chain.test.js tests/railway-readiness-deployment-contract.test.js tests/railway-auto-deploy-observer.test.js --coverage=false --runInBand`.
- New collector suite: 33 mocked tests passed, including target rejection,
  default replicas, PostgreSQL17/18, read-only-off rejection, query/idle-client
  failures, timeout cleanup, metadata drift, streamed byte limits, redaction and
  exclusive artifact creation. These are synthetic inspection-tool tests.
- `npm run type-check`: PASS.
- `npm run build`: PASS.
- `npm run lint`: PASS, 0 errors and 77 preexisting warnings. Focused lint for
  the three changed/new test files also passed without warnings.
- `npm run validate:railway`: PASS; no deployment performed.
- `npm run docs:check`: PASS, 1,013 documentation checks and current indexes.
- `npm run docs:links -- --local-only`: PASS, 715 local targets.
- `git diff --check`: PASS.
- Two independent source reviews found no remaining inspection safety blocker.

Initial collector SHA-256:
`88c6fd386e9d959f7b8c2da4d888e151abf13dc4c261c81ca0bd743bb1a4e222`.
The existing protected deployment observer remains unchanged at
`f005f506a1e68520558972e99f7014866c35cd0ed057fde8cb1601b01dfbbfbe`.

## PR #1540 blocker review and validation

The review reproduced two artifact-size failures: compact inventory above
64 KiB rejected collection without a failure receipt, while inventory whose
formatted JSON alone exceeded the limit passed collection and failed writing.
Both now return a bounded sanitized blocked receipt. The collector and writer
measure the same serialization and preserve cleanup state and release verdicts.

The public database connection now authenticates TLS through system trust or
one reviewed self-signed server-certificate pin. Local TLS handshakes verify
untrusted, mismatched and expired certificates fail, while the exact pin
succeeds despite the server's unrelated certificate hostname. Catalog text
containing the known database password or project token also fails closed
before it reaches the receipt. Seven focused assertions failed before repair.

On pinned Node `24.18.1` and npm `11.16.0`:

- Focused Jest: 6 suites, 161 tests passed, 0 skipped; the original five suites
  plus `tests/railway-production-inspection-tls.test.js`.
- Build, type-check, Railway static validation and documentation/index checks:
  passed. Local link audit: 715 targets passed.
- Lint: 0 errors, 77 existing warnings; no new warning in changed tests.
- Independent source reviews found no remaining code blocker.

Reviewed collector SHA-256:
`94ababb34f2bc052c64281c085411e0fa52e8b172da8b57ef9cc115cf6881c68`.
No live certificate provisioning, production inspection, deployment, migration
or provider call was performed for this review. A self-signed production peer
requires the reviewed Actions certificate secret before collection can succeed.

## Remaining release gates

At preparation time production collection is NOT_RUN. The repair must enter
reviewed main before the trusted workflow can execute; feature-branch dispatch
cannot substitute. Required CI is recorded on the repair PR's exact head.

After collection, compare actual catalog semantics with the migration contract,
verify every current/restartable writer and its group limits/source provenance,
and reconcile the missing historical continuity. Any newly observed full budget
window must be labeled as current-state reconciliation, not invented historical
evidence. A policy change requires separate review and actual supporting facts.
No production drain, migration, hold removal or deployment was performed while
preparing this repair. The original production promotion authorization remains
in place; inspection does not waive its safety prerequisites.

## Merged-source inspection on 2026-10-13

The owner merged PR #1540 at `2026-10-13T17:30:35Z`. Current main was verified as
`f5e1d8f7266d906a1dd4adaaa10bb742be0d2e94`; its tree equals the tested PR head
`d1d4229d758f9f64f8a606364512ca80d277194b`. The main
[CI run](https://github.com/pbjustin/Arcanos/actions/runs/38439233559) passed:
904 suites and 17,662 tests, with 13 suites and 167 tests skipped. Application
source, build/runtime configuration, dependencies and the lockfile were unchanged
from the merged self-healing release.

The authorized canonical
[inspection run](https://github.com/pbjustin/Arcanos/actions/runs/38441786338)
executed that exact main tip. Its artifact `11836516032`, named
`production-readonly-inspection-38441786338`, retained a sanitized receipt:

- `status: BLOCKED`, `failedStage: connecting`,
  `errorCode: INSPECTION_READ_FAILED`.
- `observedAt: 2026-10-13T17:50:12.260Z`, `connectionClosed: true`.
- Contract `NOT_EVALUATED`; running source and historical quiet window
  `UNVERIFIED`.
- Deployment, migration and hold removal all `false`.

Receipt JSON SHA-256:
`2212d8893a7b056a0c466d253d7f3ee76c475410f981b7764c2315222382a64b`.
The collector completed metadata and credential-target validation, but failed
before issuing SQL. Both promotion jobs were skipped. A masked-only log review
found the project token present and the optional certificate input empty; the
generic failure does not identify the exact driver cause. A bounded PostgreSQL
log projection found an SSL-accept failure at `17:50:24.929609304Z`, which also
does not prove a particular certificate, authentication or network cause.

A fresh production inventory after inspection retained the prior SUCCESS IDs:
web `9afcb60f-4989-4c07-9190-bdb1b1f2d174`, worker
`24848102-a998-48b3-98f1-96afd891bdeb`, PostgreSQL
`7bb12602-2ebb-4901-96a6-a232fba5c279` and Redis
`aeae0e09-e4bb-406f-92ea-cf5ca81294ac`. No pending work was present. No production
deployment, restart, configuration change, SQL/Redis mutation or provider request
was performed.

## Signed certificate pin correction

Review of the official PostgreSQL 17 template at
`railwayapp-templates/postgres-ssl@0297f79ed94df6526bdf460b69dbdd16ea59cd10`
found that `server.crt` is signed by a separate `root.crt`. The server certificate
is not a self-signed root or a certificate bundle. Its declared extensions include
`CA:TRUE` and digital-signature, non-repudiation, key-encipherment and
data-encipherment usage. This source review does not identify the installed
production certificate.

Two new real loopback TLS assertions failed before the correction: an explicitly
pinned issuer-signed ordinary leaf and the template-shaped signed certificate
were rejected as unable to verify the first certificate. The previous success
fixture exercised a self-signed certificate only. This is a reproduced inspection
compatibility defect; it is not a proven diagnosis of the failed production run.

The smallest correction enables `allowPartialTrustChain` only when an operator
supplies the reviewed single-certificate pin. That exact peer becomes the trust
anchor without needing its issuer. `rejectUnauthorized`, validity checks, the
fixed proxy hostname and exact peer fingerprint remain enforced. The default
system-trust path, collector targets, catalog queries, bounds, redaction,
production hold and deployment workflow are unchanged.

On pinned Node `24.18.1` / npm `11.16.0`, focused verification passed 7 suites /
191 tests. Real TLS assertions cover both issuer-signed shapes, signed expiry,
untrusted and substituted peers, changed target hostname and malformed pins.
Two independent security reviews found no blocker. The existing process-level
PostgreSQL fixture runner also passed 23 cases on version 17 and 24 on version 18,
including both issuer-signed pin cases. Its first working-tree proof records the
parent source SHA plus changed-file hashes; it is not an exact committed-head or
production receipt. Fixtures use synthetic credentials, no published ports and
`--network none`; both containers were verified removed.

Corrected collector SHA-256:
`78e901fb57355eb6552080ab77d383880b0d00390e83684e5f4e4281bd531503`.
The guarded source checksum was updated with the reviewed correction. The repair
PR's exact-head checks provide the final committed validation record.

Local build, type-check and non-deploying Railway validation passed. Lint had
0 errors and 77 preexisting warnings. Documentation validation passed 1,014
checks, the generated indexes were current, and 716 local link targets passed.
`git diff --check` passed. No dependency or application-runtime change was made.

Production collection remains BLOCKED. This executor cannot establish an
authenticated container/file session, and GitHub certificate-secret metadata
inspection returned HTTP 403. An owner must obtain the actual public server
certificate through an authenticated administration channel and configure the
existing `RAILWAY_PRODUCTION_DATABASE_CERTIFICATE` Actions secret. Do not fetch
private keys, regenerate certificates or bootstrap trust from an unauthenticated
public-proxy handshake. Successful collection still requires reconciliation of
the separate writer, migration, provenance and quiet-window gates.

Live self-healing acceptance remains NOT_RUN by the owner's deferred policy.
Synthetic inspection fixtures do not demonstrate live self-healing recovery or
authorize production promotion.

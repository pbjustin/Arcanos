# Repository health-audit evidence ledger

Last reconciled: 2026-08-08 UTC, after PR #1423 merged and protected-digest
draft PR #1424 was published

This ledger records durable delivery identities and bounded proof. It does not
turn local, preview, merge, or CI evidence into production credit. Current
source, required CI, and freshly read provider state remain authoritative.

## Evidence levels

| Level | What it can establish | What it cannot establish |
| --- | --- | --- |
| Local candidate | Source behavior under the named commands and environment | Publication, merge, deployment, or live provider behavior |
| Published draft | Branch, commit, and draft-PR identity | Completed review, terminal required CI, merge, deployment, or production behavior |
| Reviewed PR head | Exact published source plus surfaced PR checks/reviews | Merge or production rollout |
| Contained preview | Served commit identity and the explicitly exposed sealed/read-only contract | Normal production handlers, credentials, provider calls, PostgreSQL behavior unless specifically connected, or production state |
| Exact merge | Source/tree integrated into `main` plus exact-merge checks | Deployment unless an exact deployed revision is attested |
| Production verification | Only the exact target, revision, time, and contract observed under explicit authorization | Future state or unobserved paths |

## Draft PR #1424 — protected-digest tooling

### Candidate identity and scope

| Field | Value |
| --- | --- |
| Base | PR #1423 merge `6a3ef8763e3d97ef10e5345d3061268527d87373` |
| Branch | `codex/repository-health-progress-1423` |
| Published implementation commit | `51b7bfb117f6a6632f3244628c6b950f71a20559` |
| Draft PR | [#1424](https://github.com/pbjustin/Arcanos/pull/1424), opened 2026-08-08 UTC against `main` |
| External state | GitHub branch push and draft-PR creation only; no Railway/provider, database, live-memory, or production mutation |

The published implementation commit extracts the established version-one
semantic serializer and SHA-256 implementation into a shared runtime/tooling
owner. It adds deterministic
generate, single-check, complete pinned-check, and startup-precutover modes; all
seven manifest entries have explicit candidate adapters, while only the six
maintained runtime-owned pins participate in automatic startup. The generic
`protected_json_file` entry remains an explicit-source, manual tooling contract.

File-backed adapters reuse the runtime's exact source resolution and assistant-
registry validation. Complete checks reject arbitrary source substitution,
symbolic links, source-identity changes, BOM-prefixed or malformed JSON, schema
violations, malformed pins, and mismatches. GPT map projection uses null-
prototype records, own-property lookup, declared/loaded catalog parity under a
pin, and strict validation of every configured override. Automatic startup
output redacts both expected and candidate digests.

Tracked normal Railway startup invokes the compiled comparison after volume
mounts and before the existing role launcher. The wrapper latches termination
signals across the gate-to-launch transition. The source-workspace npm commands
build before invoking compiled code so stale `dist` cannot yield manual green
evidence; direct compiled commands remain available for the identified,
already-built pruned runtime image. Native PR preview startup now runs the same
gate before forwarding the exact sealed-preview argument to the role launcher.

### Local validation

| Check | Result |
| --- | --- |
| Node `20.19.0` `npm run build` | Passed |
| Node `20.19.0` `npm run type-check` | Passed |
| Node `20.19.0` `npm run lint` | Passed with zero errors and 76 warnings |
| Focused protected-digest, startup-wrapper, Railway, GPT-routing, integrity, module-loader, and Research suites | Passed 82/82 across eight suites |
| Direct compiled generation and isolated pinned `--precutover` smoke | Passed; automatic output exposed no expected or candidate digest |
| `npm run validate:railway` and native-PR import-boundary check | Passed |
| Generated indexes | All four regenerated together; `reindex-codebase.js --check` passed |
| Broad non-GPT Jest sweep | 7,600 tests passed; two unrelated load-sensitive Windows process tests failed, then their isolated rerun passed 28/28 |
| Unfiltered root Jest | Not green because one unchanged, explicitly excluded GPT-OSS CRLF-fixture test failed on Windows |

The broad-suite exceptions are not in modified protected-digest paths. No
GPT-OSS correction is included because that program remains explicitly outside
this queue. Local results do not establish a reviewed head, required CI,
contained preview, merge, deployment, or production behavior.

## Delivery ledger

| PR | Slice | Merge date | Merge commit | Source state |
| --- | --- | --- | --- | --- |
| [#1408](https://github.com/pbjustin/Arcanos/pull/1408) | Productivity and local-agent capability foundation | 2026-07-25 | `f5c7826e8a31cf03931fd77b7806394d3cde2233` | Merged |
| [#1409](https://github.com/pbjustin/Arcanos/pull/1409) | Repository health, security, runtime, and persistence hardening | 2026-07-28 | `81376790c7b726a2a2f55a66980c460440873386` | Merged |
| [#1410](https://github.com/pbjustin/Arcanos/pull/1410) | Expired dependency-waiver removal | 2026-07-28 EDT / 2026-07-29 UTC | `2c1be145da9faf5e60b811f25bc361a5aaf8d31e` | Merged |
| [#1411](https://github.com/pbjustin/Arcanos/pull/1411) | Memory-plane request containment and native-preview compatibility | 2026-07-29 | `481a1fb3e9f935699a2fcf685841e34edb04012e` | Merged |
| [#1412](https://github.com/pbjustin/Arcanos/pull/1412) | Worker diagnostics, generic-job continuation, and preview cleanup automation | 2026-07-30 | `2cc05f9f22bc88252b1bf7a6c17dd87c49ca1021` | Merged |
| [#1413](https://github.com/pbjustin/Arcanos/pull/1413) | Generic-job cache containment and promotion-gate hardening | 2026-07-31 | `c7ceffd8fbd3f3e944f106e8ba1df0bf34c9ea2d` | Merged |
| [#1414](https://github.com/pbjustin/Arcanos/pull/1414) | Provider admission, DAG dispatch, and GPT metric boundaries | 2026-08-01 | `762322174ee67648bf95dd74d9473915764f7a7e` | Merged |
| [#1415](https://github.com/pbjustin/Arcanos/pull/1415) | Worker-budget accounting and bounded stale recovery | 2026-08-02 | `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8` | Merged and later production-verified in a bounded reconciliation |
| [#1416](https://github.com/pbjustin/Arcanos/pull/1416) | Backstage mutation authorization and admission | 2026-08-03 | `5a5bb92672a06ec330a4a04131cfc3755c0b34a3` | Merged; no production credit |
| [#1417](https://github.com/pbjustin/Arcanos/pull/1417) | Backstage roster containment, atomicity, and adjacent hardening | 2026-08-04 UTC | `277857efed1f9aa41f724558d2f29512b65bf5a1` | Merged; no production credit |
| [#1418](https://github.com/pbjustin/Arcanos/pull/1418) | Research input bounds and deterministic storage | 2026-08-05 | `00bab421a86fcc3c148052595f9717bdc32f467a` | Merged; no production credit |
| [#1419](https://github.com/pbjustin/Arcanos/pull/1419) | Backstage storyline lifecycle | 2026-08-05 UTC | `8c25df850ae5db7b99e3a01afa72e2d0cf1ca752` | Merged; no production credit |
| [#1420](https://github.com/pbjustin/Arcanos/pull/1420) | Research aggregate budget and cancellation | 2026-08-07 UTC | `005938f74878c6ac4f878968e3eb9154c6de6e70` | Merged; no production credit |
| [#1421](https://github.com/pbjustin/Arcanos/pull/1421) | Effective MCP decoded-JSON pre-parser body cap | 2026-08-07 UTC | `e01b0397a31daf2309f5f418018d0b4116564db4` | Merged; no production credit |
| [#1422](https://github.com/pbjustin/Arcanos/pull/1422) | Fail-closed PostgreSQL package commands, aggregate CI truth, and compatible Hono remediation | 2026-08-08 UTC | `7bc83f469e571cd19626dbd2fa9360a8596b38e7` | Merged; no production credit |
| [#1423](https://github.com/pbjustin/Arcanos/pull/1423) | Node/backend `REQUEST_TIMEOUT` truthfulness | 2026-08-08 UTC | `6a3ef8763e3d97ef10e5345d3061268527d87373` | Merged; no production credit |

## PR #1423 — Node/backend `REQUEST_TIMEOUT` truthfulness

### Exact identity

| Field | Value |
| --- | --- |
| Base | `7bc83f469e571cd19626dbd2fa9360a8596b38e7` |
| Reviewed head | `58754e5632bd4bea4640ba83fc79b3a5f9a551e2` |
| Merge | `6a3ef8763e3d97ef10e5345d3061268527d87373` |
| Reviewed/merged tree | `55fe0200366bf7a06ad9f752b05e6c9e65b54093` |
| Merge time | `2026-08-08T06:57:44Z` |
| Size | 2 commits; 9 files; +80/-8 |

Remote `main` was fetched after merge and pointed directly to the merge commit.
Its parents are the PR #1422 merge and exact reviewed head; the reviewed and
merged trees match.

### Implemented contract and review evidence

The slice removes the parsed-but-unused Node/backend
`config.limits.requestTimeout`, the backend `REQUEST_TIMEOUT=30000` example,
and the corresponding millisecond-valued backend documentation claim. It does
not substitute an HTTP-server property, response-only timeout race, or other
mechanism that would falsely claim cancellation of underlying work.

The Python daemon remains independent. Its `BACKEND_REQUEST_TIMEOUT=15` and
`REQUEST_TIMEOUT=30` controls remain seconds-valued and live at their maintained
consumer seams. Documentation now scopes those consumers to the main backend
API/protocol clients, non-streaming chat, fallback chat streaming, vision,
transcription, and inline agentic confirmed commands; it does not imply a
universal daemon or Node HTTP deadline.

Focused local evidence passed the two-test Node/documentation contract, all six
daemon OpenAI-adapter tests with an exact sentinel timeout assertion, the
311/311 documentation audit with current generated indexes, and
`git diff --check`. Independent Node/runtime, daemon-contract, tests/CI, and
generated-artifact reviews found no blocker. The optional propagation-test
hardening and daemon-consumer wording recommendation were implemented. Copilot
generated no inline comments, and no review thread remained.

### Exact-head GitHub evidence

| Workflow or context | Result |
| --- | --- |
| [CI/CD Pipeline `31240522180`](https://github.com/pbjustin/Arcanos/actions/runs/31240522180) | Passed all 13 jobs, including the fail-closed aggregate |
| [API Endpoint Tests `31240522159`](https://github.com/pbjustin/Arcanos/actions/runs/31240522159) | Passed |
| [Documentation Audit `31240522158`](https://github.com/pbjustin/Arcanos/actions/runs/31240522158) | Passed |
| [PR CI `31240522167`](https://github.com/pbjustin/Arcanos/actions/runs/31240522167) | Passed |
| Codecov patch, approval-policy checks, and Copilot review | Passed |
| Railway web and passive-worker preview contexts | Passed at the exact reviewed head |

### Exact-head contained preview evidence

The native preview environment was
`b9067c39-49b8-49f6-bffe-148e5b2de058`, with web deployment
`9c44bd8b-b4b9-41a2-a8b8-0ab9aa825981` and passive-worker deployment
`b0e2e8fe-1930-4767-bd74-7aad2c011680`.

The bounded live runner passed 68/68 sequential requests with 21,832 aggregate
response bytes. It covered the sealed Research fixtures including cancellation
drain, storyline fixtures, effective MCP body-cap fixture, health/readiness,
deny-by-default behavior, and worker denial. Initial and final web/worker
readiness identities matched the exact reviewed head and remained stable.

This is sealed component and served-public-identity evidence. The checkout was
not Railway-linked, so provider IDs came from the Railway PR comment and status
contexts rather than an independent CLI control-plane attestation. The preview
does not prove a Node request deadline, normal provider/database handlers, or
production rollout.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [Documentation Audit `31245091796`](https://github.com/pbjustin/Arcanos/actions/runs/31245091796) | Passed |
| [Repository Registration `31245091806`](https://github.com/pbjustin/Arcanos/actions/runs/31245091806) | Workflow passed; its non-critical backend registration request returned HTTP 400 |
| [Analyze Documentation Updates `31245091805`](https://github.com/pbjustin/Arcanos/actions/runs/31245091805) | Failed because the auxiliary startup fixture still omitted required `ARCANOS_JOB_READ_CAPABILITY_SECRET`; the maintained Documentation Audit passed |
| [CI/CD Pipeline `31245091797`](https://github.com/pbjustin/Arcanos/actions/runs/31245091797) | Passed all 13 jobs; `All Checks Complete` verified all 11 required results |
| [Railway Auto Deploy `31245615516`](https://github.com/pbjustin/Arcanos/actions/runs/31245615516) | Coordinated-writer hold `20260727-dag-snapshot-generation-v1` passed policy and skipped production job `93073631689` |
| Railway repository-integration status history | The merge separately started 18 web/worker deployments across nine environments marked non-production, ending with six successes and 12 failures; none was the #1423 preview environment, and status history does not prove current lifecycle state or cleanup |

A read-only 2026-08-08 Railway project inventory listed 18 current environments
and did not contain preview environment
`b9067c39-49b8-49f6-bffe-148e5b2de058`. That attests environment absence, not
deletion of every historical deployment or artifact. No production rollout,
database operation, application provider/model call, live-memory mutation, or
provider-configuration change is credited to PR #1423; the other non-production
deployment starts remain a lifecycle-cleanup concern.

## PR #1422 — PostgreSQL command and aggregate CI truth

### Exact identity

| Field | Value |
| --- | --- |
| Base | `e01b0397a31daf2309f5f418018d0b4116564db4` |
| Reviewed head | `ecc8644b1da3476a12d7c895bc4406323d7d8897` |
| Merge | `7bc83f469e571cd19626dbd2fa9360a8596b38e7` |
| Reviewed/merged tree | `7c5437339ae787acf7db733892f7cdba822303a4` |
| Merge time | `2026-08-08T01:22:33Z` |
| Size | 2 commits; 26 files; +746/-189 |

Remote `main` was read back at the exact merge. Its parents are the PR #1421
merge and exact reviewed head; the reviewed and merged trees match.

### Implemented contract and review evidence

One exact `ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1` sentinel now governs all
seven required PostgreSQL suites and rejects every other nonempty value. Each
suite keeps its purpose-specific target, fails before database hooks if
required CI omits it, and accepts only an explicit loopback PostgreSQL URL for
the disposable `arcanos_audit_pg18_20260727` database. Local runs remain
skippable only when the shared sentinel is absent.

`All Checks Complete` now runs under `always()`, receives the exact 11-job
`needs` object, and rejects a missing, unexpected, malformed, skipped,
cancelled, or failed result. The same PR pinned the SDK-scoped Hono dependency
to `4.12.34`, removed obsolete Hono and propagated `@hono/node-server` audit
exceptions, and retained fail-closed dependency-audit policy.

Focused and independent validation passed 27/27 PostgreSQL/aggregate tests,
122/122 audit/MCP transport tests, clean-install and real MCP adapter checks,
type-check, lint, build, documentation, and Railway compatibility. Review found
no remaining P1/P2 issue.

### Exact-head and contained-preview evidence

The exact-head disposable PostgreSQL 18 CI service ran all seven suites and 107
tests successfully. CI/CD run
[`31220350380`](https://github.com/pbjustin/Arcanos/actions/runs/31220350380)
passed all 13 jobs, Security Audit found no actionable issue, and the aggregate
verified all 11 required results. Documentation Audit, PR CI, API tests,
Codecov, Copilot review, and both Railway preview contexts passed. Preview web
and worker readiness returned HTTP 200 with protected effects disabled; that
was contained startup/readiness evidence, while PostgreSQL CI remained
authoritative for database behavior.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [CI/CD Pipeline `31232497743`](https://github.com/pbjustin/Arcanos/actions/runs/31232497743) | Passed all 13 jobs and verified all 11 aggregate dependencies |
| [Documentation Audit `31232497763`](https://github.com/pbjustin/Arcanos/actions/runs/31232497763) | Passed |
| [Repository Registration `31232497741`](https://github.com/pbjustin/Arcanos/actions/runs/31232497741) | Passed |
| [Analyze Documentation Updates `31232497752`](https://github.com/pbjustin/Arcanos/actions/runs/31232497752) | Repeated the known missing-secret auxiliary startup-fixture failure |
| [Railway Auto Deploy `31233063281`](https://github.com/pbjustin/Arcanos/actions/runs/31233063281) | Coordinated-writer hold `20260727-dag-snapshot-generation-v1` passed policy and skipped production job `93040546303` |
| Railway repository-integration status history | The merge separately started 18 web/worker deployments across nine non-production environments; six succeeded and 12 had non-success (failed/stopped) outcomes |

A read-only Railway reconciliation found production still at the 2026-08-02 PR
#1415 generation, with healthy web and paired worker readiness. No #1422
production rollout, database operation, application provider/model call,
live-memory mutation, or provider-configuration change is credited. The
non-production deployment starts remain a lifecycle-cleanup concern.

## PR #1421 — Effective MCP pre-parser body cap

### Exact identity

| Field | Value |
| --- | --- |
| Base | `005938f74878c6ac4f878968e3eb9154c6de6e70` |
| Reviewed head | `b9aa2c30c1bf8881eacdb5a8648f160d92f3e2cb` |
| Merge | `e01b0397a31daf2309f5f418018d0b4116564db4` |
| Reviewed/merged tree | `9fd22faec11bd889882eff8f9e0888cd73b01885` |
| Merge time | `2026-08-07T06:16:36Z` |
| Size | 2 commits; 27 files; +1,542/-39 |

Remote `main` was read back at the exact merge. Its parents are the PR #1420
merge and exact reviewed head; the reviewed and merged trees match.

### Implemented contract and review evidence

The exact `POST /mcp` JSON transport now parses before the broad application
parser and retains the same idempotent parser at the standalone-router seam.
The effective decoded-entity limit is
`min(MCP_HTTP_BODY_LIMIT, JSON_LIMIT, 1,048,576)`. Oversized JSON, including
inflated gzip and chunked bodies without `Content-Length`, returns fixed HTTP
`413` `MCP_REQUEST_TOO_LARGE` JSON with `no-store` and `no-cache` headers before
MCP rate limiting, authentication, transport, or downstream work. Malformed
JSON, non-JSON media, `GET /mcp`, and neighboring routes retain their prior
contracts.

Focused validation passed the 17-test body-cap suite, the separate stricter-
`JSON_LIMIT` assembled-app regression, the four-suite 317-test parser/preview
matrix, all 17 MCP-matching suites with 141 tests, and the 9/9 native-preview
runner contract. Type-check, build, passive Railway validation, lint with zero
errors and 76 existing warnings, and the 306/306 documentation audit passed.
Independent code, test, documentation, and Copilot review found no remaining
P1/P2 issue.

### Exact-head GitHub evidence

| Workflow or context | Result |
| --- | --- |
| [CI/CD Pipeline `31150753631`](https://github.com/pbjustin/Arcanos/actions/runs/31150753631) | Passed all 13 jobs |
| [API Endpoint Tests `31150753599`](https://github.com/pbjustin/Arcanos/actions/runs/31150753599) | Passed |
| [Documentation Audit `31150753604`](https://github.com/pbjustin/Arcanos/actions/runs/31150753604) | Passed |
| [PR CI `31150753653`](https://github.com/pbjustin/Arcanos/actions/runs/31150753653) | Passed |
| Railway web and passive-worker preview contexts | Passed |

### Exact-head contained preview evidence

The native preview environment was
`7eacb652-e52b-486c-bc6d-9a8f4c9c5992`, with web deployment
`30a9e1b8-ff36-4e52-830c-1adb6b0547f3` and passive-worker deployment
`5180f65d-e07d-4335-b326-8120ce90af21`.

The bounded live runner passed 68/68 sequential requests with 21,832 aggregate
response bytes. Its sealed fixture exercised six server-owned, three-chunk
streams without `Content-Length`: exact and one byte over the hard 1 MiB
maximum, a downward 512 KiB MCP setting, and a stricter 256 KiB global JSON
setting. Exact cases reached the synthetic downstream sentinel once; oversized
cases reached it zero times and returned the fixed 413/no-cache contract. Web
and worker readiness hashes remained stable, and the passive worker denied the
fixture route.

This is contained component evidence, not a literal oversized public-wire
upload or proof of normal `/mcp` authentication, compression, slow-upload
handling, or production rollout. Parsing still precedes MCP authentication and
rate limiting; slow-upload timeout handling remains separate.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [Documentation Audit `31153379411`](https://github.com/pbjustin/Arcanos/actions/runs/31153379411) | Passed |
| [Repository Registration `31153379370`](https://github.com/pbjustin/Arcanos/actions/runs/31153379370) | Passed |
| [CI/CD Pipeline `31153379401`](https://github.com/pbjustin/Arcanos/actions/runs/31153379401) | Passed all 13 jobs |
| [Analyze Documentation Updates `31153379354`](https://github.com/pbjustin/Arcanos/actions/runs/31153379354) | Failed because the auxiliary startup fixture omitted required `ARCANOS_JOB_READ_CAPABILITY_SECRET`; the maintained Documentation Audit passed |
| [Railway Auto Deploy `31154244947`](https://github.com/pbjustin/Arcanos/actions/runs/31154244947) | Coordinated-writer hold `20260727-dag-snapshot-generation-v1` passed policy and skipped production job `92790223400` |
| Railway repository-integration status history | The merge independently started 18 service deployments across nine non-production environment IDs, ending with six successes and 12 failures; none targeted the last verified production or #1421 preview environment, and status history does not prove current lifecycle state or cleanup |

No production rollout, database operation, application provider/model call,
live-memory mutation, or provider-configuration change is credited to PR
#1421. The repository-integration deployment starts remain external provider
mutations and a lifecycle-cleanup concern.

## PR #1420 — Research aggregate budget and cancellation

### Exact identity

| Field | Value |
| --- | --- |
| Base | `8c25df850ae5db7b99e3a01afa72e2d0cf1ca752` |
| Reviewed head | `69a817e6e54356b57dfee594385324d5568d7c7f` |
| Merge | `005938f74878c6ac4f878968e3eb9154c6de6e70` |
| Reviewed/merged tree | `1462f37965e92e4aa7a58415ab5306b2c4351cf1` |
| Merge time | `2026-08-07T00:46:28Z` |
| Size | 5 commits; 64 files; +5,781/-324 |

Remote `main` was read back at the exact merge. The merge parents are the PR
#1419 merge and the exact reviewed head; the reviewed and merged trees match.

### Implemented contract

The slice uses one bounded `ResearchWorkflowContext` across every Research
entrypoint and convergence seam. It covers direct commands, SDK, canonical GPT,
dispatch, legacy compatibility, MCP, GPT Access, module/hub execution,
DNS/fetch, each Trinity/provider stage, and deterministic persistence.

Cancellation prevents later-stage admission and optional side effects, removes
cancelled Trinity waiters, recovers permits across admission races, keeps
caller/deadline cancellation breaker-neutral, and waits for admitted
cooperative work to drain before settlement. Real socket-disconnect tests cover
the universal and legacy route boundaries with mocked provider/database seams.
Durable queued jobs retain their own cancellation ownership after admission.

### Local and independent review evidence

- Focused integrated regression: 9 suites, 178/178 tests.
- Randomized breaker/Trinity/ingress regression: five seeds, each 69/69.
- `npm run type-check`, `npm run build`, passive `npm run validate:railway`,
  generated-index checks, and `git diff --check`: passed.
- `npm run lint`: zero errors and 76 inherited warnings.
- `npm run docs:check`: 311/311.
- Full Windows root run: 595 suites and 7,815 tests passed, plus one unchanged,
  explicitly excluded GPT-OSS CRLF-sensitive migration-guard failure.
- Independent code, test, and documentation reviews found no remaining
  actionable issue after the final corrections.

### Exact-head GitHub evidence

After an acknowledged GitHub Actions incident delayed webhook workflows, the PR
was reopened without changing its head to emit genuine `pull_request` events.
The authoritative rerun completed successfully:

| Workflow or context | Result |
| --- | --- |
| [CI/CD Pipeline `31132133985`](https://github.com/pbjustin/Arcanos/actions/runs/31132133985) | All surfaced jobs passed, including security, lint/type, PostgreSQL/concurrency, sandbox, build, unit, integration, Redis, convergence, Python, Railway compatibility, deployment readiness, and aggregate completion |
| [PR CI `31132134182`](https://github.com/pbjustin/Arcanos/actions/runs/31132134182) | Passed |
| [API Endpoint Tests `31132133921`](https://github.com/pbjustin/Arcanos/actions/runs/31132133921) | Passed |
| [Documentation Audit `31132134031`](https://github.com/pbjustin/Arcanos/actions/runs/31132134031) | Passed |
| Approval-policy check (`No approval required for this PR by policy`), worker-diagnostics cleanup, and Codecov patch | Passed |
| Railway web and passive-worker preview contexts | Passed |

Manual-dispatch queue cancellations and event-mode gitleaks output from the
incident window are superseded by these valid PR-context results.

### Exact-head contained preview evidence

The recreated native preview environment was
`6d2727b1-7271-46c3-a168-fcacaa34638b`, with web deployment
`5476776e-1b5c-46d2-8fce-cfb39ed00097` and worker deployment
`21ff3626-9820-4bd2-a23a-d0d439af3a1f`.

The bounded dry run first verified the canonical repository, PR number, clean
matching local head, target hosts, and 66-request plan without network. The
authorized live runner then passed 66/66 requests with exact served-commit
identity and readiness before and after the exercise. The
`research-workflow-cancellation-drain` case returned SHA-256
`31f89d1c6f289dd6a845ef7bd1a5a9043abd9f37fc04cc232ff1bacf8558d63d`.

The fixture is sealed synthetic component proof. Its parent-abort cases are
disconnect-equivalent signal propagation, not literal TCP disconnects. It did
not invoke the normal Research route, confirmation, external DNS, a provider or
model, PostgreSQL, memory, production persistence, or a production effect.

### Exact-merge and rollout evidence

| Evidence | Result |
| --- | --- |
| [Documentation Audit `31135804039`](https://github.com/pbjustin/Arcanos/actions/runs/31135804039) | Passed |
| [Repository Registration `31135803968`](https://github.com/pbjustin/Arcanos/actions/runs/31135803968) | Passed |
| [CI/CD Pipeline `31135803979`](https://github.com/pbjustin/Arcanos/actions/runs/31135803979) | Passed all 13 jobs, including the final deployment-readiness and aggregate gates |
| [Analyze Documentation Updates `31135803993`](https://github.com/pbjustin/Arcanos/actions/runs/31135803993) | Failed because the auxiliary production-mode startup fixture omitted required `ARCANOS_JOB_READ_CAPABILITY_SECRET`; this repeats the known workflow-fixture defect |
| [Railway Auto Deploy `31136626908`](https://github.com/pbjustin/Arcanos/actions/runs/31136626908) | Coordinated DAG writer rollout policy passed; `Deploy Production (Railway)` was skipped because hold `20260727-dag-snapshot-generation-v1` remained active |
| Railway repository-integration status history | The merge independently started 18 service deployments across nine environment IDs; final status was six successes and 12 failures. None targeted the last verified production environment `fb583147-6c39-4343-9267-500f357d25ab` or #1420 preview environment `6d2727b1-7271-46c3-a168-fcacaa34638b`; surfaced success names included `arcanos-pr-1320`, `test-probe-delete-me`, `phase2d-validation-20260717`, `gaming-discovery-27071b86`, and `gaming-rag-generic-20260709`. Commit-status history does not establish every environment's name or current provider state |

The coordinated-writer hold governed the workflow-owned production job, not
every Railway repository-connected environment. No deployment to the last
verified production target, database operation, application AI/search-provider
or model call, live-memory mutation, or Railway/provider configuration change
is recorded or credited to PR #1420, but the 18 other service-deployment starts
are external provider mutations and remain a lifecycle-cleanup concern.

## Intermediate delivery evidence

### PR #1414 — provider admission, DAG dispatch, and GPT metric boundaries

| Field | Value |
| --- | --- |
| Base | `c7ceffd8fbd3f3e944f106e8ba1df0bf34c9ea2d` |
| Reviewed head | `b4c1ac2eead277aa7130b55bcac329d5c787bc10` |
| Merge | `762322174ee67648bf95dd74d9473915764f7a7e` |
| Reviewed/merged tree | `8a3120305628460a9f456645b688dee76690d65b` |
| Merge time and size | `2026-08-01T16:51:28Z`; 6 commits; 76 files; +8,725/-307 |

The final full Node run passed 572 suites and 7,224 tests, with five suites and
39 tests skipped; the disposable real-Redis regression passed 14/14. The
exact-head native preview passed 50/50 requests and proved served-head,
web/passive-worker, and credential-empty containment, but did not expose real
provider ingress. Exact-merge
[CI/CD `30709061674`](https://github.com/pbjustin/Arcanos/actions/runs/30709061674)
passed all 13 jobs. Railway rollout run
[`30709586713`](https://github.com/pbjustin/Arcanos/actions/runs/30709586713)
passed policy and skipped its production job under hold
`20260727-dag-snapshot-generation-v1`. Final review was green; no production
credit is inferred. The auxiliary documentation-analysis fixture defect was
already present separately.

### PR #1415 — worker-budget accounting and bounded stale recovery

| Field | Value |
| --- | --- |
| Base | `762322174ee67648bf95dd74d9473915764f7a7e` |
| Reviewed head | `4269ef96343b39db1c96c31c168268af2219f345` |
| Merge | `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8` |
| Reviewed/merged tree | `da760f8f2a23ec45bf21024e766ef070feaa2f50` |
| Merge time and size | `2026-08-02T09:00:56Z`; 5 commits; 34 files; +2,547/-38 |

All 20 surfaced final-head PR contexts passed. The isolated PostgreSQL 18.4
preview at intermediate head `c7bb98bcc2cc869f1bc80c9d0cd2bdb9c376db87`
ran migration phases 1–4 twice, exercised the canonical two-slot worker,
claimed eight jobs while leaving the ninth unclaimed at budget, and proved
bounded stale recovery 2/2/1. It made no provider or GPT-OSS call. Because that
live SQL/worker proof predates the reviewed final head, it is supporting rather
than exact-final-head evidence. Exact-merge
[CI/CD `30740913419`](https://github.com/pbjustin/Arcanos/actions/runs/30740913419)
passed all 13 jobs. Railway rollout run
[`30741382286`](https://github.com/pbjustin/Arcanos/actions/runs/30741382286)
passed policy and skipped its production job under the coordinated-writer hold.

#### 2026-08-02 authorized production reconciliation

| Evidence | Bounded attestation |
| --- | --- |
| Exact target | Railway project `7faf44e5-519c-4e73-8d7a-da9f389e6187`; production environment `fb583147-6c39-4343-9267-500f357d25ab`; web `c4ade025-3f13-4fca-9309-5d0dd81396fe`; worker `1765befb-b805-4051-9af9-28634e986886`; PostgreSQL `6647b5b1-d796-4783-b5f0-b8e356019ca6`; Redis `81e4a1cf-7ae4-48bf-8321-23641bb23c0e` |
| Source | Merge `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8`, tree `da760f8f2a23ec45bf21024e766ef070feaa2f50` |
| Backup | `373deae3-c717-4557-80b2-1930710cffe6`, `pre-8bb0b803-20260802`, created `2026-08-02T19:40:39.209Z`; present at final observation, restore not tested |
| Database | Applied `20260727_job_claim_generation_v1.sql`, `20260727_dag_run_snapshot_generation_v1.sql`, and worker-stats phases 01–04; final catalog, primary role, and restored original HBA policy were verified |
| Final web | Deployment `147279ab-faa7-45a6-8c70-404ed2a1a9c9`, `SUCCESS`, exact commit, image `sha256:b35df38cde98c2ac28ec9ba2f30a1b5ae7a4bf356a8e3450f8b322b6e886b58f` |
| Final worker | Deployment `bdf7cbb8-e5ab-460b-a424-a0204fe6fb23`, `SUCCESS`, exact archived source tree, image `sha256:c19f0ed15378bec0cf4ca1ee69788f2d5cb23d2ee57c1cf4866ab74efa8dbd80`; Railway recorded no worker `commitHash`, so provenance is archive/tree-bounded |
| Credential containment | A database credential exposed in private tool output was rotated; new public-TCP authentication and both fresh application deployments proved the replacement. A negative old-password check was not recorded |
| Final live checks | On 2026-08-02, `/readyz`, `/health`, missing-job status, and missing-job result passed; bounded web/worker logs showed successful database connection and readiness/bootstrap evidence |

This production credit ends at the #1415 generation and only covers the named
target and observed contracts. Backup restorability, lifetime log absence,
unobserved paths, and later source were not proved. The coordinated-writer hold
remained active.

### PR #1416 — Backstage mutation authorization and admission

| Field | Value |
| --- | --- |
| Base | `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8` |
| Reviewed head | `67bcb5b8ec426d6f43c61a368f2c56384c76399e` |
| Merge | `5a5bb92672a06ec330a4a04131cfc3755c0b34a3` |
| Reviewed/merged tree | `92d5b6e82dd9095955d1944bfcb19ea1c85122e8` |
| Merge time and size | `2026-08-03T05:24:11Z`; 4 commits; 35 files; +2,652/-165 |

Focused validation passed 134 tests and both exact-head full suites passed.
Both exact-head Railway preview contexts succeeded, but the contained preview
did not expose live Backstage handlers; it proved deployment, served commit,
readiness, and pre-parser rejection only. Exact-merge
[CI/CD `30787066940`](https://github.com/pbjustin/Arcanos/actions/runs/30787066940)
passed all 13 jobs. Railway rollout run
[`30787707059`](https://github.com/pbjustin/Arcanos/actions/runs/30787707059)
passed policy and skipped its production job under the hold. The auxiliary
documentation-analysis fixture failed for the known missing secret. No
production rollout is credited.

### PR #1417 — Backstage roster containment and atomicity

| Field | Value |
| --- | --- |
| Base | `5a5bb92672a06ec330a4a04131cfc3755c0b34a3` |
| Reviewed head | `01f7c88911f6de0bd8ea0017221b374da2ff880e` |
| Merge | `277857efed1f9aa41f724558d2f29512b65bf5a1` |
| Reviewed/merged tree | `2d7cfcec47f45b19c5bc72b3e0defee2f697c58f` |
| Merge time and size | `2026-08-04T02:00:22Z`; 7 commits; 57 files; +5,923/-249 |

Local review passed 52/52 focused Jest tests, 74/74 pytest tests, 145/145
audit/workflow Jest tests, documentation 311/311, type, lint, build, and
contract checks. The authorized isolated-PostgreSQL preview passed 80 Python
and 17 TypeScript CLI cases plus the real Backstage HTTP/SQL exercise,
including concurrent writers, revision fencing, NUL rejection, and zero-total
behavior. Required native web/worker preview contexts passed; one stale
external deleted-verifier status failed but was nonrequired. Exact-merge
[CI/CD `30870474740`](https://github.com/pbjustin/Arcanos/actions/runs/30870474740)
passed all 13 jobs. Railway rollout run
[`30871096102`](https://github.com/pbjustin/Arcanos/actions/runs/30871096102)
passed policy and skipped its production job under the hold. No production
rollout is credited. This slice introduced the temporary npm-audit exception
that must be re-reviewed by 2026-08-10.

## Recent predecessor evidence

### PR #1418

Reviewed head `15451ed48185cef0d0c40acc706def57f133de65` merged as
`00bab421a86fcc3c148052595f9717bdc32f467a`. It established the shared
pre-normalization Research bounds—topic 500 JavaScript `String.length` units,
10 supplied URL slots, 2,048 `String.length` units per URL, 16,384 aggregate
`String.length` units—and the 97-byte deterministic portable storage component.
Exact-merge
[CI/CD `30978894009`](https://github.com/pbjustin/Arcanos/actions/runs/30978894009)
passed all 13 jobs. Railway rollout policy run
[`30979698973`](https://github.com/pbjustin/Arcanos/actions/runs/30979698973)
enforced the coordinated-writer hold and skipped production deployment.

### PR #1419

Reviewed head `fe80168dbe072f851a7fbd587fb54a9a763026b3` merged as
`8c25df850ae5db7b99e3a01afa72e2d0cf1ca752`. It established 16,384-byte
story beats, newest-100 retention, newest-25 chronological responses, atomic
PostgreSQL sequencing/pruning, mixed-writer fencing, and fail-closed ambiguous
commit handling. Exact-merge
[CI/CD `31057634892`](https://github.com/pbjustin/Arcanos/actions/runs/31057634892)
passed all 13 jobs. Railway rollout policy run
[`31058416025`](https://github.com/pbjustin/Arcanos/actions/runs/31058416025)
enforced the same hold and skipped production deployment.

### Last production-verified generation

The bounded 2026-08-02 production reconciliation verified the PR #1415 source
generation `8bb0b80350d39a663c5dde0eefd81abfe27e4bf8`, its required database
contracts, healthy web/worker roles, restored database access policy, and
rotated database credential. It did not test backup restoration and cannot be
projected onto PRs #1416–#1423.

## Historical evidence

The former 4,950-line tracked report is retained unchanged apart from its
archive banner in
[history-through-2026-07-31.md](history-through-2026-07-31.md). It contains
the original capture, intermediate findings, red characterization, superseded
queues, PR #1408–#1413 detail, and the initial PR #1414 composition record.
The compact dossiers above preserve the August #1414–#1423 delivery and
production-reconciliation evidence without restoring chronological sprawl.
Historical present-tense claims must not override this ledger.

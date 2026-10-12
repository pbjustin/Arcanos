# Railway preview evidence

Date: 2026-10-12. PR:
[#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Initial remote head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.
Base: `3fd305b37ba410cf21684a8fed7619a1ba180b48`.
Branch: `codex/targeted-security-healing-20261012`; draft: false;
state: open; preview opt-in label absent.

**PREVIEW_ENVIRONMENT_MATCHED: BLOCKED. PREVIEW_ISOLATION_VERIFIED: BLOCKED.
LIVE_PREVIEW_ACCEPTANCE: BLOCKED.**

## Read-only discovery and exact-head lock

GitHub PR metadata and Railway project/environment/service/deployment inventory
were read through authenticated control-plane tools. No environment values,
secrets, production deployment logs, production runtime endpoints, databases or
queues were accessed. Production access was limited to identity metadata in
project inventory; that environment was excluded from deployment inspection
and testing.

The maintained lifecycle contract at
`scripts/railway-pr-preview-lifecycle.mjs` declares the following target:

| Identity | Value | Evidence / disposition |
| --- | --- | --- |
| Workspace | `1c9265a3-986f-4304-ad3e-5a874caab039` | Lifecycle contract. |
| Expected project | `7faf44e5-519c-4e73-8d7a-da9f389e6187` (`Arcanos`) | Present in authenticated Railway inventory. |
| Expected PR environment | `pr-676861-1539` | Absent from that project's environment inventory; no environment ID can be recorded. |
| Preview base | `8d5594c5-075e-4ad5-8fad-9e6e0866032d` (`pr-preview-base-20260812`) | Present; template/base is not an owned PR deployment. Not tested. |
| Contract web service | `c4ade025-3f13-4fca-9309-5d0dd81396fe` (`ARCANOS V2`) | Project service definition present; no matched PR environment service instance/deployment. |
| Contract worker service | `1765befb-b805-4051-9af9-28634e986886` (`ARCANOS Worker`) | Project service definition present; no matched PR environment service instance/deployment. |
| Excluded production environment | `fb583147-6c39-4343-9267-500f357d25ab` | Name/id seen in inventory only; no test or configuration mutation. |
| Matched PR deployment IDs/statuses | None | No exact-head deployment identified; genuine preview execution prohibited. |

The lifecycle admits open, same-repository, non-draft `main` PRs only with
`railway-preview`. This PR has no such label. Its lifecycle no-op/green workflow
and skipped E2E job are not deployment or runtime evidence. No label was added,
workflow dispatched, environment created, service restarted or redeployed.

Initial-head check receipts: [exact-head supplemental job (skipped)](https://github.com/pbjustin/Arcanos/actions/runs/38203123337/job/114660653773),
[latest lifecycle reconciliation](https://github.com/pbjustin/Arcanos/actions/runs/38204741359/job/114665614068)
and [sealed E2E (skipped)](https://github.com/pbjustin/Arcanos/actions/runs/38204741359/job/114665675622).
Their recorded conclusions and URLs are retained in JSON; there is no executed
E2E receipt or controller/runtime log transcript for this PR.

## Other discovered non-production candidates

These identities were examined solely to reject incorrect association. They
were not adopted, reconfigured, queried as runtimes or fault-injected.

| Candidate | Identity | Result |
| --- | --- | --- |
| Arcanos live-validation environment | `8048969f-07d0-48bd-bc0a-3f07ccbb26d1` | Unrelated environment, not PR #1539. |
| Validation service | `530c6dcf-bb15-4b46-babc-cf00e22b76cf` | Different service from contract roles. |
| Successful validation deployment | `6bb89f16-37b0-48d7-bf9a-ba4076957ca5` | `SUCCESS`, created `2026-10-07T01:25:25.164Z`, updated `2026-10-07T01:41:29.887Z`. |
| Deployment commit/branch | `cfb735d034854d20b85671c74aef533e8e53f728`, `fix/gaming-clear-audit-runtime-budget` | Does not match PR head or branch; success cannot establish current PR acceptance. |
| Other preview environment names | `Arcanos-pr-1433`, `Arcanos-pr-1432` | Different PRs; not tested. |
| Second accessible project | `8e4cb1eb-1441-4e83-b434-15c06c676a5f` (`Arcanos Live PR 1527`) | Different PR; not tested. |
| Second project's environment | `9ca4ff39-612f-4a89-9101-0d98c5f5e5e4` (`live-pr-1527`) | Deployment inventory returned empty. |
| Second project's services | supervisor `625cb884-088a-45da-ac27-4a5e9c00e017`; runtime `261ef14c-3c2a-4f26-ab4e-bd692e4fb201` | Not PR #1539 services. |

Older validation deployment statuses and SHAs, plus sanitized inventories, are
preserved in [machine-readable evidence](self-healing-evidence.json). No
arbitrary latest successful deployment was treated as an exact-head preview.

## Isolation checklist before faults

| Requirement | Result | Reason |
| --- | --- | --- |
| Exact PR-head deployment | BLOCKED | Owned environment absent; unrelated successful deployment has a different SHA. |
| Separate PR service identities | BLOCKED | Contract roles known, but no owned environment instances/deployments. |
| Preview-only variables and credentials | BLOCKED | No matched target; values were not inspected. |
| No production database writes | BLOCKED | Live target could not be attested; no database was contacted by acceptance execution. |
| No production Redis mutations | BLOCKED | Live target could not be attested; no Redis fault/mutation was executed. |
| No shared production queues | BLOCKED | No matched target on which to verify queues; active live workers not started. |
| No production webhooks/external effects | BLOCKED | No matched target; runtime/model/webhook calls not executed. |
| No unauthorized billable model calls | PASS | Local provider transcripts are synthetic loopback HTTP; live model execution NOT_RUN. |
| No production secret access | PASS | Discovery used identity metadata only; no production values were read. |
| Live workflow safe to execute | BLOCKED | Exact-head identity and isolation prerequisites are unavailable. |

The stop condition was honored: dependent live work stopped immediately. The
explicitly authorized local/mocked fallback continued without using production
as a substitute.

## Controller and runtime-consumer evidence

Genuine Railway baseline, detection, incident creation, authorization, command
application, consumer behavior change, recovery, rollback and return-to-baseline
were **NOT_RUN**. There are no live incident IDs, execution IDs, request IDs or
controller/consumer log excerpts to attach. The implementation's diagnosis
`incidentKey` is a type, not a unique durable incident identity. No identifier
was invented or inferred from an unrelated deployment.

Local fixture assertions and sanitized event excerpts belong in the regression
report and JSON. Synthetic clock/request IDs are labeled local and cannot be
correlated to a Railway service/deployment. A selected action, successful
receipt or HTTP response alone is not treated as recovery proof.

## Required next live run

Before any live fault, establish an authorized normal-runtime preview for this
PR, its exact final head, environment-owned web/controller/worker identities,
preview-only credentials and isolated disposable storage/queues. The standard
sealed preview fixture serves pure contracts with a passive worker; even if
deployed, it cannot establish the genuine self-healing workflow by itself.
Refresh the PR head and independently attest each service's active successful
deployment SHA. Any head or ownership change invalidates prior acceptance.
Only then execute contained faults and correlate controller and actual
consumer evidence through recovery and mitigation clearing.

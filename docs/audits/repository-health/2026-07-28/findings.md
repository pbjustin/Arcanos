# Repository health-audit finding register

Last reconciled: 2026-08-08 UTC, after PR #1423 merged and the protected-digest
local candidate was implemented

This register distinguishes source closure from deployment and production
verification. `Merged` never means `deployed`. Current source and tests remain
authoritative. GPT-OSS is explicitly excluded from the active non-GPT queue.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Open | No accepted current-main implementation closes the finding |
| Local candidate | A current-base working-tree implementation exists but is not yet published, reviewed in CI, or merged |
| Local-only | A historical isolated candidate exists but must be re-integrated and revalidated on current `main` |
| Closed in merged source | The reviewed correction is present on `main`; production rollout is a separate state |
| Production-verified | Exact deployed revision and the relevant live contract were attested within a dated authorized operation |
| Deferred | Intentionally outside the active queue |

## Active findings

The order here matches the current queue in [progress.md](progress.md#active-implementation-queue).

| Order | Finding | Priority | Status | Current evidence | Next action |
| --- | --- | --- | --- | --- | --- |
| 1 | Protected-digest generation and pre-cutover comparison | Older ranked | Local candidate | A current-#1423-base working tree shares the versioned runtime digest, covers all seven manifest candidates, and automatically gates the six runtime-owned pins at normal startup; focused Node 20 checks pass and no commit, PR, or deployment exists | Publish for exact-head review and required CI, then merge before moving this finding to closed source |
| 2 | Successful non-GPT terminal retention | Older ranked | Local-only | An isolated candidate passed focused checks on an older base and was not published | Re-integrate on current `main` and rerun the required database suites |
| 3 | Predictive/reactive self-heal approval | Older ranked | Local-only | An isolated explicit-approval candidate exists on an older base and was not published | Re-integrate on current `main` and prove predictive paths cannot perform unapproved effects |
| 4 | Hard versus advisory worker-budget semantics | Older ranked | Open | Worker identity/accounting is merged, but enforcement meaning is not ratified consistently | Decide the product contract, implement at the owner seam, and align readiness/diagnostics |
| 5a | `SEC-DISPATCH-QUOTA-ORDER-001` — oversized `/dispatch` GPT ID consumes admission first | P2 | Open | GPT-lane provider admission still precedes the later canonical identifier-length rejection | Move deterministic rejection before admission and prove no quota consumption in ready, exhausted, and unavailable-store states |
| 5b | `SEC-PARSER-ADMISSION-001` broader pre-admission parsing | P2 | Open | The global JSON parser still precedes `/dispatch` DAG authentication and public-provider admission | Characterize and introduce bounded selector/route parsing without changing unrelated contracts |
| 5c | `OBS-MODEL-CARDINALITY-001` — generic AI model metric label | P2 | Open | Generic AI metrics still accept normalized caller-selected model values, including the public Vision path | Map models to a finite registry/constant identity and add a high-cardinality regression |
| 5d | `OBS-GPT-LOG-CARDINALITY-001` — caller-controlled GPT log values | P2 conditional | Open | Unknown route IDs and forbidden body-level `gptId` values can still become distinct structured log values | Log route templates and finite identities/length metadata, never the raw value |
| 5e | `RATE-POLICY-EPOCH-001` — mixed-replica counter policy | P2 conditional | Open | Shared Redis counters do not carry a verified policy fingerprint/epoch | Atomically bind policy identity and fail readiness on mismatch |
| 5f | `RATE-COUNTER-INTEGRITY-001` — corrupt counter recovery truth | P2 conditional | Open | A fresh capability probe can recover while the original corrupt counter remains | Separate command capability from counter integrity and require exact repair or coordinated epoch change |
| 5g | `TEST-REDIS-CAPABILITY-001` — exact readiness probe | P2 | Open | The deployment-critical probe is mocked rather than exercised by the disposable real-Redis suite | Invoke the real probe against disposable Redis and assert success, expiry, and cleanup |
| 5h | `SEC-DIAGNOSTICS-002` — public liveness minimization | P2 | Open | Public `/health` and `/healthz` still intentionally use a richer projection than minimal liveness requires | Move detail behind operator controls and retain a fixed bounded public projection |
| 5i | Request-path sanitizer pre-decode bound | P3 | Open | Encoded GPT segments are decoded before the decoded-length check | Reject an already oversized raw segment before decoding while preserving the invalid placeholder |
| 5j | Localized architecture, scale, warning, and cleanup backlog | P2/P3 | Open | Named seams remain; no repository-wide cycle regression is present | Continue shadow MCP registry, ActionPlan transport duplication, measured stale-recovery/worker-discovery/index planning, GPT Access contract extraction, provider-option/Trinity limits, then behavior-preserving warning or excluded-test cleanup |

## Closed in merged source

| Finding family | Closure | Merged evidence | Production state |
| --- | --- | --- | --- |
| Dependency cycles and cross-layer ownership | Frozen validated catalogs, composition providers, dependency-neutral contracts, and executable Madge/CEF gates | PR #1409 | Deployment state must be read independently |
| Scoped #1409 credential, filesystem/process, control-plane ingress, and disclosure findings | Purpose/scope-bound credentials, the specific protected pre-parser policies delivered in that PR, bounded public errors, redaction, CORS, and path/process containment | PR #1409 | Later parser, logging, and public-health residuals remain separately open; deployment state must be read independently |
| Expired dependency-waiver removal | Patched compatible graphs, strict audit policy, Python suppression removal, and Node 20 floor | PR #1410 | Dated audit evidence only; the later temporary exception has its own 2026-08-10 deadline |
| Memory-plane request containment | Forward fix plus contained live preview evidence | PR #1411 | No later production credit inferred |
| Public worker diagnostics and generic-job read/cache behavior | Minimized aggregate public worker status/health projections; capability/auth-protected failed-job and operator detail plus generic-job reads; bounded/no-store responses, cache containment, and preview/cleanup automation | PRs #1412–#1413 | Rich public application liveness remains a separate open finding; no later production credit inferred |
| `/dispatch` DAG boundary, public-provider ceiling, and canonical `/gpt` identifier/metric identity | Shared DAG/provider admission plus finite canonical-route identities | PR #1414 | `/dispatch` GPT identifier rejection still follows provider admission; see open finding 5a. Production was later reconciled through #1415 only |
| Worker-budget identity and stale-recovery batching | Stable stats worker identity and bounded stale recovery | PR #1415 | Production-verified in the bounded 2026-08-02 reconciliation |
| Backstage mutation authorization/admission | Principal/body/action/path-bound confirmation and execution-time admission across aliases and queued work | PR #1416 | No production rollout credited |
| Backstage roster validation, serialization, atomicity, and fresh publication | Typed bounds, duplicate/NUL rejection, one serialized transaction, fresh reads, and revision fencing | PR #1417 | No production rollout credited |
| `SEC-RESEARCH-WORK-AMPLIFICATION-001` input/storage portion | Shared pre-normalization topic/URL/item/aggregate bounds and a deterministic portable storage component | PR #1418 | No production rollout credited |
| Backstage storyline lifecycle | 16,384-byte beats, newest-100 retention, newest-25 chronological response, transactional sequencing/pruning, and ambiguous-commit handling | PR #1419 | No production rollout credited |
| `SEC-RESEARCH-WORK-AMPLIFICATION-001` aggregate-execution portion | One deadline/signal through every Research seam, cancellation-aware Trinity admission, no new work after abort, and drained outward settlement | PR #1420 | No production rollout credited |
| `SEC-PARSER-ADMISSION-001` MCP subfinding — effective MCP body cap | Exact `POST /mcp` decoded JSON is parsed before the broad application parser at the strictest of the hard 1 MiB maximum, `MCP_HTTP_BODY_LIMIT`, and `JSON_LIMIT`; oversized bodies receive fixed non-cacheable HTTP 413 before downstream MCP work | PR #1421 | No production rollout credited; broader `/dispatch` pre-admission parsing remains open finding 5b |
| PostgreSQL command and aggregate CI truth plus compatible Hono remediation | One exact required-database sentinel across all seven suites, purpose-specific disposable loopback targets, and an always-running aggregate that accepts only the exact required job set with every result `success`; Hono pinned to `4.12.34` and obsolete Hono/`@hono/node-server` audit exceptions retired | PR #1422 | No production rollout credited |
| Node/backend `config.limits.requestTimeout` (`REQUEST_TIMEOUT`) truth | Removed the parsed-but-unused Node setting and its millisecond-valued backend claims; preserved the Python daemon's distinct live seconds-valued timeout controls without inventing a server property or response-only race | PR #1423 | No production rollout credited |

## Time-bounded and operational follow-ups

| Follow-up | State |
| --- | --- |
| Auxiliary Analyze Documentation Updates startup fixture lacks `ARCANOS_JOB_READ_CAPABILITY_SECRET` | Open workflow-fixture defect; maintained Documentation Audit is green |
| Temporary npm-audit platform-profile exception | Re-review/remove by 2026-08-10; silent extension is not authorized |
| Coordinated-writer rollout hold `20260727-dag-snapshot-generation-v1` | Remains material until a separately authorized, freshly verified promotion |
| Production topology, old replicas, retained jobs, drain rehearsal, edge controls, log retention, and stale non-production environments | Dated unknowns until reverified. The #1420–#1423 merge status histories each record 18 Railway repository-integration service deployments across nine non-production environment IDs outside the last verified production and the corresponding preview target; each ended with six successes and 12 non-success (failed/stopped) outcomes. Status history does not prove current provider state or cleanup |
| Preview teardown | The #1422 preview was previously read back as deleted. A read-only 2026-08-08 Railway project inventory did not contain #1423 preview `b9067c39-49b8-49f6-bffe-148e5b2de058`; that attests environment absence, not cleanup of every historical deployment or artifact |

## Deferred program

GPT-OSS remains a separate production-NO-GO product program. Its router,
training governance, evidence integrity, operator privacy, private serving,
final-gate, coordination, and Windows CRLF test findings are not part of the
active queue above and are not closed by backend PRs #1408–#1423.

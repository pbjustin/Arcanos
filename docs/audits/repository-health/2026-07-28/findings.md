# Repository health-audit finding register

Last reconciled: 2026-08-12 UTC, after audit-scoped product PR #1432,
delivery-control PRs #1428–#1430, and documentation-only PR #1431 merged and
delivery-maintenance PR #1433 reached reviewed implementation commit
`63c31baa1bff8d7e1d21035214168012a1e860e7`. #1433 remains unmerged; exact
#1432 remains unpromoted and the exact #1431 production pair remains active

This register distinguishes source closure from deployment and production
verification. `Merged` never means `deployed`. Current source and tests remain
authoritative. GPT-OSS is explicitly excluded from the active non-GPT queue.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Open | No accepted current-main implementation closes the finding |
| Local candidate | A current-base working-tree implementation exists but is not yet published, reviewed in CI, or merged |
| Draft PR | A published candidate identity exists, but exact-head review, required CI, and merge are not complete |
| Reviewed PR | A named implementation commit has complete review, required CI, and bounded preview evidence, but merge remains open and live exact-head state still governs merge |
| Local-only | A historical isolated candidate exists but must be re-integrated and revalidated on current `main` |
| Closed in merged source | The reviewed correction is present on `main`; production rollout is a separate state |
| Production-verified | Exact deployed revision and the relevant live contract were attested within a dated authorized operation |
| Deferred | Intentionally outside the active queue |

## Active findings

The order here matches the current queue in [progress.md](progress.md#active-implementation-queue).

| Order | Finding | Priority | Status | Current evidence | Next action |
| --- | --- | --- | --- | --- | --- |
| 1 | Hard versus advisory worker-budget semantics | Older ranked | Open | Worker identity/accounting is merged, but enforcement meaning is not ratified consistently | Decide the product contract, implement at the owner seam, and align readiness/diagnostics |
| 2 | `SEC-DISPATCH-QUOTA-ORDER-001` — oversized `/dispatch` GPT ID consumes admission first | P2 | Open | GPT-lane provider admission still precedes the later canonical identifier-length rejection | Move deterministic rejection before admission and prove no quota consumption in ready, exhausted, and unavailable-store states |
| 3 | `SEC-PARSER-ADMISSION-001` broader pre-admission parsing | P2 | Open | The global JSON parser still precedes `/dispatch` DAG authentication and public-provider admission | Characterize and introduce bounded selector/route parsing without changing unrelated contracts |
| 4a | `OBS-MODEL-CARDINALITY-001` — generic AI model metric label | P2 | Open | Generic AI metrics still accept normalized caller-selected model values, including the public Vision path | Map models to a finite registry/constant identity and add a high-cardinality regression |
| 4b | `OBS-GPT-LOG-CARDINALITY-001` — caller-controlled GPT log values | P2 conditional | Open | Unknown route IDs and forbidden body-level `gptId` values can still become distinct structured log values | Log route templates and finite identities/length metadata, never the raw value |
| 4c | `RATE-POLICY-EPOCH-001` — mixed-replica counter policy | P2 conditional | Open | Shared Redis counters do not carry a verified policy fingerprint/epoch | Atomically bind policy identity and fail readiness on mismatch |
| 4d | `RATE-COUNTER-INTEGRITY-001` — corrupt counter recovery truth | P2 conditional | Open | A fresh capability probe can recover while the original corrupt counter remains | Separate command capability from counter integrity and require exact repair or coordinated epoch change |
| 4e | `TEST-REDIS-CAPABILITY-001` — exact readiness probe | P2 | Open | The deployment-critical probe is mocked rather than exercised by the disposable real-Redis suite | Invoke the real probe against disposable Redis and assert success, expiry, and cleanup |
| 4f | `SEC-DIAGNOSTICS-002` — public liveness minimization | P2 | Open | Public `/health` and `/healthz` still intentionally use a richer projection than minimal liveness requires | Move detail behind operator controls and retain a fixed bounded public projection |
| 4g | Request-path sanitizer pre-decode bound | P3 | Open | Encoded GPT segments are decoded before the decoded-length check | Reject an already oversized raw segment before decoding while preserving the invalid placeholder |
| 4h | Localized architecture, scale, warning, and cleanup backlog | P2/P3 | Open | Named seams remain; no repository-wide cycle regression is present | Continue shadow MCP registry, ActionPlan transport duplication, measured stale-recovery/worker-discovery/index planning, GPT Access contract extraction, provider-option/Trinity limits, then behavior-preserving warning or excluded-test cleanup |

## Closed in merged source

| Finding family | Closure | Merged evidence | Production state |
| --- | --- | --- | --- |
| Dependency cycles and cross-layer ownership | Frozen validated catalogs, composition providers, dependency-neutral contracts, and executable Madge/CEF gates | PR #1409 | Deployment state must be read independently |
| Scoped #1409 credential, filesystem/process, control-plane ingress, and disclosure findings | Purpose/scope-bound credentials, the specific protected pre-parser policies delivered in that PR, bounded public errors, redaction, CORS, and path/process containment | PR #1409 | Later parser, logging, and public-health residuals remain separately open; deployment state must be read independently |
| Expired dependency-waiver removal | Patched compatible graphs, strict audit policy, Python suppression removal, and Node 20 floor | PR #1410 | Dated audit evidence only; the later temporary exception has its own 2026-08-10 deadline |
| Memory-plane request containment | Forward fix plus contained live preview evidence | PR #1411 | No later production credit inferred |
| Public worker diagnostics and generic-job read/cache behavior | Minimized aggregate public worker status/health projections; capability/auth-protected failed-job and operator detail plus generic-job reads; bounded/no-store responses, cache containment, and preview/cleanup automation | PRs #1412–#1413 | Rich public application liveness remains a separate open finding; no later production credit inferred |
| `/dispatch` DAG boundary, public-provider ceiling, and canonical `/gpt` identifier/metric identity | Shared DAG/provider admission plus finite canonical-route identities | PR #1414 | `/dispatch` GPT identifier rejection still follows provider admission; see open finding 2. Production was later reconciled through #1415 only |
| Worker-budget identity and stale-recovery batching | Stable stats worker identity and bounded stale recovery | PR #1415 | Production-verified in the bounded 2026-08-02 reconciliation |
| Backstage mutation authorization/admission | Principal/body/action/path-bound confirmation and execution-time admission across aliases and queued work | PR #1416 | No production rollout credited |
| Backstage roster validation, serialization, atomicity, and fresh publication | Typed bounds, duplicate/NUL rejection, one serialized transaction, fresh reads, and revision fencing | PR #1417 | No production rollout credited |
| `SEC-RESEARCH-WORK-AMPLIFICATION-001` input/storage portion | Shared pre-normalization topic/URL/item/aggregate bounds and a deterministic portable storage component | PR #1418 | No production rollout credited |
| Backstage storyline lifecycle | 16,384-byte beats, newest-100 retention, newest-25 chronological response, transactional sequencing/pruning, and ambiguous-commit handling | PR #1419 | No production rollout credited |
| `SEC-RESEARCH-WORK-AMPLIFICATION-001` aggregate-execution portion | One deadline/signal through every Research seam, cancellation-aware Trinity admission, no new work after abort, and drained outward settlement | PR #1420 | No production rollout credited |
| `SEC-PARSER-ADMISSION-001` MCP subfinding — effective MCP body cap | Exact `POST /mcp` decoded JSON is parsed before the broad application parser at the strictest of the hard 1 MiB maximum, `MCP_HTTP_BODY_LIMIT`, and `JSON_LIMIT`; oversized bodies receive fixed non-cacheable HTTP 413 before downstream MCP work | PR #1421 | No production rollout credited; broader `/dispatch` pre-admission parsing remains open finding 3 |
| PostgreSQL command and aggregate CI truth plus compatible Hono remediation | One exact required-database sentinel across all then-seven suites, purpose-specific disposable loopback targets, and an always-running aggregate that accepts only the exact required job set with every result `success`; Hono pinned to `4.12.34` and obsolete Hono/`@hono/node-server` audit exceptions retired. PR #1427 later raised the required database set to eight suites | PR #1422 | No production rollout credited |
| Node/backend `config.limits.requestTimeout` (`REQUEST_TIMEOUT`) truth | Removed the parsed-but-unused Node setting and its millisecond-valued backend claims; preserved the Python daemon's distinct live seconds-valued timeout controls without inventing a server property or response-only race | PR #1423 | No production rollout credited |
| Protected-configuration digest generation and pre-cutover startup comparison | One shared version-one semantic digest and exact candidate adapters; bounded generate/check/check-pinned tooling for all seven manifest entries; a redacted, signal-safe, fail-closed Railway wrapper for the six runtime-owned pins; manual-only generic JSON handling; pinned GPT catalog parity; and canonical-wrapper Deployment Readiness coverage | PR #1424 | No configured-pin match or production rollout credited |
| Successful non-GPT terminal retention | Prospective PostgreSQL-clock retention at all six terminal writer families for completed/cancelled Ask and DAG-node rows; 24-hour Ask and one-hour DAG-node defaults bounded from one hour through 30 days; explicit/persisted precedence; deterministic bounded `FOR UPDATE SKIP LOCKED` cleanup protecting active idempotency, accounting/diagnostic observation windows, and unstamped legacy rows; aggregate-only legacy inventory and privacy-bounded logs | PR #1427 | Exact merge was promoted to both production roles on 2026-08-11 and readiness/schema/279-row legacy protection were verified. No new live terminal stamp, eligible deletion, backfill, provider/model call, or deletion-latency claim is credited |
| Automatic paired production promotion | Exact `none` rollout-hold sentinel; explicit project/environment/distinct web-worker configuration; dedicated production project-token secret; single serialized worker-first job; pre-mutation role/readiness and baseline capture; exact-ID detached-deployment observation; joint active-ID verification; web watchdog; zero Railway-native triggers; and fail-closed readiness/history corrections exposed by acceptance | PRs #1428–#1430 | Exact #1430 merge was automatically promoted to worker `d20a6833-2448-4677-89df-84e46a0d2567` and web `e59f6a27-2d2a-4e24-b9e8-f9ba5d26dd41`; both active/readiness checks and the strict watchdog passed. The pair is coordinated, not provider-atomic, so partial failure still requires exact-ID reconciliation |
| Predictive/reactive self-heal approval | One protected effect owner per background tick; enabled predictive dispositions are authoritative, unconfirmed and incoherent execution fails closed, coherent completion is recorded once, explicitly disabled prediction preserves legacy authorization, enabled-call rejection remains fail-closed, disabled-plus-executed state is invalid, and a successful verification rollback ends the tick before prediction | PR #1432 | Automatic production run `31622197454` failed during the new worker image build before web enqueue, so exact #1432 received no production credit and the exact #1431 pair remained active. The contained live probe exercised the shared effect-free policy at intermediate head `286e7397`, not the normal loop or final reviewed head; provider, actuator, database, Redis, normal job-worker runtime, and live-memory behavior remain unproved |

## Time-bounded and operational follow-ups

| Follow-up | State |
| --- | --- |
| Auxiliary Analyze Documentation Updates startup fixture lacks `ARCANOS_JOB_READ_CAPABILITY_SECRET` | Reviewed PR #1433 implementation commit `63c31baa` generates and masks the fresh 32-byte fixture and limits inheritance to server startup. Exact-commit run [`31626739806`](https://github.com/pbjustin/Arcanos/actions/runs/31626739806) cleared the former startup failure in configured allow-partial mode; it generated zero sections with six dependency failures and no validated proposal. Merge remains required for source closure |
| Runtime-image Railway CLI bootstrap can fail in unchecked npm postinstall | Reviewed PR #1433 implementation commit `63c31baa` removes the npm postinstall and pins, retries, and checksums one musl asset while preserving both executable names. All surfaced CI passed; run [`31626187034`](https://github.com/pbjustin/Arcanos/actions/runs/31626187034), job `94213819744`, built image `sha256:69ab55f9e73ef4b12f099b0d240f77fbd9ffc534153b32bd34623d93c74cb3fd`; exact isolated Railway preview `c88804be-b13b-46b0-b860-63304bdd5984` built both roles successfully and passed 112/112. Merge and a separately authorized production retry remain |
| Native Railway PR-environment creation | PR #1433 did not auto-materialize an environment despite enabled settings. Exact preview `c88804be-b13b-46b0-b860-63304bdd5984` was manually created from credential-empty base `8d5594c5-075e-4ad5-8fad-9e6e0866032d`; no production target changed. Automatic creation remains unverified |
| Temporary npm-audit platform-profile exception | The 2026-08-10 re-review deadline has been reached; removal/re-review remains open and no silent extension is authorized |
| Coordinated-writer rollout hold and automatic paired deployment | Closed through PR #1430: hold `none`, canonical two-role variables, dedicated secret, zero native triggers, obsolete web-only repository selector removed, and automatic runs `31531116356` and `31535958799` green on exact pairs. #1432 run `31622197454` also triggered automatically but failed during its worker image build. Residual: Railway does not make the pair atomic; worker success plus web failure requires reviewed forward completion or exact-baseline restore, and the workflow intentionally performs no guessed rollback across unknown schema compatibility |
| Production topology, old replicas, retained jobs, drain rehearsal, edge controls, log retention, and stale non-production environments | Bounded #1427 evidence covers product/schema/279-row protection. The latest successful automatic #1431 acceptance covered exact web/worker identities, roles, readiness, active IDs, and timeout/budget watchdog; #1432 failed before activation, leaving that pair healthy and Slice 2 unpromoted. Live retention stamping/deletion, live self-heal effects, edge-policy detail, log-retention duration, measured provider rollback, and future drift remain separate. Older non-production fan-out is historical provider activity; all nine #1427 merge-SHA records were inactive at the bounded readback |
| Preview teardown | The #1422 preview was previously read back as deleted. A read-only 2026-08-08 Railway project inventory did not contain #1423 preview `b9067c39-49b8-49f6-bffe-148e5b2de058`. The #1424 preview environment was absent on 2026-08-10 and both former `/healthz` URLs returned 404. #1427 cleanup run `31468287960` passed, and the transient preview deployment record for environment `2b806b26-50de-4803-b710-b1fab9956ebb` was inactive by the bounded post-merge readback. #1432 cleanup run `31620988938` checked only the separately named worker-diagnostics environment and found none; it does not attest teardown of the standard `Arcanos-pr-1432` environment. Manually created #1433 environment `c88804be-b13b-46b0-b860-63304bdd5984` remains active for the open PR and requires later teardown. These observations do not prove deletion of every historical deployment or artifact |

## Deferred program

GPT-OSS remains a separate production-NO-GO product program. Its router,
training governance, evidence integrity, operator privacy, private serving,
final-gate, coordination, and Windows CRLF test findings are not part of the
active queue above and are not closed by audit-scoped PRs #1408–#1424
and #1427–#1433. PR #1433 is maintenance-only and remains unmerged. Arcanos
Gaming PRs #1425 and #1426 are also outside this audit
lineage despite being present in #1427's base.

# Gaming discovery and evidence recovery

`gaming-hybrid-v2` is the released normal guide/build/meta workflow on the
existing query and candidate tools. Clients explicitly select v2; explicit v1
remains supported for legacy compatibility. Repository fixtures establish
local coordination behavior; they do not establish deployed v2 support,
installed-client acceptance, live providers or private release readiness.

## Authority and evidence

The frontend forwards the original question and supplied player context, reads
structured state, searches when requested, supplies bounded candidate URL hints,
and presents only the backend-approved answer, clarification or limitation.
It must actually use available Web Search for discovery. Search snippets are
not evidence. Frontend readability is preliminary because ARCANOS may be unable
to acquire the same page. Search queries exclude private player information,
credentials, account identifiers and unrelated conversation history.

ARCANOS independently acquires source content and checks identity, integrity,
relevance, applicability and provenance through the existing document resolver,
selection, coverage and CLEAR path. The backend selects a compact evidence set
and decides whether the original question is covered. It may select zero, one
or several sources; one complete source or several complementary sources can
suffice. Accepted evidence remains useful during permitted recovery even when
it cannot answer alone. Client ranking and claimed game, category or publisher
remain untrusted hints.

| Stage | What it establishes |
| --- | --- |
| Discovered URL | A candidate location; no verified content. |
| Acquired document | Backend access and extraction; not automatic acceptance. |
| Accepted candidate | Evidence passed its admission/applicability checks. |
| Selected evidence | Backend-chosen evidence units linked to question requirements. |
| Sufficient coverage | Selected admissible evidence covers the requested answer. |
| Validated answer | Normal Trinity generation passed final checks against evidence and user constraints. |

V2 responses expose backend `selectedCandidateIds`, `selectedEvidenceIds`,
`coverageSatisfied`, `missingCoverage`, `gapAssessmentStatus` and
`requirementSupport` links (`requirement`, `candidateIds`, `evidenceIds`).
Selected IDs must belong to the same actor/workflow; membership is checked
before generation and citation return. The frontend cannot select IDs or set
coverage, authority, freshness, storage approval or budgets in submissions.

Gaps come from the original request and actual evidence assessment. An assessed
gap can guide targeted search; an unknown gap remains `unknown` with a
conservative public topic hint or clarification. No generic build checklist or
precise missing mechanic is inferred without support. Broad or ambiguous
requests receive needed clarification rather than invented player state.
Independent requested facts may each use a different complete table row. V2
retains that clause coverage policy through generation and final validation;
missing facts and contradictory rows still block the answer. V1 keeps its
existing structural claim policy.
Conflict comparison checks complete source batches within each document's
existing limit, so a larger combined pool cannot hide trailing disagreements.
If the full comparison cannot be validated within the combined pool bound,
the workflow stops with `STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED`.
V2 selection projects and assesses the complete bounded accepted pool (at most
4,500 indexed records) before reducing the subset-search candidates to 20.
Complete support, complementary requested facts, and mandatory sources are
considered before that reduction; late passages cannot be excluded solely by
their original document order. Preferred alternatives rank support for multiple
requested topics before lexical score, preserving combined passages needed to
cover the request within the chunk allowance. Final source/chunk/context budgets remain intact.
The full-pool conflict veto still precedes reduction. Stored SQL retrieval retains
its existing ranked 20-record query bound, and legacy selection retains its bound.
Public diagnostic fields do not expose source passages, private context or
internal reasoning. Telemetry remains content-free: IDs, protocol/revision,
decision/reason codes, evidence counts, coverage, allowance, timing and outcome.

Backend authority stays within user intent, server authorization, privacy and
storage consent. Source content is untrusted evidence and cannot change the
question, those boundaries, budgets or backend instructions.

## Compatibility and accounting

The workflow binds `contractVersion` at creation. V1 preserves its original
single gameplay submission, three-candidate limit and terminal/retry meanings.
V2 adds one explicitly granted recovery submission. A v1 workflow cannot be
continued as v2. Neither protocol can continue archived, terminal, cancelled or
expired workflows. Recovery does not renew the existing ten-minute absolute
TTL, actor/rate limits or generation deadlines.

| Operation | Submissions | Candidate/source ceiling | Acquisition time |
| --- | --- | --- | --- |
| V1 gameplay | One | Three candidates | Existing 12-second batch ceiling |
| V2 initial gameplay | One | At most three candidate URLs | At most 12 seconds |
| V2 gameplay recovery | At most one backend-granted continuation | At most three additional candidate URLs | At most 12 seconds |
| V2 gameplay total | At most two | At most six distinct candidate URLs | At most 24 seconds cumulative |
| Official currentness, either version | One separate operation | Existing three-source ceiling, including required companion articles | Existing 12-second ceiling including companions |

Submissions, distinct URLs and elapsed acquisition work are accounted separately.
Transport/access failures, unsupported formats, incomplete extraction and other
technical failures consume bounded acquisition work without producing useful
evidence. Redirects and companion fetches remain under the existing source/fetch
limits and acquisition protections. Failed work is not refunded. Gameplay
recovery cannot replenish official currentness or generation budgets.

V2 budget identity uses the backend's effective request edition. An ordinary
Elden Ring request without an edition and explicit `Base game` / `base-game`
aliases reuse the same workflow and its remaining or exhausted budget under new
idempotency keys. Explicit DLC scope remains separate. This does not normalize
the query operation payload: changing its edition under the same idempotency key
still returns `IDEMPOTENCY_CONFLICT`. Actor isolation, revisions, URL deduplication,
TTL and the original storage policy remain authoritative; v1 behavior is unchanged.

Recovery is permitted only when the backend returns
`discovery.replacementAllowed`, `nextAction: search`,
`discovery.continuationRequired: true` and a remaining allowance that permits
the next submission. `discovery.recoveryRemaining`,
`discovery.nextSubmissionCandidateLimit`, `discovery.remainingCandidateUrls`
and `discovery.remainingTotalAcquisitionMs` expose the remaining ceilings;
hard ceilings do not
grant an independent frontend retry. Stop when coverage is sufficient or the
backend says stop, budgets are exhausted, the workflow expires, authentication
or authorization fails, or the request is cancelled. Do not restart workflows
or silently downgrade v2 to obtain attempts.

## Continuation and failure meanings

Guide responses add `frontendOutcome` and, when another guide could help,
`searchHint`. Existing `state`, `nextAction`, revisions and discovery grants
remain authoritative for wire compatibility and bounded operations.

| Frontend outcome | Meaning |
| --- | --- |
| `answer_ready` | Present the approved grounded answer and qualifications. |
| `need_new_source` | Acquire a different relevant guide if the existing workflow grants discovery. |
| `clarification_required` | Ask the targeted question whose answer changes correct guidance. |
| `temporarily_unavailable` | Report service/access failure using the reason and next action. |

`discovery_required` maps to `need_new_source`, including terminal exhausted
discovery and strict currentness replacement needs. This mapping grants no
additional attempts. `ingestion_pending` remains a separate storage lifecycle
and carries no guide outcome. Search hints use public topic words; free-form
player progress, account identifiers and unrelated context never enter them.
Absent harmless metadata does not itself create a clarification.
V2 asks for a platform or region only for guidance that depends on that scope,
such as keybindings or regional release times. An unnamed requested expansion
build asks whether to include Shadow of the Erdtree; an ordinary Elden Ring
build safely uses the base game. The verb “control” in basic stamina advice does
not make that question platform-specific.

Mixed rejected candidates return `CANDIDATE_SOURCES_REJECTED` with bounded
per-candidate reasons and a sanitized count summary. They never imply that
public guides do not exist. A uniform size failure retains `SOURCE_TOO_LARGE`
at workflow level. V2 retains up to six gameplay candidate outcomes across its
initial and recovery submissions; currentness decisions remain a separate
operation. Diagnostics cannot renew budgets, reopen a closed workflow or
override material conflicts. The October 4 Samurai regression covers the
legacy fetch/edition/identity pattern and its replacement-source mapping.

V2 candidate submissions use the same `workflowId` and `contractVersion` and
the latest response `revision` as `expectedRevision`. Each distinct operation
has a new idempotency key; an identical permitted retry retains its original key
and payload. Changed payloads under the same key fail. Completed replays do not
refetch or regenerate, concurrent continuations cannot spend allowance twice,
and stale revisions cannot advance a newer workflow.
Failures for validated v2 requests retain the v2 response version and diagnostics,
including query conflicts, context validation and workflow capacity failures.

A provider timeout retains accepted evidence and its provider-specific failure;
it does not authorize source refetch, discovery recovery or automatic generation
retry. Transport/access failure, unsupported format, extraction/integrity
failure, wrong game/applicability, insufficient coverage, material conflict,
provider timeout, invalid answer and host/tool/connection unavailability have
different meanings. HTTP 403 alone does not prove robots policy. Partial
extraction does not prove a site was unreachable. A frontend linked-account
error does not prove a backend outage.

Workflow-scoped `discovery.acquisitionHints` reflect observed backend access results,
declare their scope, and expire with the workflow. The initial implementation
emits URL-scoped observations (`scope: url`, `target`, `reasonCode`, `observedAt`,
`expiresAt`); it does not infer a domain-wide failure from a single URL. They guide safe
replacement discovery; they do not establish content quality or permanently
blacklist a domain. Security-denied URLs remain denied. No proxies, borrowed
cookies, access-control bypasses or weakened network protections are permitted.

## Currentness, answers and storage

Adequate gameplay evidence with unverified advisory currentness may proceed
through normal Trinity generation with the visible warning that recommendations
may be outdated. It remains freshness-unverified and cannot claim verified
current-patch compatibility. Insufficient coverage recovers only when permitted,
otherwise stops. Material conflict uses explicit backend handling. Latest/current
facts and live status retain strict currentness. An explicitly required supplied
guide must actually be acquired and validated; unrelated sources cannot silently
replace it.

Generation uses the established central model/authority path after coverage
approval, with existing execution and stage deadlines. Final validation checks
selected evidence, supported material claims, citations and provenance, user
constraints, spoiler tolerance, freshness warnings, format and answer integrity.
Only approved answers and selected admissible citations are returned. The
frontend may format them, preserve exact citation URLs with punctuation outside
targets, and must retain qualifications. It cannot add claims or present a
backend rejection as a successful answer.

`transient_only` remains the default. Acceptance and selection never grant
storage consent. Source ingestion and refresh remain separate consequential
writes under their existing authorization, policy and confirmation gates.
No automatic policy upgrade or durable write follows discovery.

## Deterministic coordination evidence and limits

The served MCP recovery fixture uses the real request/output schemas, OAuth
authorization, coordinator, acquisition, selection and final validation. Search,
HTTP/DNS, retrieval and provider boundaries use controlled fixtures and fake
time. It does not replace the coordinator with a mocked result.

| Fixture stage | Backend result |
| --- | --- |
| Initial three URLs | Unsupported video rejected before fetch; access failure rejected; incomplete readable guide accepted and selected. Coverage remains insufficient, with one assessed missing topic and one recovery grant. |
| One replacement on the same workflow | Backend independently acquires complementary evidence, selects two candidates/evidence records, approves coverage and returns the validated answer. |
| Work performed | Three HTTP fixture acquisitions, one established generation invocation, one final semantic audit, zero ingestion calls. |

Separate negative fixtures prove that exhausted or still-insufficient recovery
stops before generation, provider timeout does not launch recovery or another
generation, and advisory extraction failure retains the required warning.
Equivalent coordination cases use a second game through the same implementation.
Frontend sequencing is simulated; these tests do not establish actual Web Search,
installed-client behavior, live providers or database acceptance.

The sealed Railway guide fixture adds two supplemental proof markers:
`gaming-discovery-recovery-protocol/v1` checks the production v2 request/revision
schemas, bounded attempt policy and supplied-guide projection;
`gaming-discovery-recovery-evidence/v1` checks independent intact table rows,
missing fields, unchanged v1 admission, trailing contradictions across 2,100
units and unavailable full-pool inspection. The original safe response body and
171-request verifier bound remain unchanged. The reviewed PR-head verifier
requires both markers only on the fixed guide selector. Any fixture failure
withholds every Gaming proof header and the success body.

Hosted sealed-preview execution and teardown were proved at historical head
`c95c01d65682a67b255bf44cd7f00c42c25553de`: the trusted and supplemental
verifiers each passed 171 requests. That evidence does not attest later commits.
Final gap closure reruns the native application fixtures and failure controls
locally and the maintained CI on the final head; it does not deploy another
preview. The PR description records the exact final candidate and test totals.

Deliberate corruption controls cover the actual served coordination seams:
disabling v2 pipeline coverage rejects the independently supported answer;
skipping unretained artifact inspection exposes the contradictory capacity
case; downgrading gateway fallbacks fails v2 service/deadline responses.
Restoring the exact source bytes restores the passing suites. Separately,
corrupting the synthetic table stat causes the sealed guide route to fail.
These are controlled served-component proofs; the sealed preview does not run
the normal OAuth coordinator, discovery provider, model, SQL or active worker.

Discovery capacity is distinct from generation context capacity. V2 selects the
least-cost complete evidence set, including intact passages, numbered headers
and required currentness/supplied-guide records. Four compact source identities
may be selected when they fit the existing context ceiling. Six accepted URLs
do not automatically become six generation sources. The configured chunk limit
still applies (six by default, at most eight), as does the established context
character ceiling (5,000 by default); qualification text consumes that same
budget. No passage is clipped to manufacture clause coverage. If complete
coverage cannot fit, the workflow reports missing coverage and stops or uses
its one permitted recovery. V1 retains its previous source cap and selection.
Full acquired-pool conflict checks still precede compaction, and final citations
include only selected sources. Public numbered topic labels correspond
to requested clause order and avoid publishing private question prose. Unknown
gaps receive conservative search hints rather than invented mechanics.

**Availability limitation:** workflow state and locks remain process-local.
A process restart or requests routed to another replica cannot resume a local
workflow: continuation fails with `WORKFLOW_UNAVAILABLE` before acquisition or
generation. Actor binding, protocol binding, revision compare-and-swap,
idempotency and acquisition accounting are authoritative within the owning
process. They do not promise cross-process continuation or duplicate suppression.
The absolute workflow lifetime is at most ten minutes, may be shorter for
freshness, and is never renewed by continuation or recovery. Expired state and
its hints are removed. No source content is persisted to coordinate workflows.

The pre-merge read-only production metadata audit found one configured web
replica and one running replica. The existing contract explicitly describes
ephemeral process-local workflows; it has no restart/fleet continuity guarantee.
This is therefore a retained availability limit, not a reason to introduce a
durable source store. Recheck the one-replica assumption before an authorized
rollout; a multi-replica rollout requires a separate coordination/privacy review.
Deterministic two-instance and restart simulations prove fail-closed continuation,
and original-expiry tests prove hints and recovery cannot renew the workflow.
The dedicated
MCP catalog remains below the existing 64,000-byte fixture ceiling; schema
growth must continue to respect that bound.

Acquisition hints remain URL-only. Multiple failures on a host have not
demonstrated a benefit sufficient to add domain-level hints. One failed URL
cannot poison another allowed URL on that host. Hints are advisory, expire with
the workflow, and never decide backend acceptance; security failures are not
converted into access hints or a reason to bypass the server's hard URL policy.

## Frontend instruction candidate and rollout

The final pre-merge audit verified the existing instruction-byte normalization,
v2 failure response diagnostics, complete structural evidence admission,
sealed-preview proof fixtures and narrow synthetic-fixture secret-scan repair
before changing selection. Those five findings were already closed. New local
controls demonstrate one through four compact complementary sources, oversized
four-source evidence stopping honestly, six candidates needing only two,
unselected conflicts vetoing generation, and selected-only citations. A real
served MCP fixture acquires three initial sources and one granted replacement,
returns the four-source grounded answer, and performs zero durable writes.

[The released v2 MCP workflow](gpt/arcanos-gaming-hybrid-v2.instructions.md)
uses the actual installed-tool names `arcanos_gaming_hybrid_query` and
`arcanos_gaming_submit_candidates`. The
[pinned v1 workflow](gpt/arcanos-gaming-hybrid.instructions.md) remains legacy
Action documentation; its names are not the installed MCP mapping. The
existing eight-tool catalog and query/write scopes remain unchanged.

[`gamingRecoveryCompositionPatch()`](../scripts/compose-gaming-skill.mjs)
provides the exact public replacement workflow and explicit before/after
revisions for existing composed safeguards. Pass that recipe and the verified
private baseline bytes to the pure `applyGamingRecoveryCompositionPatch()`
helper for local composition. The default composer produces the released v2
workflow and safeguards.
It replaces a complete canonical marked legacy workflow and preserves unrelated
source bytes; unknown or mixed version declarations fail closed. The separate
pinned recipe remains available for historical private-baseline reconciliation. Before
applying the canonical recipe, verify the actual approved skill is 15,210 bytes
with SHA-256
`a2cd3cfb2eb677eaef47c7fc148b41565b58e051486a49b29df48ee53c048081`.
The helper requires exactly one complete, ordered v1 workflow marker pair and
exactly one occurrence of each of the eight canonical old safeguard texts.
Missing, duplicate, conflicting or overlapping matches fail closed. It replaces
only those byte ranges, preserves every unrelated byte, and returns the proposed
candidate's size, hash and reversible range map. UTF-8 and line endings are not
normalized. The helper does not change owner-approval records or write files.
Store the complete proposed skill, its exact private diff, size, hash and
pending-review record only under a new ignored `.local-migration/arcanos-gaming/`
directory or a private task Temp directory. Never commit or upload private bytes.

The review worktree has no private baseline inputs. Read-only inspection of a
prior private workspace independently found skill files matching the historical
approved size and hash above. That match does not verify the current installed
plugin identity or its current skill bytes, and it does not approve a v2
candidate. Public recipe tests use a clearly synthetic pinned baseline; actual
private composition must use the untouched canonical recipe and independently
verified historical bytes. Complete candidate review remains a separate owner
checkpoint.

Local application of that canonical recipe to the verified historical baseline
produced a complete private candidate with exactly nine replacements. Repeating
application produced identical candidate bytes/hash, all unrelated byte slices
were preserved, and reversing the recorded ranges recovered the original
baseline. The candidate and exact diff remain private and pending owner review;
this does not establish current installed identity or behavior.

The public recipe records the current workflow size and SHA-256 directly from
the released instruction source. These identify public patch bytes. The complete
private candidate has its own
separately recorded hash and remains `PROPOSED_NOT_OWNER_APPROVED`; neither a
public recipe hash nor historical baseline approval approves it. Historical
approval records stay unchanged. Composition evidence and deterministic
frontend/provider fixtures do not establish installed-client or live-provider
acceptance.

Rollout requires separate authorization, in this order:

1. Review and deploy the backward-compatible backend.
2. Verify the **production** dedicated tool catalog and closed schemas support
   `gaming-hybrid-v2`, including candidate `expectedRevision` and the returned
   recovery/coverage fields. Confirm the same eight Gaming tools and separate
   Gaming query/write scopes; local or sealed-preview schemas do not prove
   production support.
3. Review the complete private frontend instruction artifact and approve its
   exact private diff and new hash. Baseline approval is insufficient.
4. Verify the existing private Gaming plugin identity, then update that **same**
   plugin with the owner-approved bytes through the guarded in-place update.
   Preserve its private identity and unrelated configuration; do not create
   another plugin or repeat migration.
5. Establish a fresh authorized linked Gaming account/connection and verify its
   installed tool discovery. Distinguish connection/authentication failures from
   backend, source and provider failures; stale client discovery is insufficient.
6. Run bounded installed-client discovery with separately authorized live
   boundaries: send the original question/context first, actually use available
   Web Search under a backend discovery grant, submit at most three initial and
   three recovery URL hints, and retain the same workflow, protocol and latest
   revision. No workflow restart or silent protocol downgrade grants more work.
7. Prove a grounded positive result: `answer_ready`, `evidenceSelected: true`,
   `coverageSatisfied: true`, actor/workflow-bound selected IDs, usable selected
   citations/provenance, the validated answer and required qualifications, with
   no fallback or unsupported claims. Record actual currentness separately.
8. Prove the exhaustion negative: insufficient evidence after the permitted
   continuation yields an explicit stop/limitation before generation, with no
   new workflow, extra acquisition or provider retry to manufacture success.

Keep acceptance at zero ingestion, refresh or other durable source writes.
Those operations require separate user authorization and their existing scope,
policy, consent and confirmation gates; candidate acceptance, owner instruction
approval and successful generation do not grant storage permission.
Code, composition and fixture evidence do not authorize deployment, plugin or
account changes, live acceptance, durable writes or merge by themselves.

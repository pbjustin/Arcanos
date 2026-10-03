# Gaming discovery and evidence recovery

`gaming-hybrid-v2` extends the existing Gaming hybrid workflow. It is an explicit
opt-in on the existing query and candidate tools. Repository fixtures establish
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

The existing selector bounds remain three source records and eight chunks per
answer. Coverage must pass within those bounds; six discovery URLs do not
authorize a larger generation context. Public numbered topic labels correspond
to requested clause order and avoid publishing private question prose. Unknown
gaps receive conservative search hints rather than invented mechanics.

Workflow state and locks use the existing process-local, expiring cache. A
process restart or requests routed to another replica cannot resume a local
workflow; a shared durable workflow store is outside this change. The dedicated
MCP catalog remains below the existing 64,000-byte fixture ceiling; schema
growth must continue to respect that bound.

## Frontend instruction candidate and rollout

[The proposed v2 MCP workflow](gpt/arcanos-gaming-hybrid-v2.instructions.md)
uses the actual installed-tool names `arcanos_gaming_hybrid_query` and
`arcanos_gaming_submit_candidates`. The
[pinned v1 workflow](gpt/arcanos-gaming-hybrid.instructions.md) remains legacy
Action documentation; its names are not the installed MCP mapping. The
existing eight-tool catalog and query/write scopes remain unchanged.

[`gamingRecoveryCompositionPatch()`](../scripts/compose-gaming-skill.mjs)
provides the exact public replacement workflow and explicit before/after
revisions for existing composed safeguards. The default composer still produces
v1. To compose privately, first verify the actual approved skill is 15,210 bytes
with SHA-256
`a2cd3cfb2eb677eaef47c7fc148b41565b58e051486a49b29df48ee53c048081`.
Replace exactly one marked v1 workflow and each exact matching safeguard rule;
an absent or ambiguous match blocks composition. Preserve unrelated private
baseline bytes and owner-approval records. Store the complete proposed skill,
its exact diff, size, hash and pending-review record only under a new ignored
`.local-migration/arcanos-gaming/` directory. A public recipe hash is not the
complete private skill hash or owner approval.

At this task's initial local inspection the private directory and approved skill
inputs were absent. Actual baseline verification and complete private composition
are blocked. The independently prepared public patch is in the ignored local
`.local-migration/arcanos-gaming/proposed-v2-instruction-patch/` directory with
the exact public workflow diff, rule replacement recipe and a proposed manifest.
The workflow replacement is 9,046 bytes, SHA-256
`2f8f4d08442674d014a0e36a2dc1e19b6628092199697720355bd6a1ed98c6be`;
the recipe is 17,658 bytes, SHA-256
`8e26255da88cef187236c6e771886595d3c8c64936c292b106abf930464ea3fb`.
These are public patch hashes, not complete private skill hashes. The manifest
marks the historical approved skill metadata unverified locally and private
composition blocked. The public replacement recipe is independent of private inputs;
no private content is invented and no private upload is required. Historical
approval records are unchanged. Deterministic frontend/provider fixtures are
distinct from actual installed-client and live-provider acceptance.

Rollout requires separate authorization, in this order:

1. Review and deploy the backward-compatible backend.
2. Verify the deployed dedicated tools actually support v2.
3. Review the complete proposed frontend instruction artifact and approve its
   exact new hash.
4. Update the **same** private Gaming plugin with those approved bytes.
5. Run bounded installed-client acceptance with separately authorized live
   boundaries; record currentness, failures and storage separately.

This implementation task ends at a reviewable draft PR and local instruction
patch. It authorizes no production/preview deployment, live Gaming/provider
calls, installed-plugin/account/configuration changes, durable Gaming writes
or merge.

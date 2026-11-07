# Gaming modernization: Phase 1 evidence and follow-up scope

Base: `52d859c2ae15c3cc15befbc7d6cc7538f20753b5` (main including PR #1591).
Implementation and exact final validation head are recorded in the draft PR.
This is development evidence, not production readiness or merge approval.

## Architecture and confirmed gaps

Owner ingestion and live candidate evaluation share `gamingDocumentResolution.ts`:
public URL admission, pinned protected acquisition, bounded extraction, instruction
inspection and acquired-document identity binding. Durable ingestion chunks the
acquired document and atomically persists source revisions and active knowledge
records through `gamingSourceRepository.ts`. Later sessions use PostgreSQL lexical
search with a bounded 20-record candidate pool, then applicability, selected-evidence
CLEAR and final answer grounding checks. This work retains that architecture.

The production request supplied for this investigation rejected on
`gaming.identity.affirmative_body_scope_conflict` at 2026-11-07 07:58:27 UTC.
Acquisition passed; extraction returned 12,293 characters and 21 complete
table/list records, with extraction-budget exhaustion and partial coverage.
The source identity gate rejected before source CLEAR scoring or generation.
The historical logs contain no publisher body or content hash, so they identify
the exact rejection branch but do not independently identify its text fragment.

A separate read-only acquisition of the current public IGN wiki reproduced the
same rule and extracted character/record counts. In-memory inspection established
that an implicit `in` clause crossed several DOM nodes and combined navigation
labels with a later guide marker. The generic identity detector treated the
clipped sequence as a complete game identity. This is a confirmed current false
positive; matching historical counts alone do not prove identical publisher bytes.
No IGN document was ingested or stored in PostgreSQL.

Final ordinary compiled acquisition with resolver/CLEAR policy v7 verifies the
current page through `gaming.identity.acquired_anchors_verified`. It returns
8,731 characters, 18 structured records and one bound local-topic reference,
with partial extraction still reported. This is current live identity evidence;
gameplay sufficiency and generation eligibility were not evaluated in that read.

Other reproduced defects include sentence-local related-guide references being
treated as global game conflicts, closed primary game definitions failing identity
classification, metadata-only structured records counting as gameplay, and intact
short player actions failing a length-only extraction gate. Permanent authored
synthetic HTTP fixtures exercise protected acquisition and actual extraction.
Their provenance is explicit; they are not IGN captures.

Parser-owned linked-topic exclusions bind only the exact local reference frame,
with bounded game/content hashes and text offsets in acquired metadata. Other
sentences and contradictory declarations remain intact. Duplicate/overlapping
spans, forged hashes and changed resolver attestations have dedicated negative
regressions. Linked record fields, release metadata, short gameplay steps and
source-use/instruction checks remain preserved before catalog-label omission.

## Storage and evidence authority

Submission admission, successful persistence/indexing, and generation eligibility
are separate outcomes. Existing public status fields remain; optional ingestion
classification and diagnostic fields explain `verified`, `stored_unverified`,
`reference_only`, `needs_reassessment` and `rejected` results.

V2 storage-only candidate artifacts remain outside accepted evidence and freshness
collections. Retention requires explicit owner confirmation, permitted durable
source use, current actor/workflow/TTL binding and unchanged acquired content.
Automatic quality-approved storage does not admit these artifacts. The worker
reacquires and verifies the bound content before persistence. Retained provenance
survives SQL storage and later sessions, and an explicit retrieval fence prevents
non-authoritative records from supplying generation context. A wiki index stores
only its acquired material; linked articles are not acquired by implication.

CLEAR scores and thresholds remain unchanged. Policy invalidation prevents prior
assessments from silently retaining authority under changed identity rules.
OAuth, owner checks, explicit confirmation, idempotency, source-use restrictions,
revision supersession, hashes, citations, spoiler controls and final answer audit
remain independent gates.

## Validation scope

Exact-base failing-before and final passing-after results are recorded in the PR.
The disposable PostgreSQL 18.6 integration suite exercises owner queue processing,
real acquisition/extraction over deterministic HTTP transport, chunk/revision SQL,
active lexical indexing, duplicates/refresh, and retrieval in a fresh child process.
Fresh-process reads assert exact source/revision citation identity and prohibit
network, provider and queue calls. Retained reference material remains searchable
through the repository but absent from generation evidence.

The frozen PostgreSQL/retrieval/security run passes 208 tests in seven suites,
without skips. Of those, the two PostgreSQL suites contain 86 cases (12 durable
retrieval and 74 historical-status cases); the remaining suites cover selection,
authority, database guard truth, linked extraction and identity. Older v6 jobs
remain owner-readable while replay/reapproval stays rejected under v7.

Synthetic publisher and model/answer-audit fixtures establish deterministic
pipeline behavior. They do not establish live provider judgment, installed MCP
client behavior, production ingestion, or live IGN gameplay sufficiency.
Independent Codex Cloud review and required exact-head CI remain merge gates.
No merge, deployment, production write, Railway configuration change, paid
provider call or durable IGN ingestion is part of this work.

The supplemental image smoke builds a deliberately frozen historical candidate.
The additive MCP catalog exposed its comparison against the current controller's
catalog instead of that image's source contract. The repair verifies the exact
reviewed historical commit/tree/archive/catalog tuple before transport, retaining
all 84 assertions and ordinary current-head catalog equality. Candidate code is
read only as bounded literal data; it is not executed by the controller. This
frozen-image smoke is separate from current application or hosted acceptance.
The broad controller test group has 19 failures and one platform skip in this
Windows environment; all 19 also reproduce on unchanged base `52d859c2`.
Focused image/scoped, real Git-reader and MCP verification regressions pass.
These results do not replace the actual Linux image smoke check in CI; no
assertion or platform requirement was weakened to hide the baseline failures.

The existing 1,024 acquired-scope inspection limit remains fail-closed. A highly
repetitive long document can be retained as unverified while its raw indexed text
remains inspectable; it cannot supply generation context. Positive large-guide
fixtures now independently establish game identity and remain within that bound;
an explicit over-budget fixture preserves the negative assertion.

## Phase 2: separate discovery PR

Prerequisite: Phase 1 acceptance and independent review. Extend the existing v2
workflow and separately configured backend discovery adapter, preserving host
ownership, actor scope, TTL, revision, candidate and time/retry budgets.

1. Benchmark discovery with accessible, denied, redirected, failed and duplicate
   URLs. Record useful accepted evidence, replacement attempts and source limits.
2. Retain accepted complementary evidence when replacing failed URLs; maintain a
   bounded canonical failed-URL set and preserve cancellation/idempotency behavior.
3. Expose access/extraction limitations separately from evidence absence. Permit
   qualified partial answers only when every expressed claim has selected support
   and the final answer audit accepts that scope.
4. Evaluate server-authorized automatic discovery behind explicit configuration;
   default authority and installed MCP workflow remain unchanged. Add no crawler,
   access-control bypass, browser credential use or unbounded retries.

Acceptance: served v1/v2 compatibility and negative authority tests, bounded
recovery/coverage tests, source limitations and final CLEAR/citation rejection.

## Phase 3: separate measured retrieval PR

First freeze a reproducible PostgreSQL lexical benchmark using revision-bound
synthetic and permitted source fixtures. Include synonyms/paraphrases, exact
mechanics, unrelated games, editions/platforms, stale/contradictory records,
unverified retention and spoiler/progression exclusions. Measure recall@k,
precision@k, grounded coverage, false authority acceptance and latency/resource
bounds, reporting lexical failure cases before choosing an implementation.

Compare that baseline with an optional deterministic offline semantic candidate
seam plus bounded fusion/reranking. Reuse PostgreSQL facilities where feasible;
add no separate vector service without measured justification. Game/edition/
platform, provenance, source revision, patch/currentness and CLEAR validation
remain mandatory after fusion. Similarity never establishes a source fact or
corroboration. Preserve exact original-source/revision citations and surface
contradictions. Report any proposed embedding-provider price, operational
requirements and authorization separately before provider-backed evaluation;
paid embeddings stay disabled by default.

Acceptance: reproducible before/after benchmark and negative authority tests,
fresh-process SQL retrieval, bounded candidate latency/cost, unchanged citation
and final answer validation, plus independent review and exact-head CI.

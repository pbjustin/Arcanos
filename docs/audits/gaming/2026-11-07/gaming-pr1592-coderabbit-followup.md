# PR #1592 CodeRabbit follow-up

This advisory record follows the review of commit
`958aa7c788cb91506a0abc60fcee585e27a2e862`. The original PR base remains
`52d859c2ae15c3cc15befbc7d6cc7538f20753b5`. Earlier records retain their
historical results. Final commit-bound receipts and GitHub check status belong
to the accompanying acceptance report and PR; this document is not merge or
deployment approval.

All new acquisition fixtures are authored synthetic inputs. SQL tests use an
isolated disposable PostgreSQL 18 database; the compiled HTTP fixture uses
loopback acquisition and synthetic provider transport. No publisher material,
paid provider, production mutation, deployment or bot review request is needed.

## Reproduced behavioral findings

| Boundary | Repair and permanent regression |
| --- | --- |
| Hybrid markers without explicit retention history | Persistence and retrieval share the history predicate; current durable proof remains required. [Actual SQL controls](../../../../tests/integration/gaming-authority-read.pg18.integration.test.ts) cover missing, invalid and valid stamps, plus stripped active markers with immutable history. |
| Held rows exhaust the lexical candidate pool | Refill retains the existing limit, deadline and cancellation controls while searching past held rows. [Actual SQL](../../../../tests/integration/gaming-authority-read.pg18.integration.test.ts) places 125 held records before a valid guide; [page controls](../../../../tests/gaming-stored-authority-refill.test.ts) exercise deduplication, revision changes, deadline and exhaustion. A source that changes revision across observed pages is excluded from that lookup. |
| Applicability-unknown readable guide cannot be retained | A narrow v2 owner-confirmation path permits storage-only retention when other required gates pass. [Lifecycle controls](../../../../tests/gaming-candidate-applicability-retention.test.ts) preserve unknown classification and generation exclusion, including conflicting scope negatives. |
| Truncated metadata hides source-use restrictions | Inspect full raw title/description/Open Graph values before bounded display prefixes. [Extraction regressions](../../../../tests/gaming-cr-extraction-regressions.test.ts) assert no accepted build, evidence, snippet or cache rescue. |
| A clean ranked record hides a restricted sibling | Inspect all supported decoded/adapter candidates before ranking, under existing parser bounds. The same extraction suite preserves instruction and unsupported-field controls. |
| Selected document loses a raw restriction | Carry the already computed raw flag through document resolution. The extraction suite exercises an Archive tail outside the real selected RAG projection, including repeated retrieval. |
| Linked declarative gameplay is removed as navigation | Use the shared attributable-claim predicate before dropping label-only links; extraction controls preserve a linked key/gate fact while excluding a catalog label. |
| An incomplete list prefix hides explicit applicability | Preserve explicit platform/region text and mark ambiguous list scope unverified. Actual acquired HTML controls reject incompatible requests. |
| Requirement coverage retains stylistic/freshness terms | Apply the same claim normalization to each requirement while retaining the original freshness request. [Claim and identity controls](../../../../tests/gaming-coderabbit-claim-scope.test.ts) preserve missing-topic and explicit patch-question negatives. |
| Flattened foreign guide heading evades identity conflict | Recognize a nominal guide frame followed by an intelligible instruction. The claim/identity suite preserves same-game positives and foreign/edition conflicts. |
| Factual non-imperative mechanics disappear | Extend finite subject-owned mechanical predicates for halves/staggers; catalog/keyword negatives remain. |
| Identity/authorship metadata becomes gameplay | Separate game definitions and authorship from independent factual continuations. Protected acquisition tests reject metadata-only pages. |
| Nominal About-the-game heading becomes gameplay | Normalize closed section labels and reject generic function-word imperative starts. The real H2-before-definition synthetic layout is a permanent negative. |

Focused fixtures failed before their owning production repair and passed after.
The final report distinguishes original-source reproductions from targeted
pre-fix replays. Combined review also found a cross-page revision race; its
separate regression prevents retaining an earlier approval after observing a
changed revision. No assertion was waived, skipped, loosened or deleted.

## Contract, documentation and test precision

The compiled fixture accepts the same disposable loopback host forms as its
shared database guard. `test:integration` performs the full backend build and
writes its artifact receipt before compiled acceptance. The dedicated required
PostgreSQL job includes the new read-authority suite, and the CI truth contract
asserts both registrations.

The existing selected-chunk coverage fixture now independently assesses a whole
synthetic source before persisting its nominal or factual chunks with current
durable proof. Its old manually seeded hybrid markers became ineligible under
the repaired read boundary. All original coverage, citation and no-fetch
assertions remain; whole-source approval cannot substitute for selected-chunk
support. The loopback compiled fixture explicitly selects plaintext transport
after target validation, matching its disposable admin connection on IPv6 too.

The API documentation now describes the bounded 16,000-character revision
preview and bounded chunks, including possible omissions; historical status
does not return document text. Audit records now use the required topic/date
layout with an index.

The three test-review nits have independent assertions: the copied approval is
deeply equal but has different object identity without changing its count;
forbidden caller authority fields are absent from MCP properties as well as
rejected on input; and actual reasoning/final generation requests must contain
selected evidence and its acquired source URL before the synthetic response is
returned. Audit calls and fixed provider output cannot satisfy that assertion.

## Limits

Refill uses bounded READ COMMITTED pages, not a global snapshot. Concurrent
insertions/reordering can defer rows to another lookup; observed revision
changes discard that source for the current lookup. Exact source/revision/record
citations, immutable historical provenance and independent authority checks
remain required. Synthetic IGN-style fixtures do not establish historical byte
equivalence. Native Windows baseline receipts and the independent final-head
Cloud review gate remain separately reported; local acceptance never supplies
production or merge authorization.

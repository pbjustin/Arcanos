# PR 1592 independent review remediation

This record covers original base `52d859c2ae15c3cc15befbc7d6cc7538f20753b5`,
reviewed/starting head `89e3b7c13957ea4ac405017f4856661ed7ffbca6`, and the
subsequent repairs on the existing PR branch. All acquired test documents are
authored synthetic fixtures. No live publisher material, paid provider,
production mutation, deployment, merge, replacement PR or CodeRabbit request is
part of this remediation.

## Independently reproduced findings

| Finding | Failing input and observed behavior before repair | Origin and expected behavior |
| --- | --- | --- |
| P1-A refresh authority | A full, independently acquired guide retained as `stored_unverified`, `generationEligible:false` became `verified/true` on ordinary refresh and supplied one selected passage. Reviewed `gamingSourceIngestion.ts:894-896,1140,1434`. | The PR introduces the permitted retained-content producer; original base already lacks a general repository history fence. Original approved-source refresh controls pass. Storage must never authorize previously held material. |
| P1-B catalog authority | A long independently game-scoped wiki catalog and a keyword-only document were `complete`, had verified claim support, opened hybrid generation, and reached the direct provider boundary without gameplay facts. Reviewed document quality `gamingDocumentIngestionCore.ts:159-185`; lexical support `gamingClearEvidence.ts:144-146,261-269`. | The defect reproduces on original base. This PR adds an explicit verified classification to retained storage paths; the repair closes both implicit and labeled authority routes. Length, identity, titles and lexical topic overlap are insufficient. |
| P2-A applicability | `<h3>Platforms</h3><ul><li><a>Xbox</a></li><li><a>Switch</a></li></ul>` loses both values and a PC request passes source CLEAR. Reviewed `gamingHtmlEvidence.ts:134-159`. | Text deletion is introduced by this PR. Base keeps the values but does not bind heading/list applicability (`gamingFreshnessCore.ts:164-180`). Standalone source CLEAR also omitted platform/region conflicts. All restrictions must survive extraction or fail closed. |
| P2-B Windows parity | The earlier aggregate counts do not identify assertion parity. | Clean detached base and reviewed worktrees now run the same 16 controller files with Node 24.18.1, npm 11.16.0, Git 2.52.0.windows.1, native win32/x64 and identical command/environment. Named comparison: 329 unchanged assertions, four added passes, zero introduced/resolved/changed failures. All 19 failures are retained with sanitized categories and stacks. |

The controller files are owned by `node:test`, not Jest. Their receipts use a
Jest-compatible JSON envelope and explicitly identify the actual runner. The
application regressions use the repository's actual Jest runner and JSON output.
No runner is relabeled and no failed assertion is waived, skipped or deleted.

## Durable authority boundary

[Source authority validation](../../../src/shared/gaming/gamingSourceAuthority.ts)
accepts only a separately supplied, current worker authorization bound to the
exact acquired document, persisted revision and current source CLEAR assessment.
The repository removes caller authority stamps. A private restriction-epoch
snapshot is captured from exact canonical source identity before source CLEAR,
bound into the server artifact and durable queue, and compared with current
history after the persistence lock. Public source/refresh and MCP inputs cannot
supply this authorization. Missing legacy epochs cannot clear held history.

[Persistence and SQL retrieval](../../../src/core/db/repositories/gamingSourceRepository.ts)
derive restrictions from immutable source history. A separate source lock is
acquired before reading history in a fresh PostgreSQL statement snapshot. This
matters when another transaction commits retained content while a writer waits
for the lock. Authority stamps bind the durable restricted-revision count;
assessments captured against an earlier restriction epoch cannot clear it.
Revision identity includes that authority boundary, so A-to-B-to-A cannot reuse
an obsolete approved A revision after held B. Historical provenance remains
immutable, including when a fresh current assessment authorizes new A.
Held revision identity also binds the preceding server-grant count: returning
to the same B after a new A grant creates a new immutable restriction boundary.
Repeated B retries within one grant remain idempotent. An unchanged current
source does not create another revision solely because its question changed.

[Refresh admission and worker](../../../src/services/gamingSourceIngestion.ts)
recognize every non-authoritative classification and explicit false generation
eligibility. The final public result reflects the atomic repository decision.
[Generation selection](../../../src/shared/gaming/gamingStoredEvidenceCore.ts)
independently excludes explicit and durable-history holds even when SQL text
search returns those records.

## Claim support and applicability

[Attributable claim extraction](../../../src/shared/gaming/gamingRetrievalPolicy.ts)
separates topic labels and catalog speech from gameplay assertions. It supports
declarative facts, unfamiliar player actions, short guides and complete
structural records; an imperative is not universally required. Source quality,
selected evidence and request support use the same boundary. Game identity,
storage success, indexing and page length do not supply claim support. Final
answer CLEAR remains a separate requirement.

[HTML extraction](../../../src/services/gamingHtmlEvidence.ts) preserves
parser-owned applicability headings and linked values without treating metadata
as gameplay. [Freshness assessment](../../../src/shared/gaming/gamingFreshnessCore.ts)
and [source CLEAR](../../../src/shared/gaming/gamingClearSource.ts) retain global
platform, region, edition, version and source-use restrictions. Conflicting
platforms/regions and explicit incompatible versions cannot become absent facts
through navigation cleanup.

## Regression and acceptance map

| Route/control | Permanent evidence |
| --- | --- |
| Direct retained refresh; direct catalog retention and retrieval exclusion | [Independent CLEAR review](../../../tests/gaming-independent-clear-review.test.ts) |
| Current authorization, exact content/context, strict stamp shape, stale assessment | [Source authority unit regressions](../../../tests/gaming-source-authority.test.ts) |
| All retained classifications, false eligibility without classification, duplicates, restart, concurrent writers, source-lock barrier, missing/forged/v6/v7 provenance, immutable A-B-A | [Real PostgreSQL durable matrix](../../../tests/integration/gaming-durable-rag.pg18.integration.test.ts) |
| Catalog direct pipeline, hybrid candidate selection, request support, final generation gate and genuine factual/short/structured positives | [Catalog authority regressions](../../../tests/gaming-catalog-evidence-authority.test.ts), [synthetic fixtures](../../../tests/fixtures/gaming-catalog-authority.ts) |
| Actual protected HTML linked scope, global conflicts, malformed layouts, restrictions and ordinary navigation | [Applicability regressions](../../../tests/gaming-navigation-applicability-regression.test.ts) |
| Changed bytes/hash, candidate substitution, owner binding, TTL, policy/score/context mutation and queued applicability expiry | [Hybrid lifecycle integration](../../../tests/gaming-hybrid-lifecycle.integration.test.ts) |
| v2 expected revision, idempotency and cross-actor continuation | [Hybrid v2 lifecycle](../../../tests/gaming-hybrid-v2-lifecycle.test.ts) |
| v6 owner-readable status and denied execution | [Historical PostgreSQL compatibility](../../../tests/integration/gaming-historical-status.pg18.integration.test.ts) |
| Real compiled OAuth/MCP, protected loopback HTTP, actual queue/worker transactions, retry/cancel/duplicates, automatic approved source storage, fresh-process SQL selection/CLEAR and grounded response | [Compiled HTTP PostgreSQL integration](../../../tests/integration/gaming-authority-http.pg18.integration.test.ts), [compiled fixture](../../../tests/fixtures/gaming-authority-compiled-http.mjs) |

The matrix composes the same production gates across applicable routes. It does
not claim an exhaustive Cartesian enumeration of every source status, route and
possible hostile input. Rejected sources cannot enter retention; v1 reference
candidates cannot supply accepted gameplay; v2 explicit owner-confirmed retained
candidates remain outside accepted evidence. Automatic storage requires the
reviewed source category and standing permission; the MCP confirmation contract
is preserved.

## Additional integration defects found during remediation

- The initial repair's locking SELECT could observe stale history under READ
  COMMITTED. An independent real PostgreSQL barrier reproduction demonstrated
  this; the history read now follows the acquired lock in a fresh statement.
- An old same-content approval could otherwise regain authority after a later
  held revision. The durable history count and pre-assessment epoch prevent
  this and force distinct, current revision provenance.
- Reusing that same held B after a fresh A grant initially failed to advance the
  restriction count. A further real PostgreSQL repeated-cycle regression caught
  the bypass; held identity now includes prior durable grants.
- A real acquired assessment made with an application clock ahead could cross a
  later hold if wall-clock ordering were the sole freshness boundary. The
  pre-assessment durable restriction epoch closes that path independently of
  clock ordering. Wall-clock comparisons no longer authorize reassessment.
- Optional applicability properties set to `undefined` were hashed before queue
  JSON encoding. PostgreSQL JSON removed them, so unchanged valid approvals were
  rejected as `APPROVED_APPLICABILITY_EXPIRED`. This also reproduces on original
  base. Admission and worker now bind the same strict, JSON-normalized context
  and assessment. Tampered region, expired and malformed approvals still reject.
- Broad positive controls caught intermediate overly narrow claim syntax. The
  genuine original procedure and factual assertions remain enforced.
- Split inline and entity-encoded publisher restrictions could disappear during
  footer cleanup. The complete parser-visible body is inspected before omission,
  alongside the existing raw scan. Layout, list-inventory and ancestry exhaustion
  carry attested unverified applicability instead of making a source unrestricted.
- Decoded typed-build notes could forbid automated use yet remain citable after
  an HTTP503 fallback. This also reproduces on original base. Restrictions now
  stop decoded projection, fallback, caching, adapter rescue and persistence;
  decoded supported JSON units also retain the acquired restriction flag.
- Official release metadata is allowed only for its independently reviewed
  currentness role; it cannot supply gameplay claim support by itself.

## Environment and validation boundaries

Local acceptance uses native Windows x64 and portable PostgreSQL 18.6 on a
dedicated loopback test database. Each SQL suite uses an isolated schema and
actual transactions. The compiled HTTP test launches the current compiled
application modules, a real authenticated MCP listener, the actual SQL queue and
claimed-job worker execution, and a separate retrieval process. External DNS and
publisher transport map only fixed fixture hosts to a loopback HTTP server;
production URL admission, pinned HTTPS options, byte meters, extraction,
attestation, authorization and validators execute. Unexpected outbound sockets
and fetch calls fail the test.

Generation and semantic provider HTTP responses are explicitly synthetic. The
real SDK, adapter, Trinity facade/engine, structured reasoning, final authority,
default provider admission and Gaming answer audit execute against an exact
loopback provider origin; no internal generation module is replaced. This proves
application gating, audit parsing/binding and grounded response validation, not
model quality. The 65,536-byte MCP catalog ceiling,
OAuth/write scopes, confirmation and idempotency contracts remain unchanged.
Verified patch authority is separately tested as insufficient for an unsupported
standalone gameplay answer.

IGN-like identity fixtures are explicitly synthetic. They exercise the actual
protected acquisition/parser architecture, independent primary definitions,
concatenated navigation, exact local references, surrounding wrong-game facts,
forged/overlapping spans, linked qualifiers and whole-source restrictions. No
historical response body/hash is available, so historical IGN byte equivalence
is not claimed. The frozen historical preview image is not current-head E2E
evidence.

Final full-suite, Windows assertion-comparison and exact-head CI receipts belong
to the final PR acceptance report. A skipped required integration or pending
required exact-head CI check is unverified, never PASS. This document does not
authorize a merge or production change.

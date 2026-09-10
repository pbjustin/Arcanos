# Gaming structured source evidence

The shared Gaming document resolver preserves bounded HTML and inert JSON
records alongside ordinary article prose. The extraction policy is
`gaming-evidence-units/v1`; claim selection uses
`gaming-structural-sufficiency/v1`. A short record can support a narrow source
assertion without 120 characters or sentence-ending punctuation. Extraction
does not establish source authority, current applicability, complete answer
coverage, or permission to store.

## Historical evidence and confirmed defects

The implementation base is
`765cce453f4e014d7776faa9e8de9d195c2bdb23`. Historical workflow
`65c243c2-f265-442a-8786-91c0c11e8326` reported three candidates, zero accepted,
three rejected, and zero selected chunks. Initial query
`req_1789063069765_x9rizl` preceded candidate submission
`req_1789063111280_vvxcxi` at `2026-09-10T17:58:31Z`. Each reported extraction
failure, `INSUFFICIENT_EXTRACTION`, `gaming-https-acquisition-v1`, zero redirects,
and source CLEAR `not_run`.

Those observations establish the rejection stage only. The exact three URLs and
response bodies were unavailable. They do not establish tables, empty shells,
JavaScript requirements, bot blocking, redirect behavior, or a real resource
location. No historical website was diagnosed or verified by this change.

Failing synthetic tests demonstrated loss of a sparse table outside the preferred
article and a 76-character JSON response arriving as unstructured text. Inspection
also identified independent hybrid/source-CLEAR prose floors, last-period clipping,
structural whitespace loss, and chunk/context assumptions. The regression suites
exercise the replacement behavior through the shared resolver and downstream
gates. `TEST-ORION-01`, its body/site/resource tuple, Ashfall equipment, and Rift
Seasons patch records are invented fixtures.

## Acquisition and extraction

The existing [protected acquisition policy](GAMING_SOURCE_ACQUISITION.md)
still owns URL admission, DNS/IP validation, TLS, redirects, cancellation,
aggregate transfer/decode bytes, and the absolute deadline. Each strategy reads
the same accepted response. Structural parsing runs before destructive cleanup;
selected structural containers are removed from the prose fallback to prevent
their flattened contents from bypassing record integrity checks. Ordinary article
selection continues for the remaining prose. No browser, script execution,
linked-page fetch, pagination, crawler, OCR, or additional PDF parser is added.

Supported HTML structures are headered tables with captions, nearby headings,
row/column headers and explicit header associations; bounded unambiguous spans;
ordered/unordered lists with record hierarchy; and `dt`/`dd` associations.
Headerless or ambiguous mappings remain insufficient. Footnotes, table-footer
corrections and relevant qualifiers remain attached. Responsive copies are
deduplicated; unrelated rows, nested layout tables and unrelated bullets never
supply missing fields for each other.

Community selection uses explicit `DiscussionForumPosting` markup together with
its article/main containment. It preserves available author attribution while
keeping quoted claims and unrelated comments out of affirmative record evidence.
Markup is a selection hint, not an authority credential. This is deliberately
narrower than support for arbitrary forum layouts.

Inert JSON accepts strict flat gameplay records or explicit `records`,
`locations`, `equipmentStats`, and `patchChanges` groups. Embedded JSON-LD supports
`Dataset.variableMeasured` sets of `PropertyValue` entries and `ItemList` records.
The accepted script types are `application/json` and `application/ld+json`.
Direct `application/json` responses are supported; direct
`application/ld+json` responses remain outside the acquisition media-type
allowlist. Arbitrary application-state traversal, assignment scripts, JSONP,
remote contexts, imports, and referenced endpoints are unsupported. The existing
separate structured-build adapter keeps its established contract.

The JSON parser rejects duplicate decoded keys, conflicting field mappings,
prototype keys, malformed or incomplete JSON, unknown record fields and unsafe
selected values. Numeric tokens retain their original signs, decimal precision
and exponent spelling. Embedded game/patch labels are source assertions. `@id`,
`@context`, and claims of authority do not grant trust or trigger requests.
Embedded records retain bounded visible headings and applicable surrounding
qualifiers. A visible example-only or unavailable notice cannot disappear merely
because the tuple lives in JSON. A closed script inside an unclosed truncated
article/section remains partial because a trailing qualifier could be missing.

## Bounds and integrity

| Boundary | Limit |
| --- | --- |
| Existing accepted transport | Default 1,500,000 bytes; configured hard ceiling 5,000,000 bytes; unchanged aggregate wire/decode accounting |
| HTML before DOM parsing | 1,500,000 characters; 30,000 opening elements |
| HTML structures | 128 tables; 1,024 rows/table; 32 columns; span 64; 32,768 expanded cells; 256 lists |
| HTML units/output and merged extraction | 2,048 units; 1,000,000 output characters |
| Conflict comparison before selection | At most 4,096 validated candidate units across strategies; final output remains capped at 2,048 and omitted conflicts still invalidate retained assertions |
| HTML fields/context | 32 fields/unit; 1,024 characters/value; 512 characters/context value; 4,096 characters/unit |
| JSON parsing | 262,144 bytes/payload; 524,288 cumulative JSON bytes; 16 inert scripts; depth 12 |
| JSON containers | 64 keys/object; 4,096 total keys; 256 array entries; 4,096 characters/parsed string |
| JSON records/output | 256 records; 32 fields/record; 160 characters/label; 1,000 characters/value; 16 qualifiers of 400 characters; 4,096 characters/unit; 200,000 output characters |
| Embedded visible context | Six ancestor levels; two nearby siblings per direction; at most 64 scope paragraphs plus 64 ancestor candidates; 160 characters/attribution |
| JSON work deadline | At most 1,000 ms, additionally bounded by the caller's earlier deadline; DOM input is independently bounded |
| Selected document text | Ordinary live projection 100,000 characters; durable/hybrid accepted projection up to 1,000,000 |
| Durable chunks | Existing 500 chunks; target 1,800 characters; maximum 2,000; prose overlap at most 240; revision preview 16,000 |

Executable constants are authoritative: [HTML extraction][html-code],
[JSON extraction][json-code], [sufficiency][suff-code], and [chunking][chunk-code].
Extracted units up to 4,096 characters can be represented, but an indivisible unit
over the existing 2,000-character retrieval/chunk budget is not usable answer
evidence and is omitted from indexing rather than clipped into a false record.

Each internal unit carries its kind, deterministic ID/text, original bounded
field values and labels, record scope, relevant heading/caption/qualifiers,
available attribution, source URL, extraction policy/strategy, locator, and
`complete`, `partial`, or `ambiguous` integrity with reasons. Generated labels
and repeated headers are never evidence of text-length sufficiency.

HTML locators describe DOM scope; JSON locators describe a response/script scope
and JSON pointer. JSON-only assertions retain `jsonOnly: true`. Chunk offsets
address the accepted normalized/serialized text in UTF-16 code units, not raw
HTML positions. No page numbers, coordinates, observation dates, missing values,
publisher status, or patch versions are synthesized.

Transport failure, capped raw preview, extraction omission, output truncation,
intact selected units, and full document coverage are separate states. The full
accepted response drives extraction even when the diagnostic preview is capped.
An HTML parser's repaired end tag cannot establish completeness after a cutoff;
partial JSON is never repaired. A demonstrably closed and adequately scoped unit
can survive truncation elsewhere. Legacy prose keeps its intact-sentence rule.

## Claim sufficiency and CLEAR

One shared structural usability result feeds hybrid admission, source/evidence
CLEAR, ingestion quality, and stored selection. It asks whether an intact record
exists and whether a single supported scope supplies the requested claim. A
location requires system, body, site and resource together. A statistic requires
item, statistic, value, unit and applicability scope. Patch changes require a
mechanic, actual change or before/after values, and applicability. Build records
require their equipment/skill associations and scope.

Missing fields remain missing. Requested entity anchors cannot be satisfied by
another system that happens to use the same body name. Negative, depleted,
unconfirmed, superseded or example-only location records cannot become exact
affirmative locations. Contradictory visible and JSON records are marked
ambiguous before query selection and durable indexing.

CLEAR retains Clarity, Leverage, Efficiency, Alignment and Resilience, their
thresholds, and the non-compensable gates. A supported structure supplies truthful
intelligibility and narrow coverage features, with reserved resilience credit.
Successful parsing grants neither maximum scores nor freshness. Wrong game,
edition, patch, source-use restrictions, insufficient claim coverage and unsafe
instructions can still reject the source after extraction.

Hard acquisition failures and absence of intact usable evidence leave source
CLEAR `not_run`. Later assessment failures keep their actual stage. Recovery
distinguishes extraction failure, extracted-but-insufficient records, and a
reported tuple whose current in-game applicability remains unverified. Three
failed sources cannot establish that no public location exists.

## Persistence, refresh and consent

The document's extraction is independent of the question. Accepted text, units,
interpretation metadata and extraction policy bind source approval and revision
hashes. Question-specific assessments retain separate caller/context bindings.
A substantive late-row change changes approval/revision identity even when the
stored preview is unchanged.

Existing chunk records carry their own unit metadata, required labels and
qualifiers through transient context, authorized persistence, lexical retrieval,
and citations. Whole guides are not copied into every row. Unchanged refresh,
atomic supersession, last-good revision retention, caller-bound approval,
idempotency and source-policy checks remain in their existing paths. Legacy
records remain readable without invented structural provenance. No schema tables
or production backfill are added. An intact community record does not authorize
automatic storage or override transient-only policy.

Operator diagnostics expose bounded strategies, content type, received/accepted
bytes where available, raw/extracted counts, unit kinds/integrity counts,
truncation stages, missing claim fields, subreasons and timing/budget outcome.
They do not contain guide text, raw HTML/JSON, credentials, cookies, private URLs,
full prompts, or transport errors. No standalone live diagnostic was introduced;
no read-only test of the historical websites was possible without their URLs.
The [diagnostic regression suite][diagnostic-tests] checks preview versus output
truncation, sanitized counts, demonstrated empty/login/challenge/image/dynamic
shells, absence of speculative diagnoses from short text, source-use restrictions
outside the preferred container, embedded shell bypass, grouped-header
qualifications, query-independent extraction, and original-body guards.

## Regression coverage and proof limits

[Hybrid lifecycle][hybrid-tests] uses controlled HTTP/DNS, the actual resolver,
structural sufficiency and source/evidence/answer CLEAR, a disposable in-memory
repository harness, and mocked provider output/semantic judgments. It proves the
short record reaches an answer, authorized ingestion and later no-URL retrieval;
it does not establish live model judgment quality. [PostgreSQL tests][pg-tests]
exercise real SQL/storage only with the guarded disposable PostgreSQL 18 target.
The local run skipped all eight PostgreSQL cases because that target was absent;
this skip is not SQL evidence. CI and live evaluations must be reported separately.

### Required disposable PostgreSQL CI path

The existing [CI/CD Pipeline](../.github/workflows/ci-cd.yml) runs for pull requests
targeting `main` or `develop`, including ordinary PR updates, without path filters.
Job `local-agent-postgres-concurrency`, displayed as **PostgreSQL Fencing & Local
Agent Concurrency**, uses Ubuntu and a healthy `postgres:18-alpine` service. It
sets the dedicated `JOB_CLAIM_FENCING_TEST_DATABASE_URL` to its loopback disposable
database and requires `ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1`.

After pinned Node setup and `npm ci`, that job runs
`npm run test:local-agent-postgres`, then `npm run test:postgres-fencing`. The latter
explicitly includes `tests/integration/gaming-durable-rag.pg18.integration.test.ts`
under the root Jest configuration. The similarly named
`jest.phase2e-pg18.config.js` belongs to a separate ActionPlan migration suite and
does not select these Gaming tests. A missing dedicated database fails the
required-database guard instead of silently skipping; the Gaming suite separately
verifies the disposable database name and PostgreSQL major version before
creating its isolated schema. The wrapper clears ambient production database
variables.

The existing [PostgreSQL CI truth contract][pg-contract-tests] checks these command,
suite and required-database bindings. **All Checks Complete** depends on this job
and fails for any non-success dependency. Actual SQL proof requires the matching
PR commit's successful job log showing the Gaming suite ran, including both new
structured lifecycle/refresh tests. A workflow definition, local skip, service
startup, or aggregate success message alone does not substitute for that log.

The numbered mapping follows the task's required regression cases. Test presence
is not a claim that every repository suite or external environment was run.

| Case | Concrete coverage |
| --- | --- |
| 1. Sparse headered table | [HTML][html-tests]: sparse attributable tuple; [hybrid][hybrid-tests]: short structured lifecycle |
| 2. Record below 120 characters | [HTML][html-tests], [JSON][json-tests], [sufficiency][suff-tests], [hybrid][hybrid-tests]: explicit length assertions without padding |
| 3. Lists and `dt`/`dd` | [HTML][html-tests]: equivalent labeled/nested/definition records |
| 4. JSON-only provenance | [JSON][json-tests] and [resolver JSON][json-resolution-tests]: one record with `jsonOnly` and JSON-pointer provenance |
| 5. Prose compatibility | [HTML][html-tests] ordinary article test; [resolver][resolver-tests] and [web context][web-tests] existing prose suites |
| 6. Preferred article loses table | [HTML][html-tests]: table outside preferred article |
| 7. Primary community versus comments | [HTML][html-tests]: primary post, author, quotation and correction isolation |
| 8. Multirow headers/spans | [HTML][html-tests]: multirow headers, explicit header IDs and rowspan relationships |
| 9. Responsive/nested duplicates | [HTML][html-tests]: responsive copies and nested layout tables |
| 10. Headerless/ambiguous failure | [HTML][html-tests] and [sufficiency][suff-tests]: ambiguous structures remain unusable |
| 11. Missing required fields | [sufficiency][suff-tests] and [hybrid][hybrid-tests]: site/body/resource omissions do not answer or persist |
| 12. Cross-row false tuple | [HTML][html-tests], [sufficiency][suff-tests], [hybrid][hybrid-tests]: unrelated records never combine |
| 13. Negative/correction/stale qualifiers | [HTML][html-tests], [JSON][json-tests], [sufficiency][suff-tests], [hybrid][hybrid-tests] |
| 14. Same body, different systems | [HTML][html-tests] and [sufficiency][suff-tests]: separate scopes and requested-system binding |
| 15. Wrong game/edition | [hybrid][hybrid-tests]: `rejects wrong-game and unverified-edition sparse records after successful extraction`; [CLEAR source][clear-tests] retains general identity gates |
| 16. Undated currentness | [hybrid][hybrid-tests]: `keeps an undated structured community report transient on request and does not assert present availability`; short lifecycle retains `unverified` applicability |
| 17. Intact units before cutoff | [HTML][html-tests], [JSON][json-tests], [sufficiency][suff-tests]: closed scopes survive unrelated truncation |
| 18. Cutoff inside cell/object | [HTML][html-tests] and [JSON][json-tests]: repaired tags and incomplete objects fail |
| 19. No JSON requests/execution | [JSON][json-tests]: fetch spy, script/JSONP/assignment and DOM-script isolation |
| 20. Resource bounds | [HTML][html-tests] huge spans/tables; [JSON][json-tests] depth/bytes/keys/arrays/scripts/DOM/output/deadline limits |
| 21. Injection/source-use controls | [diagnostics][diagnostic-tests]: source restriction outside selected prose and original-body guard; [hybrid][hybrid-tests], [JSON][json-tests], [HTML][html-tests], [source HTTP][http-tests] |
| 22. Login/challenge shells | [diagnostics][diagnostic-tests]: demonstrated login/challenge shells and embedded JSON bypass; [HTML][html-tests] and [web context][web-tests] navigation/authentication rejection |
| 23. Image/dynamic unsupported | [diagnostics][diagnostic-tests]: image/explicit JavaScript-required shells and no speculative short-text diagnosis; [HTML][html-tests] and [web context][web-tests] |
| 24. Numbers/versions | [HTML][html-tests], [JSON][json-tests], [sufficiency][suff-tests]: signs, decimals, versions and before/after values |
| 25. Query-independent extraction | [diagnostics][diagnostic-tests]: caller `preferredContentTerms` does not alter extraction; [JSON][json-tests] stable serialization; [hybrid][hybrid-tests] changed question retains document text/hash |
| 26. Unchanged refresh | [hybrid][hybrid-tests]; [PostgreSQL][pg-tests] guarded unchanged-revision assertions |
| 27. Late change/supersession | [hybrid][hybrid-tests]; [PostgreSQL][pg-tests] guarded late JSON revision and source refresh assertions |
| 28. Beyond 100K | [JSON][json-tests], [hybrid][hybrid-tests], [resolver][resolver-tests]; guarded [PostgreSQL][pg-tests] |
| 29. Approval/cache binding | [hybrid][hybrid-tests]: late content, metadata, policy/context, and idempotency binding assertions |
| 30. Unauthorized/transient persistence | [hybrid][hybrid-tests]: consent, caller ownership, explicit undated community `transient_only` record and storage policy gates |
| 31. Non-Gaming compatibility | [resolver][resolver-tests]: legacy shared fetch text bounds/redirect behavior; [web context][web-tests]: established prose paths |

[html-code]: ../src/services/gamingHtmlEvidence.ts
[json-code]: ../src/services/gamingJsonEvidence.ts
[suff-code]: ../src/shared/gaming/gamingStructuralEvidence.ts
[chunk-code]: ../src/services/gamingDurableDocumentChunks.ts
[html-tests]: ../tests/gaming-html-evidence.test.ts
[json-tests]: ../tests/gaming-json-evidence.test.ts
[json-resolution-tests]: ../tests/gaming-json-evidence-resolution.test.ts
[suff-tests]: ../tests/gaming-structural-sufficiency.test.ts
[hybrid-tests]: ../tests/gaming-hybrid-lifecycle.integration.test.ts
[pg-tests]: ../tests/integration/gaming-durable-rag.pg18.integration.test.ts
[resolver-tests]: ../tests/gaming-document-resolution.test.ts
[clear-tests]: ../tests/gaming-clear-source.test.ts
[http-tests]: ../tests/gaming-source-http-boundary.test.ts
[web-tests]: ../tests/gaming-web-context-quality.test.ts
[diagnostic-tests]: ../tests/gaming-structure-diagnostics.test.ts
[pg-contract-tests]: ../tests/postgres-ci-truth-contract.test.js

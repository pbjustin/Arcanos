# PR #1592 CodeRabbit second follow-up

This advisory record covers the review of
`318385651d33a623f0cb8b4c9cc698d5e3cfd81b`, against original PR base
`52d859c2ae15c3cc15befbc7d6cc7538f20753b5`. Earlier dated records preserve
their own captured results. The accompanying report binds final application
tests, source hashes and review disposition to the published commit. The user
requested that this work close without waiting for GitHub CI; pending CI is
unverified, and this record supplies no merge or deployment approval.

All publisher and provider inputs are authored synthetic fixtures. Database
acceptance uses isolated schemas in the owned disposable PostgreSQL 18 cluster.
No live publisher ingestion, paid provider, production mutation, migration,
dependency, deployment or additional bot review request is required.

## Findings and regression map

| Finding | Repair boundary / permanent fixture |
| --- | --- |
| Supported aliases hide a restriction behind a preferred clean field | Independently inspect every supported alias without changing normalization preference. [Extraction fixtures](../../../../tests/gaming-cr2-extraction.test.ts) preserve unused-field/instruction bounds and reject cached fallback evidence. |
| Live fetch/cache loses applicability uncertainty | Carry parser-owned metadata through resolved fetch, cache and freshness projections. The extraction fixtures test initial and cached prose-only list-budget exhaustion. |
| Repeated local references collapse or bind the wrong occurrence | Bind each exact paragraph/frame occurrence before projecting bounded text. Repeated linked and identical unlinked controls preserve genuine game conflicts and surviving spans. |
| Early catalog retention precedes explicit applicability checks | Apply conflict checks before each retention exit. [Retention fixtures](../../../../tests/gaming-cr2-retention.test.ts) reject explicit platform/region conflicts while preserving compatible storage-only retention. |
| Retained build/meta records become guide records | Bind the private retained record type to worker storage and retained revision identity; retain legacy default handling. The retention fixtures inspect type-filtered records and revision reuse. |
| Rejected restriction refresh leaves old authority active | Persist an idempotent metadata-only source hold under the exact canonical source lock. [Actual SQL fixtures](../../../../tests/integration/gaming-cr2-source-hold.pg18.integration.test.ts) preserve old readable provenance, reject stale queues, exercise fresh-process retrieval, rollback, retry and concurrent locking, and require a new current assessment to restore authority. |
| Later refill timeout discards already usable evidence | Preserve only completed, still-authorized records after an internal deadline. [Refill fixtures](../../../../tests/gaming-stored-authority-refill.test.ts) retain caller cancellation, unknown-SQL-error rejection and observed hold/revision eviction. |
| First twenty identities starve later eligible sources | Continue deterministic twenty-source windows under the same deadline/signal. [Actual SQL](../../../../tests/integration/gaming-authority-read.pg18.integration.test.ts) places twenty held sources above a valid guide; source/edition scope and per-query ID limits remain. |
| Decimal game definition loses identity | Preserve decimal periods in definition subjects and sentence-boundary handling. [Protected claim/identity fixtures](../../../../tests/gaming-cr2-claim-identity.test.ts) include the wrong-game decimal negative. |
| Registered alias definition becomes gameplay | Exclude definitions for equivalent registered names without collapsing sequels or editions. The protected fixtures reject a nominal Diablo IV definition for a Diablo 4 request. |
| Weight fact is rejected | Recognize the factual weighs predicate; nominal weight/topic labels remain excluded. |
| Authorship survives in returned claim text | Return the eligible gameplay projection rather than the original metadata sentence. Coverage and generation tests reject authorship-only questions while preserving factual continuations and negation. |
| Source-navigation instruction becomes gameplay | Exclude read/consult/browse source-navigation frames. Unfetched walkthrough text cannot satisfy evidence support or open generation; genuine gameplay reading steps remain covered. |
| SQL harness accepts an unstamped marker-bearing revision | Use the same reassessment predicate as PostgreSQL. [Harness controls](../../../../tests/gaming-cr2-source-harness.test.ts) require the hold with zero explicit restricted revisions. The affected compaction negative is strengthened to empty selected evidence and rejection while raw historical text remains readable. |
| Harness ignores search offset | Honor record and identity offsets, preserving actual exhaustion versus deadline failure. The harness controls verify distinct consecutive pages. |

Focused owning-source fixtures reproduced the behavioral findings before their
repairs. The report distinguishes those reproductions from controls and later
regressions found during combined review; skipped diagnostic selections are not
required integration passes.

## Additional independently reproduced boundaries

An escaped decoded restriction combined with instruction injection could keep
the primary instruction error while losing the restriction signal. A pure,
bounded supported-field observer now sets the canonical source-use flag before
document attestation, including full accepted raw bytes before display-preview
truncation. Immediate hybrid, live and cached paths cannot bypass it. Worker
permission observation also precedes stale hybrid/retained artifact rejection,
so the first queued observer records a metadata hold. It invokes no adapters,
cache or full build normalization on rejected documents. Instruction-only
controls do not invent a publisher restriction.

An attested internal decoded-only origin flag preserves the established visible
restriction and instruction/artifact ordering. The canonical source-use flag
remains bound in the approval hash; a newly detected permission change can
therefore reject a previously accepted artifact as changed. No permission field
is removed from hashing to preserve a former error code.

Security inspection also covers accepted equipment entries beyond the normal
128-item output cap, including primitive arrays and slot-map keys/values.
[Count-boundary fixtures](../../../../tests/gaming-cr2-equipment-cap.test.ts)
reproduced three restriction misses before the repair. The existing structural
ceiling remains 256 entries and admitted build output remains capped at 128;
unknown telemetry still cannot supply a consumed source-use field.

The same observed-restriction rule covers authorized duplicate ingestion of an
existing canonical source, including protected redirects. A missing refresh ID
cannot preserve obsolete authority. Unknown restricted sources retain no
publisher content; source lookup and any metadata hold remain separately
observable in the transaction controls.

Claim projection controls also preserve procedure facts when a parser-owned
heading precedes an explicit game clause, including parenthetical prohibitions
and procedures before that scope. They do not waive independent source identity
or genuine conflicting-game checks.

The broad regression run exposed two compatibility defects in the combined
change: ordinary extraction forwarded the full reference-mapping ceiling instead
of the requested context size, and retention checks replaced primary identity
errors with applicability errors. Code repairs restore the original limits and
identity-stage ordering. All existing argument, timeout, reason-code and stage
assertions remain unchanged. Full selected-prose mapping is needed only for
parser-owned local references; permission inspection always sees the full
accepted body independently of that context size.

## Historical verifier coverage

The review's test nit adds a passing matching historical catalog beside the
existing rejection controls in
[the verifier suite](../../../../tests/gaming-mcp-preview-verifier.test.ts).
The committed 65,103-byte catalog fixture was reconstructed from three existing
pure Git source/schema blobs at `848d6be5fc7d73936bb7921bd496d3051e30752d`;
its exact tool-array hash is
`d43aa08b59e003f447bbb2e24e9bc116f67c0e66778cd3d9de1e6f1785de4953`.
The transport remains synthetic. This is neither execution of a historical image
nor a substitute for current-head compiled application acceptance.

## Acceptance boundaries

Current compiled HTTP/MCP, real queue/worker/SQL and fresh-process acceptance
remain separate from mocked fixture compatibility and the historical verifier.
The new source-hold SQL suite is registered in the existing required PostgreSQL
command and its strict literal registry. No required database skip is reported
as a pass. READ COMMITTED refill is not a global snapshot; observed holds and
revision changes invalidate that source for the current lookup. Historical IGN
response bytes and their hash remain unavailable, so no historical byte
equivalence is claimed. Independent final-head Cloud review and required CI
remain separately reported merge gates.

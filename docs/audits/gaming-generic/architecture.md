# Gaming generic architecture baseline

Audit baseline: repository branch `work`, commit
`200463b3aac65eb494f71d842c1e2b0378530bfb`. The checkout was clean before
the audit. This report describes source inspection; it does not establish the
deployed SHA, live publisher accessibility, or current provider behavior. The
issue/production evidence and validation report supply those separate facts.

## Existing path and boundaries

The released contract is `gaming-hybrid-v2`; explicit v1 remains supported
(`src/shared/gaming/gamingHybridContract.ts:4`).
`createGamingHybridWorkflow` in `src/services/gamingHybridKnowledge.ts:91`
owns actor-scoped transient state, revisions, operation idempotency, candidate
budgets, and terminal workflow outcomes. Frontend discovery hints are excluded
from the evidence request by `evaluateGamingHybridCandidates` in
`src/services/gamingHybridCandidates.ts:121`; only the URL drives acquisition.

The candidate evaluator performs safe admission, protected acquisition,
resolver identity attestation, instruction/restriction checks, structural
usability, source policy, freshness/applicability, deterministic source CLEAR,
chunking, relevance filtering, then bounded evidence selection. The ordinary
live and durable paths share `resolveGamingDocument` in
`src/services/gamingDocumentResolution.ts`. HTML/JSON extraction produces
versioned `GamingEvidenceUnit` records, locators, context, and integrity facts.
These facts are source assertions; they grant no authority or freshness.

`assessGamingClearSourceIdentity` in
`src/shared/gaming/gamingClearSource.ts:123` combines game identity with edition
outcomes. `assessGamingClearSource` at line 310 builds the deterministic source
CLEAR contract. `assessGamingClearEvidence` in
`src/shared/gaming/gamingClearEvidence.ts:50` checks the actual selected set,
bounded context, scope, traceable provenance, request coverage, currentness, and
contradictions. `selectGamingHybridAcceptedEvidence` and
`selectGamingHybridEvidence` in `src/services/gamingHybridCandidates.ts:420`
and `:488` assess material conflicts before compacting the selected pool.

`runGameplayPipeline` in `src/services/gamingPipeline.ts:666` checks evidence
CLEAR before provider dispatch, retains request/evidence through Trinity, and
rechecks deterministic evidence at return. `runGamingClearAnswerAudit` in
`src/services/gamingClearAnswerAudit.ts:68` performs one bounded semantic audit
with no tool calls, repairs, or retries. `gamingClearAnswerMatches` at line 62
binds the exact answer hash; successful fallback/incomplete output cannot become
a completed grounded answer. The final gate in
`src/services/gamingPipeline.ts:1647` requires matching accepted answer and
evidence context fingerprints.

## Classified findings

| Classification | Finding and exact reference | Implication |
| --- | --- | --- |
| Confirmed defect | `assessGamingClearSourceIdentity`, `gamingClearSource.ts:143`, rejects any foreign `Game` field across all units; `selectGamingEditionScopedEvidence`, `gamingStructuralEvidence.ts:100`, repeats this before distinguishing metadata-only from gameplay records. | An independently scoped unrelated gameplay row invalidates the whole source. The code already distinguishes global metadata with `isGamingDocumentMetadataUnit` at `gamingStructuralEvidence.ts:41`, but these checks ignore it. Regression reproduction must precede repair. |
| Architectural weakness | `acquiredBodySubjects`, `gamingClearSource.ts:52`, and its consumer at line 211 treat every affirmative acquired `in <game>` clause as a source-wide assertion. | Closed comparison/negation handling helps, but there is no typed distinction between local gameplay description and primary article scope. This is a mechanism-level weakness, not an established explanation of each production failure. |
| Architectural weakness | `extractGamingFreshnessMetadata`, `gamingFreshnessCore.ts:183`, imports complete gameplay fields into a pooled metadata grammar unless base-game record selection succeeds. | Different locally scoped identities/editions/platforms can become global contradiction claims. Scope projection needs to be shared with identity/applicability before metadata aggregation. |
| Architectural weakness | `assessGamingClearSourceIdentity`, `gamingClearSource.ts:123`, returns identity and edition reasons in one assessment; caller prechecks duplicate several rules (`gamingHybridCandidates.ts:232-268`). | Stages exist operationally but do not have one typed, versioned source-evaluation contract. Duplicated precedence can drift. |
| Missing capability | No generic identity registry with provenance, canonical IDs, aliases, related titles, expansion/edition relationships, and registry version was found. | Recognition knowledge is scattered through runtime validators. Unknown-title inference exists, but it is not a reviewed registry entry and must not grant authority. |
| Acceptable existing behavior | Primary-subject checks use document title and only an acquired first heading repeated at the prose start (`gamingClearSource.ts:151-170`). Pooled later headings cannot establish identity or requested edition applicability. | Preserve these safeguards while improving local evidence scope. |
| Acceptable existing behavior | `assessGamingClearSourceIdentity`, `gamingClearSource.ts:243-256`, requires independent acquired anchors or a reviewed source association; uncertain identity remains `GAME_IDENTITY_UNVERIFIED`. | User names, URL inference, and unreviewed publisher metadata alone are not acquired proof. |
| Acceptable existing behavior | Candidate artifact validation binds actor/workflow, TTL, policy, content hash, resolver attestation, assessment, source context, and metadata (`gamingHybridCandidates.ts:396`). | Scope projection must preserve original acquisition/hash identity and separately bind selected records. It must not overwrite the acquired document to manufacture an attestation. |
| Acceptable existing behavior | `assessGamingClearEvidence`, `gamingClearEvidence.ts:50`, and full-pool selection prevent material contradictions from disappearing during compaction (`gamingHybridCandidates.ts:441,491`). | Retain conflict-first selection and provenance membership checks. |
| Acceptable existing behavior | Workflow v2 allows two gameplay discovery rounds, six total candidate URLs, 24 seconds total candidate acquisition; currentness remains one separate round (`gamingHybridContract.ts:15-24`). | Existing recovery already satisfies bounded-budget essentials; do not replace it or mint new workflows to evade exhaustion. |
| Acceptable existing behavior | v2 terminal `answer`/`stop` closes the workflow; cancellation and evidence-membership errors also close it (`gamingHybridKnowledge.ts:165-194`). | New recovery diagnostics must preserve lifecycle semantics and idempotency. |
| Architectural weakness | Source logs expose bounded identity rule/category and extraction counts but lack an explicit outcome for every independent stage (`gamingHybridCandidates.ts:155-168,279-292`). | Extend existing structured logging with a versioned decision trace, rather than logging raw content or creating a second audit sink. |
| Acceptable existing behavior | Workflow handoff logs include request/workflow correlation, revision, selected counts, recovery remaining, terminal action, and budgets (`gamingHybridKnowledge.ts:171`). CLEAR answer telemetry includes versions, result, reasons and bounded audit budget (`gamingClearAnswerAudit.ts:88`). | Reuse these sinks and redaction; fill source-stage gaps. |
| Unverified hypothesis | Publisher furniture retained during extraction may have caused some of the six reported source mismatches. | Only the recorded structured diagnostics and acquired sanitized fixtures can establish that relationship. Static code and synthetic previews do not prove it. |
| Unverified hypothesis | A larger provider/audit budget fixes live production generation reliability. | Existing exact-answer, timeout, incomplete-completion and final audit gates are visible; live timing/provider success remains untested without separate authorization. |

## Game-specific runtime dependency inventory

Fixtures and tests intentionally retain named examples. These active runtime
dependencies should become configurable data or generic grammar:

| File/function | Embedded dependency |
| --- | --- |
| `src/services/gamingGameDetection.ts:20`, alias catalog, `canonicalAlias`, `canonicalizeGamingGameName` | Named game alias regexes, WoW/LoL special canonicalization; title/topic vocabulary includes Samurai, katana, bleed, and attributes. |
| `src/shared/gaming/gamingGameIdentity.ts:49`, `resolveGamingRequestEdition` | Minecraft Java/Bedrock request grammar; Elden Ring implicit base scope and named expansion grammar. |
| `src/shared/gaming/gamingGameIdentity.ts:117`, `canQualifyGamingUnrequestedEdition`; `:129`, `gamingEditionEvidenceMatchesRequest`; `:151`, `normalizeGamingMinecraftEdition`; `:159`, `readGamingMinecraftEditionScope` | Minecraft-specific request exclusions, parent/edition normalization and source-scope policy. |
| `src/shared/gaming/gamingClearSource.ts:18`, `DISTINCT_SCOPE`; `:123`, identity assessment | Nightreign, Shadow of the Erdtree, Minecraft Dungeons/Legends/Story Mode, Java/Bedrock family exceptions and edition title checks. |
| `src/shared/gaming/gamingStructuralEvidence.ts:50`, `gamingEditionConflictText`; `:62`, `classifyGamingEditionRequirements`; `:82`, `selectGamingEditionScopedEvidence` | Named expansion and Nightreign regexes inside generic requirement and scope policy. |
| `src/shared/gaming/gamingFreshnessCore.ts:221`, `extractGamingFreshnessMetadata` | Minecraft-specific edition derivation and parent game collapse. |
| `src/services/gamingHybridCandidates.ts:258`, candidate evaluation | Minecraft-specific allowance for unrequested acquired edition before later identity assessment. |
| `src/services/gamingHybridKnowledge.ts:361`, workflow continuation | Minecraft-specific edition question and Elden Ring expansion question. |
| `src/shared/gaming/gamingHybridPolicyCore.ts:144`, `gamingGuideSearchHint` | Samurai/Uchigatana/katana topic literals in privacy-bounded discovery hints. |
| `src/shared/gaming/gamingRetrievalPolicy.ts:25`, `resolveGamingUserDecisionGap` | Bleed versus pure Dexterity and single katana versus dual-wield choices. |
| `src/services/gamingWebContext.ts:202,242` | Publisher trust scores and builtin named-game/source/topic catalog, including build-specific vocabulary. Configured JSON source data already exists at line 1560. |
| `src/services/gamingDocumentExtraction.ts:125`, source extraction profiles | Publisher domains and CSS selector overrides for Fextralife, Bandai Namco, Blizzard, and Icy Veins. These are adapters, not independent evidence. |
| `src/shared/gaming/gamingSourceAcquisitionCore.ts:297`, `redirectTransition` | Exact Icy Veins WoW and SWTOR reviewed host/path pairs. Preserve restrictive redirect policy while representing pairs as reviewed data. |
| `src/shared/gaming/gamingCurrentnessSourceData.ts:5` | Reviewed per-game source rules and publisher extraction literals. Already separated from generic algorithm and validated/frozen by `gamingCurrentnessRegistry.ts:101`; retain the pattern. |

## Small compatible improvement

1. Add a pure scope projection for acquired records and prose boundaries. Keep
   source-global metadata/security/primary-subject conflicts terminal; exclude
   unrelated local records and reference blocks before identity, applicability,
   selection, and generation. Preserve original acquired content hashes and
   selected-record provenance.
2. Add a validated versioned literal identity registry alongside the existing
   reviewed currentness source registry. Algorithms consume aliases and explicit
   relationships; recognition does not imply publisher authority or acquire
   independent evidence. Previously unknown names require acquired title/body
   agreement and conservative scope checks. Source-policy additions remain a
   separate reviewed registry change.
3. Add an internal additive source-evaluation contract with explicit acquisition,
   extraction, identity, applicability, relevance, freshness, authority,
   selection, and generation-readiness statuses and stable reasons. Project the
   existing public reasons unchanged where possible. Hard security or primary
   identity conflicts cannot be downgraded by later successes.
4. Extend the existing structured source/workflow logs with the contract/rule
   versions, stage outcomes, selection counts, recovery eligibility, and terminal
   state. Use closed codes/counts/opaque correlation IDs, never passages or raw
   request fields. Keep private auth, explicit storage consent, TTL, revision,
   lifecycle and deployment gates unchanged.

Extraction, caching, corroboration, and detailed recovery inventory are covered
by the companion reliability audit. No new caching infrastructure is justified
by this static inspection alone. Benchmark targets remain proposed engineering
targets; a labeled reproducible corpus must report separate false-positive and
false-negative denominators and security failures.

## Controlled source-scope repair

The baseline defects above are now reproduced and addressed in the shared task
branch; the final validation report pins the committed implementation SHA.
The frozen cross-game benchmark additionally established two security defects
through the production validator: an explicit contradictory `This guide covers
<unknown game>` was missed, and a duplicated primary title/h1 was counted as an
independent body identity anchor. These are confirmed synthetic regressions,
not established causes of the six production failures.

`selectGamingGameScopedDocument` in
`src/shared/gaming/gamingStructuralEvidence.ts:90` introduces the bounded
`gaming-game-source-scope/v1` projection. Exact parser-bound complete gameplay
records may be excluded when they explicitly name a different game. Global
metadata declarations, incomplete or ambiguous records, source-wide guide
assertions, and a foreign game paired with the requested game's registered
edition retain conservative conflict or unverified outcomes. A projection never
changes the acquired artifact, hash, or provenance. Whole-page storage remains
ineligible when only projected evidence is accepted.

`withoutBoundedGamingReferences` at line 71 removes only complete, explicitly
qualified historical or related/recommended reference sentences, with bounded
counts and closed reasons. These references cannot supply positive identity or
selected gameplay support. An affirmative guide identity following a reference
still conflicts. Unqualified foreign gameplay scope retains the existing hard
checks; this change does not infer scope from arbitrary past-tense prose.

`assessGamingClearSourceIdentity` in
`src/shared/gaming/gamingClearSource.ts:125` now consumes registry relationships
and the same evidence projection. `acquiredBodySubjects` at line 53 recognizes
explicit game declarations independently of alias catalog membership. The
positive-anchor logic at line 305 requires acquired body identity, a complete
relevant gameplay record with its own Game field, or a complete relevant record
bound by an acquired global Game declaration or parser-owned game context.
Repeated article h1 text such as `GAME guide` cannot become a second anchor
through an inherited row heading. An exact game-valued heading such as `Void
Frontier` governing a complete relevant parser-owned gameplay tuple supplies
explicit record ownership; the tuple contributes independent gameplay evidence.
The same heading without an intact tuple cannot establish identity.
Independently acquired table captions also retain compatibility. Edition selector public
reason codes remain compatible while the game-scope trace retains its distinct
integrity failure reason.

Regression order is recorded in the task validation evidence. Initial local
record fixtures failed before the projection; historical/reference cases then
failed 5 of 17 before bounded projection; the acquired-caption regression
failed 1 of 19 before the compatibility repair. An earlier focused run passed
252 tests across generic scope, live-source identity regressions, source
negation, structural sufficiency, structured supplied RAG, and the immutable
generic benchmark. An independent security review additionally reproduced
source-global declaration laundering from foreign row Notes fields (`This
article covers ...`, `This source is for ...`, and `This guide is about ...`).
Eight of 28 scope regressions failed before the shared declaration grammar and
exact-heading compatibility repair. The same closed primary-source grammar now
protects reference projection, foreign-record projection, and identity inspection.
One additional false rejection of a completely quoted passage in a foreign
record was reproduced before repair (1 of 31 scope tests failed). Closed
quotation boundaries now remain incidental; quoting only a game name or adding
a later affirmative declaration preserves the global conflict. Actual
PostgreSQL 18 Gaming validation passed all nine tests after the exact-heading
repair, including the unchanged short-source acquisition/storage/retrieval case.
The full suite,
PostgreSQL, exact-head CI, sealed preview, private identity, and production
readiness remain separate report gates. Synthetic tests do not establish live
publisher acquisition or Trinity generation.

The required full suite subsequently identified two confirmed migration
regressions. Removing a named related-title regex had omitted genuine
parser-owned adjacent corrections from edition inspection (six unchanged
hosted extraction cases). The generic unknown-title detector also classified
an explicit expansion-only declaration as a new game, yielding `GAME_MISMATCH`
instead of `EDITION_CONFLICT`. Before repair, the existing hosted suite plus
new generic corrections and expansion cases failed 11 of 171 tests.

`hasGamingRelatedRecordScopeConflict` in
`src/shared/gaming/gamingStructuralEvidence.ts:154` now reads reviewed related
titles and parent-relative names from `gamingRegistryRelatedScopeNames`.
Only parser-owned headings, captions, direct qualifications, and closed scope
fields can bind a correction; comparison/reference controls remain unchanged.
Expansion-only primary declarations use registry-owned names and closed
generic edition nouns before unknown-game inference. A definitive acquired
edition contradiction remains terminal after game contradiction inspection,
even when positive game identity would remain unverified. Arbitrary trailing
subjects cannot hide behind a matching expansion prefix.

The follow-up focused run passed all hosted extraction, source-scope, identity,
negation, Samurai workflow, and benchmark cases. Its sole failure was a live
adapter expectation loaded concurrently with its owner changing the fixture to
the stronger acquired wrong-game rejection. The subsequent frozen `e57c58f4`
full run passed `live-validation-gaming-adapter.test.ts`; that historical
concurrent-tree failure is closed by the stable rerun.
Final pinned dependency, full-suite, commit, CI, and preview results are reported
in the central validation report, rather than inferred from this evolving tree.

Integration CI also confirmed an exact-boundary migration defect: acquired
`In GAME base-game, ...` was rejected because the body-scope exception accepted
only a full requested game/edition identity followed by another word, while
title inspection correctly accepted the exact identity. The unchanged large
chunked/gzip acquisition fixtures and a new registry-driven base-edition case
failed 3 of 44 focused tests before repair. The body check now applies the same
exact-or-qualified identity boundary as the title check. Incompatible edition,
related-title, foreign primary, historical/reference, and injection controls are
preserved. Verification after repair passed all 341 tests across six focused
suites, including actual controlled streaming acquisition and the immutable
cross-game benchmark; scoped ESLint also passed. Final CI commit provenance
remains part of the central validation report.

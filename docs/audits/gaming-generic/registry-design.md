# Gaming identity registry design

Read-only baseline: `200463b3aac65eb494f71d842c1e2b0378530bfb` (2026-10-10).

The current identity normalizer is deliberately conservative: formatting does not erase editions, sequel numbers, platforms, or expansions. Preserve this API and stored-key behavior. Recognition data must not establish source authority, acquired identity, currentness, or storage permission.

## Classified inventory

| Classification | Runtime dependency | Exact reference | Implication |
| --- | --- | --- | --- |
| Architectural weakness | Alias catalog expressed as per-title regular expressions | `src/services/gamingGameDetection.ts`: `OPTIONAL_GAME_ALIASES`, `canonicalAlias`, `detectGamingLeadingGameAlias` | Move literal names and aliases to a closed, versioned registry; compile safe matching centrally. |
| Architectural weakness | Request defaults and source edition recognition depend on named games | `src/shared/gaming/gamingGameIdentity.ts`: `resolveGamingRequestEdition`, `canQualifyGamingUnrequestedEdition`, `gamingEditionEvidenceMatchesRequest`, `readGamingMinecraftEditionScope` | Use configured edition relationships and bounded generic request/source grammars. Retain old exports as compatibility wrappers. |
| Architectural weakness | Particular game/edition names appear in validation rules | `src/shared/gaming/gamingClearSource.ts`: `DISTINCT_SCOPE`, `assessGamingClearSourceIdentity`; `src/shared/gaming/gamingStructuralEvidence.ts`: `gamingEditionConflictText`, `classifyGamingEditionRequirements`, `selectGamingEditionScopedEvidence` | Distinct relatives and named expansion tokens must come from registry data, while generic sequel/remaster/DLC grammar remains generic. |
| Architectural weakness | Edition decisions and source-name collapsing branch on game name | `src/shared/gaming/gamingFreshnessCore.ts`: `extractGamingFreshnessMetadata`; `src/services/gamingHybridCandidates.ts`: `evaluateGamingHybridCandidates`; `src/services/gamingHybridKnowledge.ts`: hybrid continuation edition clarification | Replace these branches with registry-derived edition recognition and labels; changing registry recognition must never attest applicability. |
| Architectural weakness | Acquired-topic vocabulary incorporates particular build/class terms | `src/services/gamingGameDetection.ts`: `ACQUIRED_TOPIC_WORDS`; `src/shared/gaming/gamingHybridPolicyCore.ts`: `gamingGuideSearchHint` | Move specialized vocabulary to configuration where it is needed; do not make it a closed rule for recognizing unknown titles. |
| Architectural weakness | Fixed preference alternatives restrict intake | `src/shared/gaming/gamingRetrievalPolicy.ts`: `resolveGamingUserDecisionGap` | Existing build terms are examples of a broader unresolved-choice problem. A generic approach must preserve conservative preference provenance. |
| Acceptable existing behavior | Discovery seeds and scores are configuration data, not acquired evidence | `src/services/gamingWebContext.ts`: `BUILTIN_SOURCE_CATALOG`, `TRUSTED_DOMAIN_SCORES` | Moving them is useful organization but must not replace identity/source-policy checks or treat seeds as evidence. |
| Acceptable existing behavior | Source authority registry is already versioned and separate from generic algorithms | `src/shared/gaming/gamingCurrentnessSourceData.ts`; `gamingCurrentnessRegistry.ts`: `validateGamingCurrentnessSourceRegistry` | Reuse its validation/freeze pattern, preserve separate authority and storage policy. |
| Architectural weakness | Reviewed publisher transport/extraction pairs are embedded in algorithms | `src/shared/gaming/gamingSourceAcquisitionCore.ts`: `redirectTransition`; `src/services/gamingDocumentExtraction.ts`: `SOURCE_EXTRACTION_PROFILES` | Inventory and measure separately; an identity registry must never authorize redirects or adapters. |
| Acceptable existing behavior | Formatting-only identity and exact edition matching retain meaningful distinctions | `src/shared/gaming/gamingGameIdentity.ts`: normalizers and matchers | Do not alter stored identity keys by canonicalizing aliases globally. |
| Missing capability | No common identity registry with provenance, relationships, and bounded validation | Active `src/` tree | Introduce a pure registry with no transport, environment, database, or source-selected configuration. |

There is no active `gamingSourceMetadata.ts`, `gameScoring.ts`, or separate game catalog module at this baseline. Their functional equivalents are listed above.

## Minimal compatible design

Use three pure shared files: registry types, literal registry data, and registry validation/query helpers. The contract carries a schema version and separate data revision. Each entry has a canonical stable ID, display name, aliases, related titles with relationship kinds, editions with relationship kinds and aliases, platform labels, and bounded review provenance. Explicit recognition is separate from formatting normalization.

Registry validation rejects duplicate/ambiguous aliases, invalid references, unsupported fields, unknown relationship kinds, overlong literals, regex/code configuration, and malformed provenance. Queries prefer the longest recognized title so a sequel cannot collapse to its parent. No registry record can select a publisher, grant authority, alter access policy, or authorize storage.

Runtime identity validation uses acquired source scope and independent anchors. A user-provided name, inferred URL name, registry alias, or unreviewed publisher declaration is recognition context only. Previously unknown titles remain eligible through the existing acquired title/body path; merely being unknown is neither trust nor rejection. Missing anchors remain `GAME_IDENTITY_UNVERIFIED`; conflicting acquired primary identities remain conflicts.

Generic edition helpers use configured literal editions and bounded grammar, maintaining request/source separation. A configured base default is a request interpretation policy and never supplies acquired edition proof. Mutually exclusive editions can be qualified only by the existing stable-question qualification rules. Named expansions and distinct related titles retain conflict checks. Deprecated Minecraft-named exports remain wrappers over the generic helper until downstream users migrate.

## Registration and review

Add or change entries only through reviewed repository changes with regression fixtures. Give every entry an explicit provenance record and bump the data revision. Aliases require ambiguity review. Edition, expansion, remaster, sequel, and platform relationships require applicability review. Adding a game must not add a validator branch. Adding publisher authority or currentness support is a separate reviewed change in the existing source-policy registry.

Unknown titles do not require registry insertion before a useful qualified answer when independent acquired evidence satisfies existing policy. New authority, storage eligibility, adapters, source-global edition defaults, or conflicting aliases require additional review. No runtime submission, user title, or publisher metadata mutates the registry.

## Intended file ownership

Registry workstream owns new `src/shared/gaming/gamingGameRegistryTypes.ts`, `gamingGameRegistryData.ts`, `gamingGameRegistry.ts`, existing `gamingGameIdentity.ts`, existing `src/services/gamingGameDetection.ts`, registry tests, and this design note. The lead coordinates changes in CLEAR, structural scope, freshness, hybrid candidates/continuation, extraction, and discovery to avoid overlapping writes.

## Implementation and focused validation

The registry types/data/core and generic identity/detection consumers are implemented in the working change. Existing public function names, formatting normalizers and stored identities remain compatible. Minecraft-named edition exports remain deprecated wrappers over generic algorithms. Source-scope, freshness and hybrid callers consume the generic helpers in the coordinated implementation.

New registry tests ran red before the module existed, then passed. Nine focused identity/request/source suites passed 312 tests with the pinned Node/npm toolchain. The registry tests cover two unregistered titles and an independently configured synthetic game's editions through the same helper algorithms. This is regression evidence, not an estimate of live acquisition reliability.

CLEAR policy v2 preserves the public rubric/wire version and rejects old policy assessments. Context fingerprints include registry schema, data revision and content hash. Two new decision-invalidation tests failed before the change and passed afterward; five focused policy/currentness/registry suites passed 193 tests. The maintained Gaming guide documents registration review, conservative unknown behavior, decision refresh and rollback precautions. No new cache infrastructure or production operations were introduced.

## Platform availability constraint review

**Missing capability:** current game/edition `platforms` arrays describe recognition
labels and lack a reviewed exclusive-support declaration. The production path
compares acquired platform claims with request scope; it does not independently
prove which platforms actually ship a game or edition. A controlled Java/PS5
source/request probe and its PC control both admitted internally consistent
claims. Treating omitted descriptive labels as definitive incompatibility would
turn incomplete catalog data into unsupported validation policy.

A compatible future constraint schema can add an optional explicit exclusive
mode, a bounded nonempty literal platform set and separate review provenance
(references, review date/revision and applicability version/date). Loader
validation must reject malformed or unreviewed constraints; revisions and
fingerprints must invalidate prior decisions. A generic helper should distinguish
not-configured, consistent, unsupported and unverified outcomes after acquired
game/edition/platform proof, and preserve identity/security priority. Constraint
membership alone cannot establish positive acquired evidence. Independently
configured synthetic fixtures must cover aliases, unknowns, claimed all-platform
scope, absent proof, DLC/related scope, contradictions and review invalidation.
No exclusive real-game constraint or new trust exception is added in this task.

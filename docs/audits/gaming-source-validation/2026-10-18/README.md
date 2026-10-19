# Generic Gaming source validation repair

Historical engineering evidence for issue [#1532](https://github.com/pbjustin/Arcanos/issues/1532).
Baseline `main` was fetched and verified as
`0e7a8e607e3f2f3359dc86eabcf611d8dd3fe6b2`, newer than the supplied
`4b961a0df8a700340dcf795a7f41223685211a31`. Final commit/check receipts belong to
the draft PR and the accompanying validation record. This report is not a
production recovery claim.

## Incident evidence and limits

The owner reported October 17, 2026 requests for Tears of the Kingdom,
Elite Dangerous, The Witcher 3 and Xenoblade Chronicles X: six sources evaluated
per game, zero accepted (24/0 overall). Request identifiers were
`req_1792262665381_ub40xb`, `req_1792275405449_s54ynu`,
`req_1792275683877_onavdl` and `req_1792276206283_fb601` respectively.
Reported reasons include game mismatch, unverified identity, instruction rejection,
insufficient extraction, publisher access failure and fetch failure.

These are owner-supplied production observations. Exact offending publisher
passages were not retained. Neither URL reputation nor extracted character count
establishes a particular page's root cause. The synthetic reproductions below
confirm code defects, not the causes of all 24 individual live rejections.
Publisher 403 and transport failures remain separate legitimate rejection paths.

## Confirmed defects and repairs

- `gamingClearSource.ts` / `gamingAcquiredIdentity.ts`: a prepositional scope
  such as “In the game you can explore freely” reached the actual resolver and
  identity pipeline as a competing game declaration. Nominal identity is now
  separated from gameplay predicates, quoted title bounds and local references.
  Acquired contradictory Game fields and independently declared foreign subjects
  remain terminal. Primary-heading and comparison controls accompany the repair.
- `gamingGameDetection.ts` / `gamingClearSource.ts`: heuristic guide titles
  identify article subjects before ownership is established. Generic acquired
  topic definitions bind locations, quests, characters and mechanics to their
  games without a list of named locations. Uncorroborated subjects remain unknown;
  an established conflicting game remains a mismatch.
- `gamingAcquiredIdentity.ts` / `gamingGameRegistry.ts`: source-local aliases
  were limited to 32 characters without subtitle punctuation, and an extracted
  first heading could hide the declaration boundary. Bounded full alternate
  titles now require a separate canonical acquired assertion. Alias declarations
  cannot erase sequel, DLC or edition boundaries. Explicit configured edition
  relationships recognize colon and dash separators. No new game-specific
  registry entries or runtime exceptions were added.
- `gamingDocumentExtraction.ts`: generic “follow these instructions” and
  “you are now” phrases rejected benign mission guidance. Filtering now targets
  assistant control, override, secret disclosure and tool/command execution.
  Additional malicious forms are covered by negative controls.
- `gamingHtmlEvidence.ts` / `gamingDocumentEvidence.ts` /
  `gamingDocumentProjectionCore.ts` / `gamingDocumentResolution.ts`: a malicious
  title could be sanitized without setting the document rejection flag, and
  malicious text beyond the projection budget could be omitted before scanning.
  Bounded acquired visible HTML, metadata and plaintext are checked before
  projection; instruction-bearing documents remain rejected as a whole.
- `gamingHtmlEvidence.ts` / `gamingDocumentIngestionCore.ts`: a narrative list
  step with a colon could become an unusable one-field record and disappear from
  prose. Intact actionable narrative steps remain prose; explicit record fields,
  empty values, nested/ambiguous layouts and incomplete containers keep their
  structural integrity checks. Navigation terms describing in-game menus no
  longer defeat complete actionable gameplay sentences merely through density.
- `trinityHonesty.ts`: after source repair, the full workflow exposed a separate
  error: “save stamina” was rewritten into a denial of backend persistence before
  answer CLEAR. The shared claim classifier now distinguishes player imperatives
  from claimed completed/backend-owned storage. The original gameplay sentence
  and unsupported persistence negatives remain in tests.
- `gamingSourceEvaluation.ts` / `gamingHybridCandidates.ts`: closed diagnostic
  fields distinguish article subjects, identity scope and corroboration from
  contradiction. Rejections retain bounded extraction counts and failure classes;
  no raw subjects, publisher articles, secrets or credentials are added to logs.

The existing hybrid-v2, Trinity and CLEAR control flow remains intact. CLEAR
policy v5 invalidates older approvals; resolver v4 changes extraction/revision
identity. No thresholds, timeouts, workflow budgets, authorization or durable
storage consent policy were relaxed.

## Community policy and runtime taxonomy

`gamingFreshnessCore.ts` already admits unreviewed public hosts as potential
ordinary gameplay evidence; publisher affiliation is not an acceptance gate.
`gamingHybridCandidates.ts` restricts only explicit currentness verification to
reviewed official sources. Those stricter paths are unchanged. Supported alternate
build strategies can coexist; factual structural contradictions retain their
existing checks before selection. Tests exercise both cited alternatives and
their tradeoffs through real Trinity orchestration with deterministic providers.

Named game/alias/edition relationships remain versioned data in
`gamingGameRegistryData.ts`. Reviewed currentness publishers/adapters and extraction
profiles remain their existing data catalogs. Deprecated Minecraft-named wrappers
delegate to generic registry logic; preview examples remain synthetic fixtures.
No Zelda, Witcher, Xenoblade, Elite, character, location, weapon or publisher
acceptance exception was introduced. Unknown games use the same acquired-evidence
pipeline. This repair does not certify every title translation, topic grammar,
publisher layout, new game or edition relationship.

| Identified dependency | Classification and disposition |
| --- | --- |
| `gamingGameRegistryData.ts` | Versioned canonical names, aliases, related titles and editions; unchanged reviewed data, not executable named-game exceptions. |
| `gamingCurrentnessSourceData.ts`, `gamingCurrentnessRegistry.ts` | Reviewed official currentness adapters/ownership; intentionally retained for time-sensitive claims. |
| `gamingSourceCatalogData.ts`, `gamingSourceFamilyData.ts` | Discovery/source categories and provider families; do not replace acquired ownership or evidence quality. |
| `gamingPublisherExtractionProfileData.ts` | Publisher layout selectors; generic article fallbacks remain available. |
| `gamingSourceTransportData.ts`, `gamingSourceAcquisitionCore.ts` | Reviewed redirect pairs and transport admission; security exceptions are not gameplay acceptance grants and remain unchanged. |
| `gamingGameIdentity.ts` | Deprecated Minecraft-named compatibility wrappers call generic registry logic; no new title branch. |
| `gamingGameDetection.ts`, `gamingStructuralEvidence.ts`, `gamingFreshnessCore.ts` | Generic topic/record/freshness grammar; no named location, character or weapon acceptance branch introduced. |
| `*PreviewFixture.ts` and tests | Synthetic game/publisher examples, not runtime evidence or production success. |

## Reusable fixtures and before/after evidence

All fixtures are original synthetic documents, not copied publisher content or
verified gameplay advice. External HTTP/DNS and model providers are mocked;
acquisition attestations, extraction, identity, coverage, evidence membership,
Trinity stages and final-answer validation run production implementations.

- `tests/fixtures/gaming-generic-source-validation/`: manifest and twelve HTML
  layouts for a wiki, community discussion, specialist article, player build,
  narrative walkthrough, complementary partial sources and alternative strategies.
  Covers the four incident games, Bramble Meridian and Clockwork Estuary (absent
  from runtime registry data), Elden Ring and Fallout 76.
- `tests/fixtures/gaming-generic-scope.ts` and
  `tests/gaming-generic-scope-acquisition.test.ts`: actual protected acquisition
  into scope/identity assessment; comparisons, references, ordinary predicates,
  quotations and genuine primary conflicts.
- `tests/gaming-generic-detection.test.ts`: article ownership, source-local
  Witcher/Zelda/invented aliases, unresolved titles and incompatible relationships.
- `tests/fixtures/gaming-generic-extraction/narrative-list.html` and
  `tests/gaming-generic-extraction.test.ts`: narrative versus structural extraction,
  full-document instruction controls, incomplete records and navigation density.
- `tests/gaming-generic-diagnostics.test.ts`: bounded/redacted failure projections.
- The dedicated Trinity persistence regression retains “save stamina” plus
  unsupported persistence controls. Existing security suites remain in place.

An immutable archive of the baseline source ran the same final fixture tests;
1,342 runtime and script files were verified against that commit's Git blobs.
Across all seven new regression suites, baseline passed **84/173** with **89
failures**; the repair passed **173/173** with no skips. The historical
[validation record](validation.json) includes the tested working-tree file hashes.
The existing baseline focused set passed **565/565** tests. The full new generic
workflow suite on baseline passed **12/19**; repaired execution passed **19/19**.
Within it, ordinary source acquisition through grounded Trinity/final CLEAR
improved from **4/8 to 8/8**. Corroborated alternate-title workflows improved from
**0/2 to 2/2**. Complementary partial-source coverage and alternative strategies
passed on both revisions. The compound injection negative failed baseline and
rejects after repair. See the validation record for final suite inventories and
exact command results; diagnostic-schema tests are not counted as source acceptance.

The first full-suite sweep also exposed a stale sealed-preview contract: it
required 99,000 characters of intact actionable guide prose to become metadata-only
when navigation density was high. The preview now proves both actionable prose
retention (including partial status when truncated) and rejection of actual
navigation furniture. Two added mutation controls fail if either distinction is
lost. The original failing preview test and its dependent served-route checks are
retained; the reviewed preview semantic digest is updated with the fixture.

## Security and release boundaries

Existing negative controls cover wrong games, competing primary headings,
incompatible editions/DLC, injection, private/encoded IPs, DNS rebinding,
credential URLs, unsafe redirects, 403, truncated/ambiguous records, cross-source
laundering, storage authorization, idempotency, expiry and aggregate acquisition
budgets. Local disposable PostgreSQL/Redis and hosted CI results are recorded
separately from mocked tests.

Shortened titles without a corroborated alias relationship remain unverified.
Xenoblade Chronicles X: Definitive Edition is not assumed compatible with the
original game. The syntax-based security classifier is not universal semantic
prompt-injection detection; source text remains untrusted throughout generation.

No live publisher/provider acceptance, protected source ingestion, installed
private plugin modification, production deployment, merge, permission change or
durable-source-policy change was performed. Railway static validation does not
establish a deployed preview or production acceptance. Merge readiness depends
on the final draft PR's checks/review and unresolved release gates, not these
local unit counts alone.

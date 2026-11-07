# Gaming discovery and evidence reliability — 2026-11-06

## Codex Cloud plural-heading follow-up — 2026-11-07

The [independent Cloud finding](https://github.com/pbjustin/Arcanos/pull/1591#issuecomment-6702869840)
was reproduced at the unchanged remote head
`a30970581b59b6e58fa2176a22463c358f670a3a`, base
`0be1134658195a27353a07b5ca6f86d6e3222546`. The implementation checkout was
clean. Both required checks were green at that starting head; that result is
not evidence for the subsequent repair.

Two suffix heuristics in `gamingDocumentIngestionCore.ts` treated nominal words
ending in `s`, `ed` or `ing` as predicates. `wooden shields` bypassed heading
removal; `Smithing Stone` and `Golden Seed` also bypassed body-only description
recognition. The permanent initial regression matrix failed **10/34 cases**
before repair: eight nominal cases and two factual-description controls that
exposed the opposite classification error. Three authenticated loopback HTTP
cases also failed their zero-model/SDK-call assertions before repair. The
wooden-shields case entered model validation once; the two Smithing cases each
entered four deterministic SDK stages. This establishes unnecessary provider
boundary entry, not independently verified acceptance of a real generated answer.

The localized correction shares a bounded, subject-owned predicate guard across
body, nominal-heading and catalog-label recognition. Inflection alone does not
prove a predicate; leading nominal modifiers remain descriptive. Explicit
relations, values, qualifications and supported factual predicates are retained.
Independent review of the intermediate correction added further action/effect
controls, including reflecting spells and restoring health. The existing closed
description forms, exact same-topic matching, 240-character label bound,
eight-label cap, source provenance and runtime limits remain intact. This is a
closed English quality rule, not a general part-of-speech or semantic parser.

External HTTP/DNS/provider responses are deterministic substitutes in the
application-path fixtures. Provider usage is zero/$0. No merge, deployment,
production mutation, credential change, safety-limit increase or manual
CodeRabbit review request is authorized or performed by this follow-up. Final
local validation, publication identity and exact-head CI are recorded below and
in the accompanying PR receipt.

Permanent coverage adds **30 cases**: 25 nominal/factual controls, three
authenticated HTTP refusals and two real-SQL retained-source cases. The existing
contained performance fixture also covers a 100KB alternating letter/hyphen
subject. An intermediate subject matcher exceeded its three-second containment
deadline; matching the token's real Unicode left boundary removes interior
rescans. The corrected 250KB probe completed in13ms. These are local wall-clock
observations, not a new production limit or universal performance guarantee.

Validation on pinned Node24.18.1/npm11.16.0 passes **200 Gaming suites /
6,759 tests** in466.482seconds, with no skips. Focused overview/performance checks
pass111 tests, and all63 authenticated HTTP cases pass. Each of the three new
HTTP negatives performs zero model-validation, SDK inference, ingestion and
memory-write calls. An independent external matrix also retains42 factual
headings and22 material-predicate cases while excluding60 nominal cases and10
leading-modifier controls. Those external probes supplement the permanent tests.

Real disposable PostgreSQL18.6 passes **77/77 tests**:66 historical/status and11
durable-RAG cases. The new cases persist and retrieve headed, title-redacted and
body-only synthetic overviews through the real application SQL path. All remain
insufficient; independent factual locations regain verified support and exact
record/revision/public-URL citations. No provider fetch, acquisition or ingestion
enqueue occurs during these retained reads. This is a real local database with
synthetic records, not production-record or live-provider acceptance. The first
SQL attempt rejected two new fixture assessments before persistence because
their dimension references were not declared; correcting the synthetic bindings
made the full rerun pass without changing application policy or assertions.
Teardown confirms zero owned schemas, no listener, no owned processes or PID
file, and the server stopped. Type-check and build pass against the frozen source.

The separate shared-fetch/import/workflow gate passes **eight suites /641 tests**.
Lint passes with zero errors and the same77 existing warnings. Generated indexes,
documentation checks and all812 local documentation links pass. No remaining
failure was reproduced in the reviewed scope. The published commit and exact-head
CI snapshot belong to the PR receipt; CI completion is intentionally not awaited.
Independent Codex Cloud re-review remains required before merge readiness.

## Independent Codex Cloud remediation from a9357480

Starting head: `a93574804842e6a9c27846f19d4b84996d11fe02`; base:
`0be1134658195a27353a07b5ca6f86d6e3222546`. Local and remote matched with a clean
implementation checkout. Existing required CI was green at that head. The PR
was already open and non-draft; this work preserves that state without merging.
The Cloud review's uncommitted files were not assumed available. Equivalent
permanent fixtures were reconstructed against the actual implementation.
Runtime repairs and acceptance tests are committed at
`8a17cd758e9e6227b4ca3bc5a19db3e4fc5fd636`; the following documentation-only
commit records this audit. The exact published head and CI links are in the PR
receipt, so this file does not claim its own commit hash.

| Finding | Before | Correction and permanent evidence |
| --- | --- | --- |
| P1 source-global platform restriction lost in comparison projection | Platform matrix: 11 failures / five controls; the same adjacent region path failed one case / two controls. Two retained-record cases also failed before the caller correction. | Applicability reads original acquired prose, excluding every original parser-owned record before interpreting global labels; selected record fields stay scoped. Fresh and stored callers pass original documents. The existing strict comparison projection is unchanged. The 23-case matrix covers PC/PS5, edition/game conflicts, regions, quotes, compatible foreign comparisons and comparison-only field tails. |
| P1 enclosing heading crossed an independent article without H1 | Initial heading matrix: nine failures / nine controls; surrounding class-wrapper and quoted-inner-article cases failed separately. | Semantic article/main boundaries stop inheritance with H2 or missing H1; a surrounding class wrapper must be wholly owned by its independent article. Quoted or denied elements cannot supply that boundary. All 29 new heading cases pass, including dependent class scopes, nested articles and furniture controls. |
| P1 nominal topic heading restored description-only authority | Initial overview matrix: nine failures / seven controls; independent pooled-heading and factual-heading checks reproduced six further controls before their corrections. The real HTTP negative reached model validation once before correction. | Reuse the same closed overview rule for fresh/stored evidence. Match only exact descriptive objects with bounded nominal heading sequences; retain material predicates, values and location qualifiers. All 22 new overview cases pass. Description-only HTTP execution now performs zero model validation, SDK inference, ingestion and memory writes. |
| P2 failed redirect destination consumed the only discovery slot | Real discovery/acquisition fixture fetched A → B → B after B returned403; C was never acquired. | The existing protected-hop callback collects admitted, sanitized attempted URLs in a request-local negative set, including failures. Discovery applies them before its existing cap. The same one-slot fixture fetches A → B → C; eight controls cover unsafe/sensitive destinations, cancellation, loops, budgets and provenance. |

Independent cross-checks rejected an intermediate platform-field retention
approach: keeping a whole comparison, or a field with gameplay in its comma tail,
could restore claim support. That approach is not in the final implementation.
Global applicability and selected claims now use their existing separate paths,
with original source bytes retained for hashes and provenance. No parallel field
parser, new public contract, provider path, resource-limit increase or storage
permission was introduced.
The nominal-heading implementation was also challenged with long single- and
multiple-separator topics. A contained child exceeded its eight-second deadline
before the correction. The final local matcher uses bounded literal comparisons
and original source boundaries instead of dynamic topic regexes; all four250KB
attack controls complete in about10ms, with valid nominal labels still detected.
The existing240-character metadata window and all production limits are intact.

The authenticated loopback suite now has 60 cases. New negative fixtures assert
zero model/SDK/storage effects; compatible platform and independent H2 article
positives complete all four deterministic Trinity/audit stages with bound
citations. Comparison-projected content remains transient rather than acquiring
durable-storage eligibility. External HTTP/SDK responses are deterministic
fixtures, not live-provider acceptance; application provider usage is zero/$0.

Focused validation passes six suites / 181 tests, plus five contained matcher
and boundary controls. The complete supported Gaming sweep passes **200 suites /
6,731 tests** in330.834seconds; separate shared-fetch/import/workflow checks pass
**eight suites / 641 tests**. There are **93 added permanent cases** in this pass.
Node24.18.1 / npm11.16.0 type-check, build, lint (zero errors / 77 existing
warnings), generated indexes and all812local documentation links pass.

Real disposable PostgreSQL18.6 validation passes **75/75 tests**, no skips:
historical/status66 plus durable-RAG9. These are actual application SQL operations
using source-derived historical and deterministic current synthetic rows, not
production exports or live-provider acceptance. The guarded loopback target was
reused without installation or configuration changes. Teardown confirms zero
owned schemas, the server stopped, and PID/listener/owned processes absent.
An initial shared-check invocation named a nonexistent test path; the corrected
invocation is the reported gate. An intermediate Gaming run was stopped after
source changes invalidated it; progress instrumentation also isolated a slow
existing selector case whose full68-case suite passes. Restoring the earlier
overview function also exceeded the contained eight-second selector probe; that
probe is not presented as a newly introduced production failure. The final
complete sweep above passed without exclusions, raised limits or weakened
assertions. Temporary diagnostic reporters remain outside the repository.

Publication identity and exact-head CI links accompany the PR receipt. Required
checks are `docs:check` and `All Checks Complete`; previous-head success is not
final-head evidence. CI completion is not awaited under the standing instruction.
Independent Codex Cloud re-review remains required before claiming merge
readiness. No merge, deployment, production operation or manual CodeRabbit
review request is part of this remediation.

## CI and review follow-up after 55aa6c8c

CI/CD unit and PR CI `build-test` at
`55aa6c8c523e6ed4e7a0b76862ca0d2784416d7b` each reported one failed test and
23,707 passing tests. Both failures were the same exact-command assertion in
`tests/postgres-ci-truth-contract.test.js`: the expected required-suite inventory
omitted the newly registered historical Gaming SQL suite. The actual package
command and required PostgreSQL job already included and executed that suite.
This was an introduced contract-inventory omission, not an environment failure.

Commit `8a8061e3619d0e003515b7348c4f15a99d83c512` adds that path in the existing
command order. The unmodified six-case truth contract failed one assertion;
after the correction, all 136 cases across five truth/target-guard/required-mode/
aggregate/workflow suites pass on Node 24.18.1 / npm 11.16.0. No runtime,
workflow, package command, resource limit or security policy changed. No SQL
server or provider was started for this inventory-only correction. A separate
historical capture boundary below identifies the original audit revision while
preserving its captured results. New-head CI is inspected after publication;
completion is not awaited under the user's standing instruction.

## Comprehensive acceptance from 25a78ea7

Starting head: `25a78ea7cf5a4ea279dbe97a2abd742c378f0e2d`; base:
`0be1134658195a27353a07b5ca6f86d6e3222546`. The final source and acceptance-test
commit is `ab98e1e6404c90dfd8b1cde2587603c3a0c5bb78`; the following audit/index
commit changes documentation only. The exact published receipt head and CI links
are recorded in PR #1591. The original checkout was preserved.

Baseline reproduction passed the existing HTTP/quality 51 cases, shared/layout
145 cases and discovery/Archive/CLEAR 198 cases before source edits. Starting-head
required `docs:check` and `All Checks Complete` were green. That CI observation is
not evidence for a subsequent head.

| Reproduced defect | Before | Root-cause repair and permanent regression |
| --- | --- | --- |
| Varied source-description wording supplied coverage without a gameplay fact | Expanded wording matrix: 21 failures / 12 controls passed; ten HTTP cases had false positive coverage | Reuse the closed overview classifier for bounded nominal descriptions, with factual values, relations, predicates and qualifications preserved. HTTP before counters were not all reached, so those ten failures are coverage evidence, not proof of ten inference charges. |
| Stored topic prose regained coverage and verified CLEAR claim support | Three direct stored-coverage failures; real SQL retrieval had coverage false but full-assessor claim support verified | Apply the same overview exclusion to both request coverage and full CLEAR gameplay chunks. SQL retrieval and declarative positive controls now pass. |
| Exact acquired-heading removal could discard the actual fact | Two heading-fact controls failed | Strip only clearly nominal document/catalog labels; retain factual and unfamiliar-predicate headings. A real HTTP positive now supports the answer solely from acquired H1 facts, with four deterministic Trinity/audit stages and the bound citation. |
| Periods inside decimal game titles were scope boundaries | Exact decimal-title and comparison positives failed; the continuous Archive path returned false game mismatch | Share punctuation-aware nominal boundaries and retain the existing 160-character scope and 512-character comparison bounds. A non-authoritative lookahead prevents scan-edge completion. Known/unknown contradictions and truncated controls remain enforced. |
| Body identity could remain verified despite unfinished comparison inspection | Two incomplete/over-budget scope controls failed | The body scanner uses the existing applicability scanner's completeness result without discarding retained declarations. |
| Plain-text Archive guides with acquired full named-game scope required nonexistent HTML metadata | Decimal correction exposed a separate identity-unverified refusal | Permit the existing independently acquired exact named-body scope when HTML metadata is absent. Item metadata, URLs, bare mentions and comparisons still cannot establish derivative ownership; all contradiction and edition gates remain. |
| Nested navigation score text copied the same long article repeatedly | Both base and reviewed head exceeded an eight-second contained child deadline; a smaller 504-element probe took about 2.5 seconds | Score non-overlapping navigation roots with cached ancestor membership and the existing score window. The 184KB/2,006-element regression completes extraction in about 0.5 seconds, retaining default 9K text/links and full opted-in content. This was an existing related defect, not introduced by this PR. |
| Blank optional primary selectors suppressed article preservation | Empty-string and whitespace hints both lost legitimate article content | Trim/filter after the unchanged 24-selector cap, then apply the normal fallback. Mixed valid hints, malformed hints, the 25th-selector ceiling and genuine furniture controls pass. |

### Real PostgreSQL acceptance

An official portable PostgreSQL 18.6 runtime was used only under the task's work
directory. The EDB ZIP and its published SHA-256 matched
`e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2`.
No installer, global PATH/configuration, OS service or production database was
used. The cluster listened only on loopback; tests used the existing strict
disposable database-name/URL guard and required-database mode.

The new historical/status suite passes **66 real SQL cases**, plus **nine existing
durable-RAG SQL cases**, with no skips. Original v1–v5 producer-derived bodies and
current v6 bodies are actually persisted through application repository paths.
Coverage includes six job states, actor-bound retrieval, cross-actor rejection,
malformed/oversized/future/tampered rows, approval stripping, historical execution
and reapproval refusal, current source persistence, concurrent idempotency,
changed-body conflict, terminal reuse, expiry cleanup, catalog/lexical retrieval,
and overview-versus-declarative evidence authority. The current worker handler is
invoked directly; a background worker claim/lease loop is not claimed. Assessments
and source bytes are deterministic fixtures. These are real SQL operations on
synthetic rows, not production records or exported historical customer data.

The suite is wired into the existing `test:postgres-fencing` job. After the final
post-heading-fix rerun, all **75/75** SQL tests passed; owned test schemas were
absent, the server was stopped, and its PID, listener and owned processes were
verified gone. Portable files remain outside the repository for reproduction.

### Continuous HTTP, shared callers and publisher boundaries

The **56-case authenticated loopback MCP suite** now includes actual existing
host-side Brave adapter/discovery processing followed by URL admission,
deduplication, protected redirect or Archive metadata/derivative acquisition,
extraction, identity, CLEAR, selection, Trinity, audit and citation delivery.
MCP search remains host-delegated; no backend search path was inserted into MCP.
External search/source transport and SDK responses are deterministic boundaries.
Cancellation, provider failure, insufficient evidence, unqualified Archive text,
actor authorization and replay check actual downstream counters. Rejected cases
perform zero unintended model validation, inference, source ingestion or memory
writes. Positive answers perform the existing four SDK fixture stages.

Nineteen real-consumer regressions exercise Research, URL-RAG ingestion, browser
search source packets and the separate state JSON wrapper, plus the contained
deep-navigation worker test. Existing shared-fetch defaults, links, cancellation,
deadlines, headers and primary content remain covered. Seven permanent synthetic
publisher incident cases preserve the 4,096-character structured-state bound,
layout recovery, partial/deep qualifiers, JSON-only provenance and full-response
instruction/source-use restrictions.

Offline replays of separately captured public samples recover 3,714 Zelda shops
and 10,573 Zelda items prose characters; all 64/34 structural rows respectively
remain partial under existing qualifier limits. The IGN sample remains integrity
exhausted; the 4,097/8,919-character inert-state cases are bounded negatives.
These samples are not the unavailable original incident response bytes and do not
establish current publisher availability. G2A timeout, 403 access restriction and
bounded alternate-source recovery remain intentional controlled outcomes. Real
SQL tests establish missing-catalog versus matching lexical retrieval behavior.

### Validation and unavailable acceptance

Exact Node 24.18.1 / npm 11.16.0: the complete supported Gaming sweep passes
**195 suites / 6,638 tests**. Additional checks pass **75 SQL tests**, **741 tests
across 12 shared-fetch/import/workflow/native-Windows suites** (including 496
import-boundary cases), and **103 Windows-receipt/preview-runner contract tests**.
Type-check, build, lint (zero errors / 77 existing warnings), maintained docs,
generated indexes and 812 local documentation links pass. External-link network
validation and the unrelated full-root environment suite are not claimed.

Railway project/environment inventory found no owned PR #1591 environment. The
PR remains draft with no preview label; the existing controller recorded
`action: noop`, `reason: not-opted-in`, and skipped deployed preview execution.
No unrelated preview was adopted and no labels, draft state, deployments,
credentials, production configuration or privileged networking were changed.
Deployed authenticated Gaming/SQL acceptance is therefore blocked. Offline
preview-runner tests are not deployed evidence. Live-provider acceptance is also
blocked by the absence of paid-provider authorization and budget; application
provider usage/cost is **zero / $0**.

Independent review examined the full source/test diff, negative effects,
cleanup/provenance and factual-retention cases. No remaining reproduced code
defect is asserted in this scope; closed language recognition is not a universal
semantic proof. The PR stays draft and unmerged. New exact-head required CI must
be assessed at the published head; prior green checks cannot substitute for it.
CI completion is not awaited under the user's standing instruction.

## Independent remediation from c60b7380

The remote PR head and merge base were verified at
`c60b738039b5c08efb541e17839be7370a0fc908` and
`0be1134658195a27353a07b5ca6f86d6e3222546`. Independent reproduction found and
repaired the following defects; prior review conclusions were not acceptance proof.

| Defect | Before | Repair and regression evidence |
| --- | --- | --- |
| Ordinary `in the game shop/world/menu` locations and whole-quoted secondary clauses kept unrelated comparisons live | Initial comparison matrix: 28 failures / 17 passes | One shared closed surface predicate and quote-aware secondary-scope inspection; final comparison suite: 55 passes. Explicit names, quoted names, global declarations and ambiguous/unfinished references stay inspectable. |
| Colon comparison framing disagreed with comma framing in projection and edition parsing | Direct body/edition matrix: 5 failures / 9 passes; HTTP comparisons: 6 failures / 2 controls passed | Comma and colon share the existing bounded projection and edition context grammar; all 14 direct-parser cases pass. |
| Genuine v1 retained jobs were rejected by the current source-policy literal | Six v1 state failures / 52 other cases passed | The private status schema accepts the original source-policy v1 value and strips approval. Final historical matrix: 63 passes, including source-derived v1–v5 records, ownership, malformed payloads, execution refusal and current idempotency. |
| Reviewed publisher primary classes were absent from layout normalization; profile furniture could become structured evidence | Publisher matrix: 12 failures / 4 controls passed | Existing profile selectors and exclusions are shared across prose, HTML and embedded JSON; final matrix: 27 passes. The 24-selector and six-scope bounds remain unchanged. Resolver v6 separates these extraction decisions from prior revisions. |
| Topic-only page descriptions beside incomplete records could start inference | Two real loopback HTTP cases invoked two SDK stages despite having no gameplay claim | Closed overview-only prose chunks are excluded before metadata redaction, preserving original document hashes, offsets and structured tuples. Both cases now perform zero inference/model validation/storage writes; a separate declarative gameplay fact still completes all four normal deterministic SDK stages. |

The complete supported Gaming sweep passes **192 suites / 6,557 tests** on exact
Node 24.18.1 / npm 11.16.0. Separate validation passes **496 import-boundary
tests**, **99 workflow-safety tests**, **43 shared-fetch tests**, type-check,
build, lint (zero errors / 77 existing warnings), generated-index checks and
all 812 local documentation links. The 34-case authenticated loopback HTTP suite
retains the original/remake, base/DLC/Nightreign, Fallout 76/4, Elite Dangerous
and unregistered-title controls. Full-response instruction/source-use checks,
URL admission, redirects, actor isolation, CLEAR, Trinity admission and citation
validation remain enforced. No production resource limit was raised.

The historical fixtures are synthetic outputs derived from the committed
producers listed in `tests/fixtures/gaming-historical-status/README.md`; they are
not real retained-row exports. No disposable PostgreSQL server or running local
Docker engine was available, so PostgreSQL persistence acceptance remains
unverified. HTTP acquisition/provider boundaries are deterministic fixtures,
not live-provider or deployed acceptance. Closed overview recognition is not a
universal semantic proof of every possible prose claim. Existing deep-table
qualifier limits and external publisher availability remain unchanged.

The PR remains draft and unmerged for independent review. Exact-head CI is
inspected after publication without waiting for its completion. No merge,
deployment, production configuration change, paid provider call or Gaming source
persistence is authorized or claimed by this remediation.

## Historical audit captured at 1de7e16c

The sections below preserve the original audit captured at implementation
`1de7e16cdcedc7c6f4b08f041fe1190aa1ba9f93`. Their results and limitations apply to
that revision; the newer remediation and comprehensive acceptance records above
describe later work.

This audit accompanies the draft implementation based on
`0be1134658195a27353a07b5ca6f86d6e3222546`. Deterministic fixture acceptance,
live public-source measurements, and production log observations are separate
evidence. No merge, deployment, production configuration change, paid provider
request, database write or Gaming source persistence is part of this work.

## Reused architecture and provider decision

The stored-source identity catalog and bounded lexical retrieval run first.
The MCP `gaming-hybrid-v2` lifecycle delegates public search to its host and
accepts bounded URL hints. Backend protected acquisition independently verifies
those hints. Deterministic document extraction, game-scoped evidence projection,
applicability, selection and CLEAR precede normal Trinity orchestration. Final
answer and citation validation remain mandatory. Existing actor binding,
idempotency, absolute TTL, URL/network limits, recovery allowances and separate
storage authorization remain authoritative.

The separately configured backend discovery path already provides
`GamingSearchProvider` and a Brave adapter. Reusing it avoids another retrieval
framework. Candidate exclusion now happens before the fetch-slot cap, so
previously attempted sources cannot crowd out new alternatives even on cached
search results. A small repeated-domain penalty diversifies similarly relevant
pages; stronger topic matches retain priority. Search metadata remains an
untrusted discovery hint and cannot establish source authority or claim support.

The installed `openai` SDK is 6.25.0 and exposes Responses `web_search`, citation
annotations and `web_search_call.action.sources`. The current
[official web-search documentation](https://developers.openai.com/api/docs/guides/tools-web-search)
was inspected. Hosted search would add tool calls and cost and would not itself
establish backend acquisition or game applicability. No such adapter is enabled
or added to the MCP contract: a separately authorized provider route, credentials,
network authority and cost budget are follow-up prerequisites. No new credential
or permission is needed for the changes in this PR.

## Incident findings

| Incident | Classification and evidence |
| --- | --- |
| IGN identity | Intended rejection under the original-game scope in this task: the acquired primary title and body explicitly identify Ocarina of Time **Remake**. The original and a remake are not presumed compatible. Production request `req_1793953899567_0pgoj` rejected `GAME_MISMATCH` through `gaming.identity.affirmative_body_scope_conflict`; no Trinity generation occurred. Logs omit the historical request payload, so its exact edition context cannot be independently reconstructed. |
| IGN extraction | Confirmed current bounded-parser condition, retained fail-closed: a fresh acquired `__NEXT_DATA__` envelope contains an 8,919-character `props.apolloState` string exceeding the 4,096-character JSON string bound. Production reported `extraction_budget_exhausted`, 2,991 extracted characters and zero evidence units after 631 ms. The fresh response was about 275 KB, well below the HTML byte limit. The historical raw response was not retained, so the original incident's exact exhausted sub-limit is unresolved; the fresh snapshot reproduces this specific condition. Neither limits nor incomplete-inspection acceptance are weakened. |
| G2A | External timeout with intended bounded handling: `req_1793953678255_tho4yo` records transport `DEADLINE_EXCEEDED` / `SOURCE_TIMEOUT` after 5,005 ms. A separate bounded public GET also timed out at approximately 12.1 seconds. Recovery uses a different URL within the existing v2 allowance; no publisher bypass or repeated unbounded retries are added. |
| Zelda Central | Confirmed extraction defect: a `content-grid has-game-sidebar` ancestor matched the generic sidebar furniture selector and discarded legitimate article prose and tables. The production response had approximately 272/333 KB accepted bytes, yet only 732 extracted characters and three partial navigation units. The generic layout-token repair restores 3,714/10,573 article-prose characters in separately acquired snapshots. Table rows still exceeding the existing six-level qualifier context boundary remain partial and do not establish verified structured claims. Actual sidebar furniture and full-document security inspection remain enforced. |
| HTTP 403 | External publisher restriction, correctly rejected as `SOURCE_INACCESSIBLE`; CLEAR and generation do not run for inaccessible content. Deterministic HTTP acceptance covers bounded discovery of an alternate source. No access restriction is bypassed. |
| Stored lookup | Intended missing-catalog outcome in available evidence: the three production observations show `sourceKnown:false`, zero lexical candidates and zero selected chunks. The implementation resolves active game/edition identities before topical lookup and stops when no matching source is present. `semanticCandidateCount:0` is a constant diagnostic for this lexical-only path, not a failed semantic query. This does not prove the entire production database is empty; no database inspection or mutation was performed. |

The bounded public measurements used the supplied incident URLs:
[IGN walkthrough](https://www.ign.com/wikis/ocarina-of-time-remake/Walkthrough),
[G2A walkthrough](https://www.g2a.com/news/features/guide/ocarina-of-time-remake-walkthrough-main-quest-and-dungeon-order/),
[Zelda Central shops](https://zeldacentral.com/games/ocarina-of-time/guides/shops-and-prices/)
and [Zelda Central items](https://zeldacentral.com/games/ocarina-of-time/items/).

## Confirmed repairs and retained boundaries

The layout repair is publisher-agnostic and preserves extraction limits. Complete
bounded comparison sentences are excluded from identity and claim support, so an
incidental other-game comparison does not invalidate independent acquired facts.
An affirmative global declaration, incomplete comparison, over-budget reference,
wrong game or unknown edition remains blocking or unresolved. CLEAR policy v6
invalidates older explicit assessments for reassessment without writing stored
data. Ordinary gameplay location/price phrases are covered separately from true
game identity declarations.

Accessibility is represented by the existing acquisition stage, applicability by
identity/edition/platform gates, and claim support by existing evidence coverage
and CLEAR. No parallel status model is added. Multiple independently complete
sources may contribute; unsupported fragments still cannot create a complete
claim. Source-use restrictions, unsafe instructions, incomplete integrity
inspection and genuine document-global contradictions remain blocking.

## Acceptance and limitations

Focused regressions record failing-before and passing-after outcomes for each
confirmed repair. Cross-game fixtures cover Ocarina original/remake, Elden Ring
base/DLC/Nightreign, Fallout 76 versus Fallout 4, Elite Dangerous, a long Witcher 3
guide, and an unregistered synthetic title. Synthetic mechanics are test data,
not verification of real gameplay facts.

| Confirmed repair | Before | After and regression owner |
| --- | --- | --- |
| Previously attempted search hits crowd out new fetch candidates | New exclusion test fails; diversity test also demonstrates previous same-domain ordering | `tests/gaming-search-discovery.test.ts`, plus real web-context exclusion wiring in `tests/gaming-source-discovery.integration.test.ts` |
| Layout modifier removes primary article | Three new layout positives fail | `tests/gaming-layout-extraction.test.ts`; true furniture, security, 2,000 nested layout hints and legacy opt-in behavior remain covered |
| Comma-framed comparison becomes global game conflict | Nine new identity/applicability assertions fail | `tests/gaming-evidence-identity-reliability.test.ts`; comparison text is also excluded from claim support |
| Location price/purpose invents a game title | Four new location assertions fail | Same identity suite plus original-question HTTP acceptance; real wrong-game declarations remain blocking |

The long synthetic Witcher guide and its beyond-window security tail are covered
by `tests/gaming-long-walkthrough.test.ts`. Existing publisher, transport, unsafe
redirect, SSRF, JSON preflight, instruction normalization, citation, applicability,
source consent and workflow suites are retained without weakening expectations.

The local HTTP suite mounts the normal OAuth-authenticated Gaming MCP router on
a real loopback socket. It exercises host discovery handoff and candidate
submission, protected acquisition, extraction, identity/applicability, evidence
selection, CLEAR, actual Trinity intake/reasoning/final orchestration, semantic
answer audit and citation validation. External DNS/HTTP and SDK/provider effects
are deterministic mocks; stored lookup, write effects and optional learning
effects are isolated. The router's provider-admission callback is a no-op fixture,
so this suite does not establish live admission-accounting integration. The host
search engine itself is not invoked. A successful answer performs exactly four
SDK-boundary calls (intake, reasoning, final and audit); replay performs none.
Insufficient evidence performs no inference. Inaccessible-source recovery,
invented citations, OAuth, storage scope, closed workflows and expiry are tested.

The original shield question uses a synthetic passage whose shop, Child Link
scope and 40-Rupee price agree with separately acquired Zelda Central article
content. The unrelated positive HTTP case uses explicitly invented Elite
Dangerous beacon mechanics to prove generic execution. Neither case establishes
live-provider or deployed gameplay acceptance.

Live public snapshots establish acquisition and local extraction measurements
only. IGN's identity and integrity limitations, G2A availability, future publisher
markup changes and a complete live search-to-provider answer remain external
limitations or follow-ups. Guarded PostgreSQL suites require an authorized
disposable target and are not claimed as SQL evidence. Independent Codex Cloud
review and exact-head CI are required before a merge decision.

The Zelda Central table-context limitation remains unresolved within this focused
change. Raising limits or accepting uninspected outer qualifications would weaken
integrity; neither is done. Restoring article prose is distinct from approving
every row or proving these publishers now work through the deployed workflow.

## Local quality gates

The final Gaming sweep passed **186 suites / 6,272 tests**, including the new
six-case HTTP suite, 20-case layout suite and two-case long-guide suite. Exact
Node 24.18.1 and npm 11.16.0 were used. Type-check, build, lint and documentation
audit/index checks passed; lint reports 77 existing warnings and no errors.
The local documentation-link audit passed all 812 local targets.

A broader root sweep was also run. Its first invocation preceded compiled
preview output and final semantic-pin refresh; those prerequisites were corrected
before their focused rerun. Three unchanged documentation-workflow tests failed
because Windows selected the WSL Bash launcher. The exact-base scripts reproduced
the failure, while selecting native Git Bash passed the complete unchanged
76-test suite. No source or expectation was changed to hide that environment
failure. The final acceptance report records the broader sweep and hosted CI
outcomes separately from Gaming acceptance.

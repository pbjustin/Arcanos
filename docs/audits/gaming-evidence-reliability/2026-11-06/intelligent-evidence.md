# Gaming discovery and evidence reliability — 2026-11-06

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

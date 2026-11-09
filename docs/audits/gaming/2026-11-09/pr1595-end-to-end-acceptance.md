# Independent Gaming discovery acceptance and remediation

The code is exercised locally through actual application components. Full live
provider acceptance is **BLOCKED**, and this report does not establish production
readiness. See the [evidence index](README.md) for revision identity and the
[public observations](public-publisher-observations.json) for actual URLs.

## Review scope and reproduced problems

The original-base-to-starting-head diff contains 26 files: six implementation
components, the reviewed native-import pins, disabled configuration, maintained
docs, deterministic tests, audit captures and four generated indexes. Independent
tracks reviewed discovery/workflows, acquisition/identity/extraction and
stored-selection/SQL authority. The lead reviewed the combined source, callers,
public contracts, tests, documentation and generated changes. No alternate base,
replacement PR, public response schema, search infrastructure or model dependency
was introduced. Existing CodeRabbit repairs remain in scope.

The following failures were reproduced before repair. The acceptance fixes address
pre-existing gaps exposed by the exact user questions, rather than assuming every
historical defect remains present.

| Trigger | Reproduced behavior | Focused repair and retained boundary |
| --- | --- | --- |
| “Find a detailed guide explaining system colonisation and how to get started” | Retrieval required source-search wording and a separate literal “started” topic; useful acquired procedures did not reach generation | Remove bounded leading guide-search framing from retrieval terms only; retain concrete mechanics and independent requirements |
| Chapter 2 Rex DPS/Nia healer question with later-story spoiler restriction | Retrieval required “avoid later story” as gameplay evidence | Omit standalone spoiler presentation clauses from topical matching; the complete original request and spoiler policy still reach the pipeline |
| Adjacent Samurai build instructions beginning “Prioritize” and “Raise” | Intact acquired stat/equipment advice disappeared from the selected excerpt | Extend the existing dependent-action recognizer by two verbs, retaining its four-successor ceiling and topic boundaries |
| “Insert the copper spindle” in a grounded unfamiliar-game answer | Generic honesty rewrote the player instruction as “I haven't saved or persisted anything here” | Exempt determined-object imperative insertion only when no storage, credential or software-owned/first-person claim is present; ambiguous, completed and coordinated assistant actions remain gated |
| Ordinary “in the game for both …”, “by collecting …”, and degree-complement prose | Acquired-scope grammar invented a foreign game name | Recognize three bounded grammatical frames with actual preceding-clause context; independent identity, named foreign/unknown games, commas, edition and contradiction scans remain binding |
| Explicit scope sanitized to remove a seven-digit version or other substantive material | Discovery could issue a broader query without the full requested constraint | Withhold queries when explicit game/edition/platform/version scope loses substantive content; privacy filtering remains intact |

Resolver revision `gaming-document-v11` separates the changed acquired/extraction
behavior in cache and durable revision identity. CLEAR remains v7. Changing a
resolver revision does not restore a held, unverified or reference-only source's
authority. The reviewed semantic pins were recomputed and independently reviewed;
their enforcement remains enabled.

## Full workflow evidence

`tests/gaming-independent-discovery-e2e.test.ts` independently authors five
scenario corpora and exercises both host-assisted and opt-in backend discovery:

1. Ocarina of Time: exact early Deku Shield question, acquired location/cost/action
   statements and exact claim-to-URL citation binding.
2. Elden Ring: exact early Samurai/no-major-spoilers question, selected equipment,
   skill, attributes and equipment-load advice, with unverified-currentness warning.
3. Elite Dangerous: exact colonisation/getting-started question, procedures with
   explicit uncertainty about platform, edition and the current patch.
4. Xenoblade Chronicles 2: exact Chapter 2 Rex/Nia question, two independently
   focused role passages and source-specific citations, without later-story text.
5. Aetherglass Requiem: an unfamiliar authored game established from acquired
   document evidence; the original physical “insert” instruction survives to audit.

These are **synthetic gameplay facts**, not measurements of real-game answer
accuracy. RSA/JWK OAuth verification, Gaming MCP validation/executor, workflow
identity/revision/idempotency, real search-provider abstraction/ranking, protected
resolver, HTML extraction, source and evidence CLEAR, passage selection, Trinity
orchestration and final answer binding run normally. Search/HTTPS/DNS/SDK effects,
empty stored lookup and provider ingress admission are controlled seams. The
semantic model substitute checks actual returned answer claims against selected
passages and source IDs; it withholds unsupported numbers and wrong-source
citations. It is not a successful live Trinity model test.

The compiled acceptance fixture closes the stored-lookup composition boundary:
`tests/fixtures/gaming-authority-compiled-http.mjs` uses authenticated MCP, actual
PostgreSQL repositories, a host search handoff through the compiled discovery
adapter, returned URL submission, protected acquisition of loopback HTTP bytes,
real SDK/adapter/Trinity transport, answer audit and separately confirmed synthetic
storage. Search provider results, DNS/publisher effects and model output remain
deterministic substitutes. This is the supported multi-request host workflow,
not a single-call live backend-search claim. The fixture refuses stale compiled
artifacts, unexpected network traffic and unowned database targets. Fresh-process
reads independently verify persisted authority and revocation restrictions.

## Acquisition, authority and budgets

The new held-out acquisition suite passes 30/30 at the starting head, versus
23 passed/seven failed on the original base. It covers long wiki sections with
independent acquired identity, navigation, lists, column/property tables, footer
qualifications, complementary evidence, conflicting values, game/platform/edition
and patch restrictions, URL/revision/hash/actor/TTL binding, 403/404/timeouts,
unsupported formats, partial material, private DNS, forbidden redirects and
exhausted acquisition. Metadata-only identity with the first useful nominal
anchor beyond the bounded scope remains rejected on both revisions.

The established budget regressions retain two gameplay rounds, three candidates
per submission, six URLs total, 12 seconds per submission and 24 seconds cumulative
acquisition, workflow TTL/revisions and cancellation. Accepted evidence survives
authorized recovery; failed and redirected destinations remain excluded. Parent
HTTP timing tests cover host handoff at 38 seconds and bounded automatic work at
60 seconds while reserving intake/reasoning/final/audit time. Timing models are
deterministic substitutes, not provider latency guarantees. No timeout, retry,
round, URL or storage allowance is increased.

Existing OAuth/owner isolation, v1/v2 contracts, source-use/instruction rejection,
SSRF checks, citation/currentness/spoiler restrictions and source-storage consent
remain enforced. The real PostgreSQL suites exercise authority grants, holds,
refresh/revision behavior, raw-readable unverified/reference-only rows and their
exclusion from generation. No configured application database or source records
were used; the fresh local cluster contains only authored test data.

## Live public-source observations

Live host searches identified attributable URLs; nine bounded candidate checks
used the actual compiled HTTPS reader and normal v2 source evaluation. No backend
search credential, Gaming login or model call was used. At the starting head:

| Scenario and publisher | Observed outcome |
| --- | --- |
| Zelda — Thonky | Acquired 4,142 characters; independent game identity unverified |
| Zelda — Zelda Dungeon | HTTP 403; no access-control bypass |
| Elden Ring — Mobalytics | HTTP 403 |
| Elden Ring — DualShockers | Acquired 62,920 characters; false game conflict partly isolated to grammatical adjuncts |
| Elite — Frontier official | Acquired 5,488 characters; independent game identity unverified |
| Elite — Silverback Research Institute | Acquired response but no usable extracted text |
| Elite — E:D Black Box | Source-instruction rejection; exact raw trigger not proven from retained, already-filtered material |
| Xenoblade 2 — GameFAQs | HTTP 403 |
| Xenoblade 2 — ConsolePulse | Acquired response but no usable extracted text |

None produced accepted gameplay evidence or a live final answer. Saved public
DualShockers material replayed offline after repair changes the false conflict to
`GAME_IDENTITY_UNVERIFIED` / family-scope uncertainty; it remains **unaccepted**.
The replay makes no fresh-network or live-provider claim. Source length, rankings,
publisher reputation and plausible gameplay prose do not authorize acceptance.

## Benchmarks and remaining limits

The original 15-case pure selector benchmark measures recall@3 80% to 86.67% and
fixed-slot precision@3 31.11% to 33.33%, with zero false authority acceptance. It
does not measure SQL search or generated-answer accuracy.

The independent [22-question held-out corpus](heldout-lexical.md) executes both
post-query service selection and actual PostgreSQL search. At both original base
and starting head, 13 positive questions yield recall@3 76.92%, fixed precision@3
30.77%, exact mechanics 7/7, complementary requests 2/2 and paraphrase retrieval
1/4. Paraphrase CLEAR acceptance is 0/4. All nine restriction controls withhold
approval. The identical 46 tests pass without skips at both revisions. These
unchanged results are reported separately from the development benchmark.

The natural Elite source's prose paragraph reporting PC/patch scope is omitted by
current passage selection and is not parsed into machine-readable applicability.
The positive answer therefore gives supported procedures and explicit uncertainty;
it does not claim the omitted PC version or patch number. Complex negated edition
clauses also retain conservative rejection. These limitations are not silently
reclassified as verified applicability.

Further work should first evaluate bounded lexical expansions and qualifier
retention against larger held-out corpora, including contradictory and cross-game
controls. A separate Phase 3 semantic comparison would need real SQL candidate
retrieval, passage and final-answer labels, authority false-positive measures,
latency/resource/cost limits and a separately authorized model budget. No embeddings,
vector database, reranker service or new model dependency is added here.

## Validation boundary

Use Node 24.18.1 / npm 11.16.0. Final exact-head commands and counts are recorded
with the PR verification receipt: type-check, lint, build, backend/CLI contract and
offline validation, all root Gaming suites, honesty/native-import regressions,
the seven guarded Gaming PostgreSQL suites, and docs/index/link checks. These
checks do not invoke a paid provider. Local test failures found during repair are
retained in ignored receipts; introduced failures must pass after repair.

The repaired prepublication tree passed these complete local gates:

| Check | Observed result |
| --- | --- |
| Type-check and build | Passed, including source/compiled boundary and reviewed semantic-pin checks |
| Lint | Passed; zero errors, 77 existing warnings |
| Gaming plus honesty/native-import regressions | 236 suites, 8,334 tests, zero failures/skips; in band with open-handle detection and normal exit |
| Guarded Gaming PostgreSQL | Seven suites, 167 tests, zero failures/skips; compiled discovery/SQL/SDK fixture included |
| Backend/CLI contract and Python offline validator | Both passed |
| Docs and generated indexes | Passed; 817 maintained local link targets passed |

An interim compiled attempt correctly refused an outdated build receipt after
source edits; a fresh full build repaired that validation precondition. The
compiled fixture subsequently passed without bypassing its identity assertion.
All suite-owned `gaming_%` schemas were absent after the database run. Published
head identity and GitHub CI status require the separate final PR receipt.

The test cluster is new PostgreSQL 18.6 on loopback port 52439 with the existing
guard-required disposable database name. Unique suite-owned schemas are removed
and their absence verified; the lead stops the owned cluster after validation.
Production configuration, credentials, services and source records are unchanged.
There is no production deployment or merge. Final CI is observed without requesting
another CodeRabbit round; pending or skipped checks are never reported as passed.

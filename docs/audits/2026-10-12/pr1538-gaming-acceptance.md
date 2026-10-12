# PR #1538 Gaming acceptance evidence — 2026-10-12

PR: https://github.com/pbjustin/Arcanos/pull/1538

**Deterministic development acceptance passes. Production release remains blocked by missing isolated preview and separately authorized live acceptance.** The source/fixture commit below is immutable; this report is published as a documentation-only descendant. The exact pushed SHA and its automatic CI are captured after publication in the external final handoff. A historical green check does not prove the final head.

## Candidate identity and scope

| Field | Evidence |
| --- | --- |
| Repository | `pbjustin/Arcanos` |
| Originally reviewed head | `da746f224bbecf74dff3b848a6e57023505ae3f2` |
| Base/main at freeze | `b6c81d46794700447f9d22ca226dcee36d1cd981` |
| Validated implementation commit | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) |
| Public implementation commit | `899c1ab7c05d8f68f46c7ca9acff732a108f8a6f`, tree-identical to the tested implementation commit |
| Final Git tree | Recorded in the final source/publication identity receipt; report-only delta is independently checked |
| Final validation interval (UTC) | 2026-10-12T00:45:06.384758+00:00 through 2026-10-12T00:50:15.138232+00:00 |
| Local toolchain | Node `24.18.1`; npm `11.16.0` |
| Original GitHub snapshot | 2026-10-12 00:02:14–00:03:40 UTC: OPEN, ready for review, unmerged, same-repository branch `fix/gaming-production-evidence`, base main, MERGEABLE/CLEAN, no labels; original diff 22 files / 807 additions / 52 deletions |
| Final PR/CI snapshot | Collected after publication in external `FINAL_REPORT.md` and `hosted/final/`; no future CI result is claimed here |

Every result must identify its actual tested commit and included local changes. Development receipts record the original HEAD plus source/fixture hashes and dirty-diff identity. They are kept separate from clean final-commit evidence. Protected main, production source and an unrelated commit's checks do not validate this candidate.

GitHub initially rejected publication with GH007 because unpublished commit metadata used a private email. The same authenticated owner’s GitHub noreply address replaced only that metadata; every commit tree was independently checked identical. Raw validation receipts retain their actual original SHAs. `publication-metadata-remap.json` maps each tested commit to its publicly fetchable equivalent; no credential, privacy setting, remote history or tested file was changed.

This task adds fixtures and fixes independently reproduced defects on the existing PR. It performs no merge, production deployment, native-autodeploy change, workflow reactivation, credential change, live Gaming call or persistent source ingestion. Disposable test-database rows are isolated synthetic data.

## Acceptance layers and seams

The served tests exercise real Express request context, MCP transport, request/output schemas, locally signed bearer verification and exact-owner/scope enforcement. Legacy requests retain the actual `ArcanosGaming.actions.query`, public request dispatcher, request classification and ordinary Gaming pipeline. Hybrid requests retain the real v1/v2 state machine, backend discovery instructions, candidate submission, ownership/revision/idempotency/budget controls and final response construction.

The resulting lifecycle is exercised from question/context and query generation through discovery/ranking, protected acquisition, HTML extraction, acquired game identity, edition/applicability, relevance, request coverage, freshness, compact evidence selection, grounding, generation admission, answer audit/binding, citation validation and final served MCP response.

External effects are deterministic: locally generated OAuth-like keys, synthetic DNS answers, a disposable loopback HTTP publisher behind the existing Axios fixture seam, isolated search results, empty/controlled retrieval, a sealed Trinity response and a synthetic semantic answer-review completion. Actual HTTPS/TLS publisher access, real OAuth login, installed private-plugin behavior, production provider-capacity middleware and model judgment are not proved. Provider admission is a local test seam. SQL/persistence and ingestion are trapped in served tests, and asserted unused. No fixture-specific production exception or reduced validation threshold is introduced.

Evidence-selection assertions bind final source URLs to the selected acquired documents; v2 candidate/evidence IDs to the actual chosen set; each audited chunk to its selected source/index and acquired content hash; the original question/context and selected passages to generation; and every final citation to an available selected source. Failed curated-source diagnostics cannot become citable grounding. Invalid source numbers, unknown evidence references and unselected citation URLs are rejected by their real validators.

## Scenario matrix

`P1` means the 21-case positive suite in `gaming-regression-final.json` at the clean tested implementation commit. The earlier `served-positive/eighth-results.json` is retained as development evidence. Results below are deterministic served evidence, not live-provider evidence.

| Scenario | Test layer | Expected | Observed | Evidence reference | Verdict |
| --- | --- | --- | --- | --- | --- |
| A — Church of Elleh location advice | Served hybrid v1 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: A: basic location advice travels through acquired evidence to cited answer | PASS |
| B — Stable equipment-load mechanic | Served hybrid v1 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: B: stable equipment-load mechanic travels through acquired evidence to cited answer | PASS |
| C — Early Samurai/Uchigatana stat advice | Served hybrid v1 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: C: early-game Samurai stat travels through acquired evidence to cited answer | PASS |
| D — One spoiler-safe preparation step | Served hybrid v1 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: D: one spoiler-safe preparation step travels through acquired evidence to cited answer | PASS |
| F — Stardew Valley watering mechanic | Served hybrid v1 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: F: non-Elden Ring first-spring mechanic travels through acquired evidence to cited answer | PASS |
| E — Both independently requested topics | Served hybrid v1 | Partial support blocks generation; complementary facts permit a cited answer | All assertions pass in the clean-commit aggregate | `P1`: E: complementary sources cover independently requested topics: Explain how to avoid heavy rolling and where to improve my weapon in early Elden Ring. | PASS |
| E — Both independently requested topics | Served hybrid v1 | Partial support blocks generation; complementary facts permit a cited answer | All assertions pass in the clean-commit aggregate | `P1`: E: complementary sources cover independently requested topics: Explain the mechanics of equipment load and weapon upgrades. | PASS |
| A — Church of Elleh location advice | Served hybrid v2 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: A: basic location advice travels through acquired evidence to cited answer | PASS |
| B — Stable equipment-load mechanic | Served hybrid v2 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: B: stable equipment-load mechanic travels through acquired evidence to cited answer | PASS |
| C — Early Samurai/Uchigatana stat advice | Served hybrid v2 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: C: early-game Samurai stat travels through acquired evidence to cited answer | PASS |
| D — One spoiler-safe preparation step | Served hybrid v2 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: D: one spoiler-safe preparation step travels through acquired evidence to cited answer | PASS |
| F — Stardew Valley watering mechanic | Served hybrid v2 | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: F: non-Elden Ring first-spring mechanic travels through acquired evidence to cited answer | PASS |
| E — Both independently requested topics | Served hybrid v2 | Partial support blocks generation; complementary facts permit a cited answer | All assertions pass in the clean-commit aggregate | `P1`: E: complementary sources cover independently requested topics: Explain how to avoid heavy rolling and where to improve my weapon in early Elden Ring. | PASS |
| E — Both independently requested topics | Served hybrid v2 | Partial support blocks generation; complementary facts permit a cited answer | All assertions pass in the clean-commit aggregate | `P1`: E: complementary sources cover independently requested topics: Explain the mechanics of equipment load and weapon upgrades. | PASS |
| A — Church of Elleh location advice | Served legacy MCP | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: A: basic location advice keeps the public legacy request and selected evidence bound | PASS |
| B — Stable equipment-load mechanic | Served legacy MCP | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: B: stable equipment-load mechanic keeps the public legacy request and selected evidence bound | PASS |
| C — Early Samurai/Uchigatana stat advice | Served legacy MCP | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: C: early-game Samurai stat keeps the public legacy request and selected evidence bound | PASS |
| D — One spoiler-safe preparation step | Served legacy MCP | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: D: one spoiler-safe preparation step keeps the public legacy request and selected evidence bound | PASS |
| F — Stardew Valley watering mechanic | Served legacy MCP | Specific discovery, admissible evidence, grounded fixture answer and selected citations | All assertions pass in the clean-commit aggregate | `P1`: F: non-Elden Ring first-spring mechanic keeps the public legacy request and selected evidence bound | PASS |
| E — Both independently requested topics | Served legacy MCP | Partial support blocks generation; complementary facts permit a cited answer | All assertions pass in the clean-commit aggregate | `P1`: E: legacy generation waits for complete multi-part grounding: Explain how to avoid heavy rolling and where to improve my weapon in early Elden Ring. | PASS |
| E — Both independently requested topics | Served legacy MCP | Partial support blocks generation; complementary facts permit a cited answer | All assertions pass in the clean-commit aggregate | `P1`: E: legacy generation waits for complete multi-part grounding: Explain the mechanics of equipment load and weapon upgrades. | PASS |

| Scenario | Test layer | Expected | Observed | Evidence reference | Verdict |
| --- | --- | --- | --- | --- | --- |
| A–F actual isolated hosted preview | Existing sealed preview lane | Run exact final SHA within approved isolation controls | Lane not executed; actual E2E skipped/inadmissible as described below | `hosted/REPORT.md` and exact run/job inventory | BLOCKED |
| A–F real provider acceptance | Exact-final-SHA isolated live runtime | Real acquisition/generation and safely retained provenance | No authorized usable live target/runtime established; no calls made | `hosted/REPORT.md`, live-environment read | NOT_EXECUTED |

A–D/F start without supplied guides. The legacy route performs actual query construction/ranking with an isolated search provider; hybrid routes first return authoritative discovery instructions. E first proves generation is withheld with only equipment-load support, then proves complete independently selected equipment-load and weapon-upgrade support. Both “how to avoid heavy rolling and where to improve my weapon” and “mechanics of equipment load and weapon upgrades” framing are covered. V1 retains its one-submission limit; a new independent complete fixture run supplies both sources together. V2 uses only its granted bounded continuation.

## Thirty-nine served control cases

`N1` means the 39-case control suite in `gaming-regression-final.json` at the clean tested implementation commit; earlier negative-control receipts remain reproduction evidence. This includes the paired valid-provenance control and duplicate-selection positive control, which make their negative checks meaningful. All cases traverse the authenticated served MCP boundary. Final exact-head rerun: `gaming-regression-final.json`: all 39 controls PASS at the clean tested commit.

| Scenario | Test layer | Expected | Observed | Evidence reference | Verdict |
| --- | --- | --- | --- | --- | --- |
| Wrong game, incompatible DLC, ambiguous identity under v1/v2; contradictory same-location owner (7) | Served MCP fixtures | Reject acquired conflict/unverified identity; no generation | All seven assertions passed | `N1`, identity cases; focused identity regression | PASS |
| Unrelated source, incomplete multi-topic coverage, unsupported current-patch claim, incomplete article fragment (4) | Served MCP fixtures | No complete coverage or unsupported generation | All four assertions passed | `N1`, grounding cases | PASS |
| Missing citation provenance and otherwise identical complete-provenance control (2) | Served MCP + controlled cache | Missing timestamp yields no selected evidence/generation; complete provenance reaches cited answer | Both assertions passed | `N1`, cached citation provenance | PASS |
| Untrusted source instructions (1) | Served MCP fixture | Reject before grounding/provider execution | Instruction rejection, zero generation | `N1`, source instructions | PASS |
| HTTP 403 and deadline (2) | Served MCP + loopback publisher | Bounded `SOURCE_INACCESSIBLE` / `SOURCE_TIMEOUT`; no answer | Both classifications passed | `N1`, acquisition cases | PASS |
| Insecure/private/user-info URL and private DNS (4) | Served MCP + real admission | Stop before an HTTP hop | Zero acquisition/provider calls | `N1`, unsafe URL/DNS cases | PASS |
| Unreviewed host, HTTP downgrade and private redirect (3) | Served MCP + loopback 302 | Reject after initial hop; do not follow forbidden destination | One initial publisher request only | `N1`, redirect cases | PASS |
| Compressed decoded-size bound (1) | Served MCP + compressed fixture | Small compressed payload cannot exceed decoded ceiling | `SOURCE_TOO_LARGE`; no generation | `N1`, decoded-size case | PASS |
| Tracking aliases (1) | Served MCP fixtures | One acquisition/candidate; canonical citation only | Duplicate alias suppressed | `N1`, alias case | PASS |
| Stale revision, strict candidate replay/payload conflict, changed query replay (3) | Served MCP workflow | No new authority/acquisition/generation from invalid mutation/replay | All three assertions passed | `N1`, revision/idempotency cases | PASS |
| Workflow ownership, expiry, terminal stop and candidate-count cap (4) | Served MCP workflow | No foreign/expired/closed workflow or fourth acquisition | All four assertions passed | `N1`, lifecycle cases | PASS |
| Invalid citation number, unknown audit evidence ID, spoiler failure (3) | Served MCP + sealed generation/audit | Withhold generated text; no repair/retry | All three asserted stops passed | `N1`, answer-audit cases | PASS |
| Query-only durable ingestion (1) | Served MCP permissions | Reject before any durable write | Permission denied; no ingestion or SQL calls | `N1`, write case | PASS |
| Missing token and signed non-owner token (2) | Served OAuth-like middleware | Reject before workflow/provider work | HTTP 401; zero retrieval/acquisition/generation | `N1`, authentication cases | PASS |
| Administrative tool outside Gaming catalog (1) | Served MCP catalog | No administrative route or execution | Tool unavailable; zero work | `N1`, catalog case | PASS |

Existing served discovery-recovery, Samurai, transport and answer-audit suites add total acquisition budgets, redirected evidence membership, cancellation, citation URL controls and broader protocol boundaries. Their final execution/counts belong to the aggregate ledger below; inspecting them is not recorded as execution. The controlled-clock timeout proves the real deadline decision, not a real stalled remote socket. The incomplete-fragment fixture lacks a full mechanic; it is not a measured transport-truncation receipt. Existing extraction/large-source suites separately exercise truncation/partial-unit controls.

## Fixture inventory and provenance

The [fixture manifest](../../../tests/fixtures/gamingAcceptance/manifest.json) declares `provenance=synthetic` and `capturedPublicResponses=false`. The 14 HTML files reuse stable mechanic/complementary/alias cases rather than duplicate the same source into unnecessary fixture files. They preserve meaningful headings, explicit game/edition statements, article content, acquisition status and evidence relationships. Publication dates deliberately permit stable old mechanics without fabricating current balance evidence.

| Fixture(s) | Required evidence characteristic |
| --- | --- |
| `church-elleh.html` | Location heading plus independently acquired explicit Elden Ring ownership and safe immediate preparation |
| `ambiguous-location.html` | Location-only heading without independent game ownership |
| `wrong-game.html` | Acquired Diablo IV ownership |
| `dlc.html` | Shadow of the Erdtree scope incompatible with base-game request |
| `equipment-load.html` | Clean stable equipped-weight/rolling principle; reused stable-mechanic fixture |
| `early-stat.html` | Early Samurai/Uchigatana/Vigor survival guidance without optimal/current-meta assertion |
| `equipment-load.html` + `weapon-upgrade.html` | Complementary independently requested topics and source/evidence relationships |
| `unrelated-status.html` | Accessible poison/scarlet-rot guidance with explicit disclaimer of unsupported requested topics |
| `forbidden.html` | HTTP 403 acquisition metadata |
| `timeout.html` | Controlled acquisition deadline metadata |
| `partial.html` | Incomplete extracted mechanic fragment with insufficient usable request support |
| `instruction.html` | Untrusted instructions in otherwise game-shaped source content |
| `patch-sensitive.html` | Old/unverified balance recommendation cannot establish requested current patch |
| `equipment-load` manifest `trackingAliases` | Equivalent removable tracking selectors collapse to the same source |
| `non-elden-mechanic.html` | Stardew Valley early parsnip-watering mechanic |

Clean positive location/weapon-upgrade fixtures omit unnecessary compound DLC wording that the existing conservative applicability grammar classified `EDITION_UNVERIFIED` during fixture development. The original failures are retained in the positive evidence package. This does not establish universal negation/edition grammar or exact production payload compatibility; acquired explicit DLC incompatibility remains covered and rejected. The fragment fixture demonstrates incomplete evidence sufficiency rather than a measured transport truncation.

The served suites are [ordinary positive acceptance](../../../tests/gaming-ordinary-gameplay-acceptance.integration.test.ts) and [negative acceptance](../../../tests/gaming-ordinary-negative-acceptance.integration.test.ts). Existing focused identity and request-coverage suites also contain synthetic extracted documents/records; these are not captured publisher pages.

## Reproduced defects and minimal corrections

| Reproduction | Before | Small correction and verified after |
| --- | --- | --- |
| Game-qualified location metadata hides an acquired foreign owner of the exact same topic, including an uncatalogued game and late contradiction | Identity falsely verified; expanded focused proof 39 passed / 3 failed | Bind independently acquired contradictory typed ownership to actual title/primary topic; same 42 identity cases passed. Quoted/negated/unrelated topics retain their prior handling; no positive identity bound is enlarged. |
| Generic “mechanics/benefits of X and Y” framing | Two facts collapse into one named object or require repeating framing words in source facts | Reuse bounded generic relationship-head vocabulary to split independent subjects and remove only relationship framing. Atomic names such as Sword of Night and Flame still require an intact same-passage relationship. |
| Unrelated status article says it “does not explain” equipment load/heavy rolling | Actual served result selects disclaimer, sets coverage true and invokes generation once | Source-scope negative explanatory predicates earn no topical support credit. Same acquired source now rejects with `QUESTION_COVERAGE_INSUFFICIENT`, empty selected IDs and zero generation/audit. Source text and genuine negative gameplay facts stay intact. |
| Legacy/v1 missing independent second requirement, atomic target or over-eight-requirement overflow | Common CLEAR could verify claim support without complete requested coverage | Reuse existing request coverage whenever explicit requirements or overflow exist. Incomplete requests remain blocked across legacy/v1/v2; public schemas and budgets remain unchanged. |
| Dropped caveat beside selected genuine fact | Source's lack of weapon-upgrade support was absent from grounding | Extend existing source-limitation retention vocabulary; retain caveat without awarding unsupported topical credit. |
| Complete parser-owned resource tuple lacks question-formatting verb `reports` | New common strict coverage falsely rejects an otherwise intact system/body/site/resource relationship | Omit only the closed give/show/list/find/report/reports/reporting request verbs from a structural lexical requirement when the same intact unit passes the original full-question claim assessment. Values, mandatory fields, side questions, punctuation-bound identifiers, conflicts and partial-unit rejection remain binding. Complete tuple, partial/mixed/conflicting rows, swapped values and unsupported stamina/patch side questions are covered in the canonical sweep. |
| Shared “How do X, Y and Z work?” predicate and regional list qualifier | Common coverage demanded literal `work`/`regional` despite complete topic facts and independently checked scope | Normalize only this explicit list-question frame. Named work objects, personal actions, current-patch side questions and missing/conflicting region controls remain strict. Focused before: 74 passed / 4 failed; after: 78 passed / 0 failed. |
| Current-patch contextual preamble | The comma in “On the current patch, how…” introduced a separate artificial topic | Attach the contextual preamble to its actual question; retain original freshness classification and independent patch-change requirements. |

Before/after evidence is retained in the sanitized external audit package under `wiki-identity/`, `core-review/`, `negative-controls/`, `served-positive/` and `validation/structured-compat-final/`. Production fixes contain no game/publisher/fixture-specific bypass. Existing pure-preview semantic digest pins are updated using the scanner’s normalized TypeScript AST (comments removed, LF); import/authority restrictions and public workflow definitions are preserved.



## Exact wiki incident

**PRODUCTION_WIKI_REJECTION_NOT_EXACTLY_REPRODUCED**

The reported URL is `https://eldenring.wiki.gg/wiki/Church_of_Elleh`; reported outcome `GAME_MISMATCH`, rule `gaming.identity.distinct_body_scope`, approximately 8,488 extracted characters. No authorized exact acquired metadata/body capture was available. Local artifact discovery found reports and code diffs, not the original payload. Synthetic qualified/unqualified headings, explicit typed ownership, contradictory owners and edition qualifiers test general rules; a passing synthetic fixture cannot prove this precise production rejection was fixed. No live wiki fetch or baseline-production acceptance call was substituted.

Required evidence remains an authorized isolated exact-final-SHA acquisition retaining safe metadata and sanitized identity signals, or an authorized original capture. Preserve the incident as unresolved until that evidence exists.

## Validation ledger

All commands run at the repository root with the pinned toolchain and inspected existing test wrapper. `scripts/test-env.mjs` clears production-only database/Redis/Railway selectors and disables external calls/workers; each selected integration path is also inspected. Do not print real environment values or database selectors in this report.

| Check / exact command | Tested identity | Exit and counts | Evidence |
| --- | --- | --- | --- |
| `node scripts/run-jest.mjs --runTestsByPath tests/gaming-ordinary-gameplay-acceptance.integration.test.ts --coverage=false --runInBand --json --outputFile=<audit>/served-positive/eighth-results.json` | Original HEAD + hashed repaired development tree | 0; 21 passed / 0 failed / 0 skipped | `P1`, source before/after hashes unchanged |
| `node scripts/run-jest.mjs --runTestsByPath tests/gaming-ordinary-negative-acceptance.integration.test.ts --coverage=false --runInBand --json --outputFile=<audit>/negative-controls/final-dirty-jest.json` | Original HEAD + audited development diff | 0; 39 passed / 0 failed / 0 skipped | `N1`, dirty-tree receipt; before/after unsupported-source proof |
| Existing focused request coverage/discovery/freshness suites | Original HEAD + hashed repaired development tree | 0; 230 passed / 0 failed / 0 skipped before subsequent structured compatibility addition | `core-review/final-focused-receipt.json` |
| `node scripts/run-jest.mjs --runTestsByPath tests/integration/gaming-durable-rag.pg18.integration.test.ts --coverage=false --runInBand --json --outputFile=<audit>/postgres/baseline-jest-results.json` | Original HEAD + stable audited development inputs | 0; 9 passed / 0 failed / 0 skipped | Disposable PostgreSQL 18.6, required database sentinel; baseline source/cleanup receipts |
| Final relevant Gaming + legacy/v1/v2 + security + preview-boundary Jest sweep | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) | 5359 unique PASS / 0 unresolved failures / 0 skipped across the two unchanged-commit runs; raw broad exit 1, focused rerun exit 0 | `validation/gaming-regression-final/receipt.json` contains all 161 exact paths/arguments; `coverage-ledger.json` binds each suite to its observed result |
| `node --test scripts/gaming-exact-commit-verification.test.mjs scripts/gaming-exact-commit-sandbox.test.mjs scripts/native-pr-preview-e2e.test.mjs scripts/stacked-draft-preview-contract.test.mjs scripts/stacked-draft-preview-runtime.test.mjs scripts/stacked-draft-preview-probe.test.mjs scripts/stacked-draft-preview-workflow.test.mjs scripts/stacked-draft-preview-build.test.mjs scripts/railway-stacked-draft-preview.test.mjs` | `ea827d7650a07db5715ee8c90186818f4bb1aecd` | 0; 305 PASS / 0 FAIL / 0 skipped | `validation/preview-contracts-final/receipt.json`, `output.log` |
| Final disposable PostgreSQL Gaming integration | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) | 9 PASS / 0 FAIL / 0 skipped within the aggregate (not counted twice) | `gaming-regression-final.json` PG18 suite; `postgres/final-cleanup-verification.json` and `postgres/REPORT.md` |
| `npm run type-check` | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) | 0 | `validation/type-check-clean-final/receipt.json` |
| `npm run lint` | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) | 0; 77 existing warnings, 0 errors | `validation/lint-final/receipt.json`; runtime/test bytes unchanged from tested implementation commit |
| `npm run build` | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) | 0 | `validation/build-clean-final/receipt.json` |
| `npm run docs:check` | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) | 0; documentation and generated-index validation | `validation/docs-report/receipt.json` (publishing check) |
| `npm run docs:links -- --local-only` | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) | 0; local links checked, external network checks intentionally excluded | `validation/docs-links-report/receipt.json` (publishing check) |
| Relevant security scans and commit guard | `ea827d7650a07db5715ee8c90186818f4bb1aecd` (tested implementation commit; final report-only publishing SHA recorded in external final handoff) | Gitleaks 8.24.3 exact candidate range: 0 findings; production npm audit/policy: 0 vulnerabilities/0 actionable; commit guard: 0 | `security/REPORT.md`, verified scanner digest and final normalized-pin review; final report-only publication also secret-scanned |
| Final GitHub check/job/run inventory | Actual final publishing SHA, resolved after push in the external final handoff | NOT_EXECUTED at document publication; final exact-head completion recorded separately in external final handoff | Resolved after push from authoritative GitHub API, not inferred from historical CI |

Development diagnostic runs using `--testNamePattern` have explicit name-selection skips; those are not database skips or unexecuted release requirements. Do not add repeated executions to a unique test total. Final unique total: 5359 Jest PASS / 0 unresolved FAIL / 0 skipped, plus 305 Node preview-contract PASS / 0 FAIL / 0 skipped (5664 unique cases total); repeated focused tests and the included 9 SQL/60 served cases are not double-counted. Remaining skipped tests/reasons: zero in local final unique Jest inventory; hosted conditional skips inventoried after publication; isolated preview BLOCKED and live NOT_EXECUTED are separate missing layers.


The clean aggregate ran 161 suites: 5344 passed, 15 failed, 0 skipped; exit 1. Every failure was a default 5000 ms timeout while the compiler also ran on a 2-CPU cgroup. Only the four affected existing preview suites were rerun serially, with unchanged source/limits: all 30 passed, exit 0. `coverage-ledger.json` preserves both runs and attributes each of the 5359 unique cases; it is an evidence ledger, not a fabricated green single-run report. The first earlier sweep on `017c58e6d16d9a14e5d46e4dd276c80e469c2cda` had 5312 passes/34 failures and identified the repaired compatibility/pin issues.

### Previously skipped PostgreSQL cases

All nine Gaming durable SQL tests were run against an independently identified disposable local PostgreSQL 18.6 instance, with the repository's required-database sentinel. They exercise real SQL transactions, JSONB, full-text ranking, late indexed evidence, active revisions/reactivation, provenance retention, monotonic verification and failed-transaction rollback. Acquisition/admission/generation seams remain synthetic as declared by that suite.

The container is task-owned, resource-limited, loopback-only and backed by temporary storage; no production PostgreSQL is used. Each suite owns and removes its random synthetic schema. Independent baseline cleanup observed zero remaining Gaming test schemas. Final exact-commit execution passed all nine cases; final owned-container absence is independently recorded in the external cleanup receipt; local connection strings/credential material/private selectors are not included or published here.

## GitHub and hosted evidence

Original reviewed-head CI [38184182528](https://github.com/pbjustin/Arcanos/actions/runs/38184182528) finished SUCCESS at 2026-10-11 23:44:42 UTC. All 13 expected CI/CD jobs succeeded. Original exact-head inventory: 33 checks, 24 SUCCESS, 9 conditional SKIPPED, zero failed/cancelled/pending. Its tests counts are not inferred from job success. This historical result does not apply to subsequent repair commits; final required-job completion and PR head/check binding remain not yet available when this report was committed; external final handoff supersedes this temporal CI gate.

The exact-commit mocked lane, workflow `381541173`, accepts only pinned PR #1534/#1535 identities and stacked draft/base conditions. PR #1538 is rejected with `GAMING_CI_SOURCE_NOT_AUTHORIZED`. The alternate stacked-draft preview policy is disabled and restricted to the former stack. Neither is modified or knowingly dispatched just to obtain a result.

Standard Railway PR Preview Lifecycle `333783655` and reusable lane `333783656` require the existing `railway-preview` opt-in label. The original PR is unlabelled. Its lifecycle reconciliations succeeded as no-ops; sealed E2E jobs were SKIPPED. No-op controller success is not preview validation. Owner authorization for that isolated opt-in/deployment boundary, fresh exact-final-head attribution and the normal controller safety checks are required before execution. Preview definitions, production triggers and native autodeploy remain unchanged.

Live-provider acceptance is **NOT_EXECUTED**. The existing protected `live-pr-acceptance` environment returned HTTP 404 through the available authorized identity at 00:03:39.894691 UTC; it may be absent or concealed. Available managed-cloud readiness did not establish authorized non-production runtime/provider bindings. No credential values were requested. The existing live lane requires an independently safe isolated target, exact source/artifact identity, scoped runtime credentials, bounded provider/spend/workflow/time limits, no persistent writes and separate paid/live authorization. Current production is not an acceptable substitute for this PR's exact code.

## Release gates

Local gates below apply to the immutable tested implementation and unchanged runtime/test bytes at publication. CI is evaluated only after push; the external final handoff records that temporal gate and the exact PR head.

| Gate | Status | Supporting evidence / remaining condition |
| --- | --- | --- |
| CODE_CORRECTNESS_VERIFIED | VERIFIED | 5359 unique Gaming/MCP/compatibility assertions pass; minimal fixes independently reproduced/reviewed |
| OFFLINE_E2E_VERIFIED | VERIFIED | Acquisition, extraction, identity, applicability, selection, coverage and grounded handoff pass with declared deterministic seams |
| SERVED_MCP_E2E_VERIFIED | VERIFIED | 21 ordinary positive cases + 39 controls pass through real legacy/v1/v2 MCP boundaries with synthetic providers |
| FIXTURE_COVERAGE_VERIFIED | VERIFIED | 14 synthetic HTML responses plus manifest/pair/alias reuse cover all 15 requested fixture classes |
| NEGATIVE_CONTROLS_VERIFIED | VERIFIED | All 39 new served controls and existing admission/security/compatibility regressions pass |
| SECURITY_REGRESSIONS_CLEAR | VERIFIED | Secret scan, production dependency policy, normalized semantic pins, boundaries and negative tests pass |
| CI_GREEN_EXACT_HEAD | BLOCKED | Evaluated after this report-only publishing commit; the external final handoff supersedes this temporal CI gate |
| ISOLATED_PREVIEW_VERIFIED | BLOCKED | Exact-commit lane disallows #1538; supported sealed lane lacks opt-in and actual E2E result |
| LIVE_PROVIDER_VERIFIED | NOT_EXECUTED | No separately authorized exact-final-SHA isolated live execution |
| PRODUCTION_RELEASE_READY | BLOCKED | Required hosted/live evidence incomplete; no merge or production promotion authorized by this task |

## Required next action and review boundary

Publish these verified fixtures/corrections to the existing PR, capture automatic CI for the actual final SHA, then stop at review. The smallest separately authorizable operational step is the existing isolated sealed preview opt-in for the final head, after validating its isolated target/ownership. Separately establish the protected live environment and a safe exact-final-SHA runtime, then authorize bounded live acceptance. Capture the unresolved wiki identity evidence in that isolated scope. Production promotion and merge remain separate owner decisions; do not enable or restore deployment automation to manufacture release readiness.

External sanitized execution receipts are maintained under `/workspace/arcanos-pr1538-acceptance-20261012/`. This tracked report contains non-secret source identity, commands, outcomes and limitations; raw confidential logs, credentials, real player data and private database selectors are excluded.

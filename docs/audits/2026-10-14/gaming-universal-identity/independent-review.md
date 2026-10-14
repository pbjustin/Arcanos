# PR #1543 independent review and corrections

The review began at `6e136915051338447923a3d2a1277cbf4b1c80e8` against main
`c8bb00ee000e3e188f17e1aa2b5e2893d0221fb8`. Dependency #1542 remains open and
draft at `e24d5614748f39e25e27a0c062dfba2ea0adbb77`. That parent and current main
are ancestors of the reviewed head. All 54 cumulative changed files were
inspected; the independent capability increment contains 44 files. No dependency
merge or rebase was performed. Keep this PR draft and merge #1542 first only
after owner authorization, then refresh #1543's exact head/base and required CI.

## Findings and dispositions

| Severity | Trigger and root cause | Repair / disposition |
| --- | --- | --- |
| P1 | Matching title plus `Silver Harbor features only a comparison to an unrelated game.` or `has merely a reference in a reader request.` verified identity. The affirmative predicate excluded only a narrower reference form. | `src/shared/gaming/gamingAcquiredIdentity.ts:37` excludes bounded reference-only predicates; affirmative gameplay controls remain accepted. |
| P2 | `Tidal Prism Alignment guide` was inferred as a foreign game despite independent `In the game Slate Meridian` evidence. The heading itself counted as corroboration of its inferred identity. | `src/shared/gaming/gamingClearSource.ts:291` separates a novel metadata topic from explicit acquired game scope. Independently declared foreign subjects and registered-family conflicts still reject. |
| P2 | `Velvet Circuit III: The Glass Horizon` and Arabic `3` conflicted; stripping subtitle punctuation before metadata comparison lost the numeral boundary. | `src/shared/gaming/gamingGameRegistry.ts:10` and `gamingClearSource.ts:420` preserve explicit subtitle boundaries while comparing title-ending sequel numerals. Different subtitles, sequels, remakes, and leading V in V Rising stay distinct. |
| P2 | Exact-artifact current CLEAR approvals for unfamiliar mechanics and numeral-equivalent titles were rejected during durable ingestion by another metadata-only identity guess. | `src/services/gamingSourceIngestion.ts:1242` preserves approved identity after content, policy and applicability checks. Public unapproved ingestion keeps its mismatch rejection. Changed or injection-bearing refetches reject before storage. |
| P2 | After tightening the identity predicate, older internal v3 approvals could still parse and retain obsolete authority in queued ingestion/stored provenance. | `src/shared/gaming/gamingClearPolicy.ts:8` advances the internal policy to v4. Public `gaming-clear/v1` and hybrid-v2 schemas stay unchanged. Queued v1-v3 approvals require reassessment; stored old assessments do not attach as current authority. |
| P1 | A stored v3 assessment was removed, but its complete acquired-applicability snapshot still allowed the legacy fallback to accept evidence. Approval invalidation therefore did not prevent generation authority from being restored. | `src/services/gamingStoredKnowledge.ts:59` marks invalidated explicit assessment applicability unverified in the request projection. Text and original restrictions stay readable; the stored record is unchanged. Current valid assessments still accept; obsolete snapshots require reassessment. |
| P3 | A complete structural record whose Game field contains only a source-local alias is excluded before canonical alias scope can be propagated. | Conservative limitation retained and tested. Canonical prose can identify the source, but excluded alias-valued records cannot ground claims or contaminate another source. Supporting this end to end would require a separate provenance design. |

No P0 finding, game-name production exception, new dependency, public schema
change, acquisition exemption, or budget expansion was introduced. Semantic
preview pins and all four coupled indexes were regenerated after reviewing the
pure code changes. Historical validation and performance receipts in this
directory describe the original head and are intentionally preserved.

## Architecture and adversarial evidence

Requested identity is caller scope, not acquired proof. Acquired affirmative
game subjects and reviewed alias collisions establish document ownership;
topic detection does not. Edition/platform/currentness applicability, source
quality, intact claim evidence, question coverage, evidence selection, Trinity
generation, and response citation/audit remain separate gates. Release ownership
does not establish currentness. Source text remains untrusted data.

The actual hybrid-v2 workflow now runs 77 synthetic cases, including four new
unregistered games: Velvet Meridian, Velvet Meridian Echoes, Drift, and Aurora
Atlas IV: The Quiet Tide. Guide-framed unfamiliar mechanics reach intake,
reasoning, final generation and the bound answer audit, with selected source and
evidence IDs, URLs, citations, revisions and actor/idempotency checks. Overlapping
foreign games, insufficient coverage and mixed identities stop or recover within
two rounds without generation. Only the valid source in mixed candidate sets
reaches Trinity. HTTP/DNS/provider transports are synthetic; persistence sinks
forbid writes. These cases prove exercised behavior, not live provider acceptance
or every game/language/publisher format.

Independent identity tests add 33 cases: eight requested generic headings,
unknown overlapping names, an ordinary-word title, exact localized title,
subtitle/numeral equivalence, novel mechanics, references, family conflicts and
positive controls. Independent CLEAR tests add ten acquired-document cases for
approved storage, incomplete claims, insufficient gameplay, consent, source-local
alias isolation and changed/injection-bearing refetches. An additional persisted
retrieval/compaction regression and five old-version/corruption controls prove
obsolete applicability cannot restore acceptance. Storage uses an
in-memory SQL harness, not a live database. Six performance-boundary tests cover
120-character titles, ordinary-word ambiguity, exact 1M documents and late
conflicts, assertion and alias limits, and requested-title overflow.

## Validation and measurements

Canonical local tools: Node 24.18.1 / npm 11.16.0. All commands below run from
repository root. Focused test selection uses explicit files. Broad/full final-SHA
results and canonical CI links are recorded in the owner-facing final report;
this committed note records corrections and the completed focused checkpoint.

```powershell
npm ci
npm run type-check
npm run lint
npm run build
npm run validate:railway
npm run reindex
npm run docs:check
npm run docs:links -- --local-only
git diff --check
node scripts/run-jest.mjs --runTestsByPath tests/gaming-universal-workflow.integration.test.ts tests/native-pr-preview-import-boundary.test.js tests/dag-metrics-preview-fixture.test.ts --coverage=false --runInBand --json --outputFile=.review-final-focused.json
node scripts/run-jest.mjs --runTestsByPath tests/gaming-independent-identity-review.test.ts tests/gaming-universal-source-identity.test.ts tests/gaming-game-registry.test.ts tests/gaming-game-identity.test.ts tests/gaming-universal-adversarial.test.ts tests/gaming-generic-source-scope.test.ts tests/gaming-generic-late-source-scope.test.ts tests/gaming-live-source-identity-regressions.test.ts tests/gaming-body-identity.test.ts tests/gaming-clear-source.test.ts tests/gaming-source-scope-negation.test.ts tests/gaming-acquired-topic-identity.test.ts --coverage=false --runInBand --silent
node scripts/run-jest.mjs --runTestsByPath tests/gaming-independent-clear-review.test.ts tests/gaming-source-ingestion.test.ts tests/gaming-stored-knowledge.test.ts tests/gaming-clear-source.test.ts tests/gaming-clear-policy.test.ts tests/gaming-clear-evidence.test.ts tests/gaming-clear-answer-audit.test.ts tests/gaming-generic-stored-source-scope.test.ts tests/gaming-universal-currentness-identity.test.ts tests/gaming-resolved-source-ingestion.integration.test.ts tests/gaming-clear-preview-fixture.test.ts --coverage=false --runInBand --silent
node scripts/run-jest.mjs --runTestsByPath tests/gaming-independent-performance-review.test.ts tests/gaming-universal-performance.test.ts --coverage=false --runInBand --json --outputFile=local_artifacts/independent-performance-review.json
node scripts/run-jest.mjs --runTestsByPath tests/gaming-document-resolution.test.ts tests/gaming-source-acceptance-acquisition.test.ts tests/gaming-execution-budget.test.ts tests/gaming-hybrid-edition-budget.test.ts --coverage=false --runInBand --json --outputFile=local_artifacts/independent-transport-budget-review.json
npm test -- --coverage=false --maxWorkers=2 --json --outputFile=.review-full-tests.json
npm run guard:commit
```

Focused checkpoint: identity 513 tests, CLEAR/storage 394 before the additional
stored-approval fallback regression, transport/budgets 137,
performance seven, final workflow/boundary/metrics 496 (including workflow 77
and preview boundary 410). These overlap and must not be added together.
Type-check/build/static Railway/docs/index/links pass; lint has zero errors.
Docker's local daemon is unavailable; local PostgreSQL suites skip. Hosted
disposable PostgreSQL 18 is required for final SQL proof.

Final Gaming validation selects all 166 actual Gaming test files and passes
5,224 tests in 165 suites, with nine guarded PostgreSQL tests skipped. The command
expands `rg --files tests` through `gaming.*\.test\.[jt]s$` and supplies those
explicit files to `node scripts/run-jest.mjs --runTestsByPath`, with
`--coverage=false --maxWorkers=2 --json --outputFile=.review-gaming-final.json`.
Final type-check/build/docs/index/links and focused changed-file ESLint pass.
The broad diagnostic Windows sweep begun during review reports 18,004 passes,
six assertion failures, 165 skips and one worker-memory suite crash. Both failing
assertion files reproduce all six failures on unchanged main at `c8bb00ee`:

```powershell
node scripts/run-jest.mjs --runTestsByPath tests/railway-production-readonly-inspection.test.js tests/self-healing-restart.test.js --coverage=false --runInBand --json --outputFile=.review-base-platform-failures.json
node scripts/run-jest.mjs --runTestsByPath tests/prompt-config-error-log-hygiene.test.ts --coverage=false --runInBand --json --outputFile=.review-oom-isolation.json
```

The memory-crash suite passes in isolation. The six stable failures are Windows
receipt-path/symlink and ESM absolute-path behavior in unchanged code; they are
not Gaming regressions. Final exact-source full Linux and PostgreSQL results
must be checked after push rather than inferred from these local diagnostics.

The original 14 paired performance cases were reproduced against #1542's head
and the repaired code. Known-game 512K acceptance medians were 21.7955 ms before
and 16.5336 ms after; foreign rejection 8.2890 / 8.0506 ms; assertion overflow
206.4061 / 163.0309 ms. A 120-character unknown title at exact 1M characters took
26.0823 ms median, 26.9547 ms maximum. Unknown positive outcomes differ between
baseline and reviewed code and are capability comparisons. All measurements
exclude acquisition, SQL and provider latency and do not prove end-to-end gains.

Protected DNS/address validation, destination pinning, three redirects, 5MB
aggregate bytes, 1M durable text, three candidates per round, two gameplay rounds,
six total URLs, 12 seconds per round and 24 seconds total remain enforced.
Existing MCP/pipeline 60/50 second defaults and parent clamps are unchanged.

## Audit of original receipts

Initial-head CI/CD run 38515747594 and PR CI 38515747724 completed successfully:
17,939 Linux tests passed, 167 skipped; PostgreSQL 18 passed 202 tests in 15 suites.
Checkout `7988225ce1020e525418288ddfc6943941f6f765` has tree
`c45fedc840601c0612eca936913bfd3bcd35765f`, identical to initial head's tree.
Artifact 11873030163 correctly retains intermediate IN_PROGRESS and
NOT_YET_EXECUTED snapshot values; terminal run/job APIs and successful aggregate
steps establish completion, not that snapshot alone. All 34 original normalized
source fingerprints match the initial head. Raw local receipts independently
confirm 5,154 Gaming passes, 63 original workflow passes, 410 boundary passes,
and Windows 17,932 passes / nine failures / 165 skips. The existing unchanged-main
comparison receipts reproduce platform failures; relevant files are unchanged.
CodeRabbit skipped draft review, so its status is not an independent code review.

LIVE_ACCEPTANCE: NOT_RUN. PRODUCTION_READY: BLOCKED. No merge, deployment, live
Gaming workflow, durable public-source storage, credentials/configuration,
plugin identity/OAuth, or production database operation was performed.

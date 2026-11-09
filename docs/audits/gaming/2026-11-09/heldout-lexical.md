# Held-out lexical and durable-authority acceptance

Historical local evidence for PR #1595, independently added after the original
15-question development benchmark. The review head was
`c6c05d799d276c35ca2f76588f209b45ba7c0fb1`; the original base was
`eea2d0b6ed72d00e3489a9f8ddf45335b3aa1e86`. The identical new fixtures ran at
both revisions, without editing either revision's production source. These
captures do not establish final CI, merge readiness, live search quality or
production readiness.

The [machine-readable receipt](heldout-lexical-results.json) separates the
supplied-candidate service selector from real PostgreSQL identity matching,
full-text query execution/ranking and subsequent stored-service selection. Both
paths run the actual deterministic request-coverage and CLEAR evidence gates.
Neither path generates an answer, performs semantic model auditing, fetches a
publisher or invokes a paid provider. Source assessments and private persistence
authorizations are authored synthetic test setup; they do not prove live source
acquisition or confer public storage permission.

## Corpus and method

The independent corpus has 17 authored passages and 22 questions: seven exact
questions, two complementary multi-source questions, four paraphrases, and nine
restriction controls. It uses two known game titles and the unfamiliar authored
title Signal Loom: Ember Reach. Labels and rationales were specified separately
from the implementation. No training/development benchmark question was reused.

Positive retrieval metrics include only the 13 exact, complementary and paraphrase
questions. Restriction controls have no eligible answer evidence and are reported
as authority/scope controls, not added to the recall denominator. Recall@3 is a
macro average over independently relevant passages; precision@3 always divides
by three, including unused slots. The service may return fewer passages. Topic
coverage and CLEAR evidence eligibility are separate from generated-answer
correctness.

The SQL suite reuses the existing repository and dedicated test-URL guard. Root
provisioned a new PostgreSQL **18.6** cluster bound to loopback port **52439**, with
the guard-required disposable database `arcanos_audit_pg18_20260727`. No old data,
credentials or configured application database were reused. The suite created a
unique `gaming_heldout_lexical_<uuid>` schema, applied the existing Gaming source
migration inside that schema, and persisted only authored records. Between
questions it truncated only its owned synthetic tables; teardown dropped the
schema and asserted its absence in `pg_namespace`. Root owns cluster teardown.

Each SQL case executes the real source-identity lookup and
`searchActiveGamingKnowledge` full-text search/ranking, then independently calls
`retrieveStoredGamingKnowledge`. Only the configured pool seam points those
production functions at the owned test schema. Held sources remain visible to raw
repository inspection. Durable grants use the existing private persistence
authorization; the revoked case then creates a real source-use authority hold
through `recordGamingSourceAuthorityHold`. No custom lexical scorer is substituted.

## Results at both revisions

| Gate or metric | Original base | Reviewed head |
| --- | --- | --- |
| New supplied-candidate service tests | 21 passed, zero failed/skipped | 21 passed, zero failed/skipped |
| New guarded PostgreSQL tests | 25 passed, zero failed/skipped | 25 passed, zero failed/skipped |
| SQL raw Recall@3 over 13 positives | 76.92% | 76.92% |
| SQL raw fixed-slot precision@3 | 30.77% | 30.77% |
| Service-selected Recall@3 | 76.92% | 76.92% |
| Service-selected fixed-slot precision@3 | 30.77% | 30.77% |
| Exact requested mechanics with accepted CLEAR evidence | 7/7 | 7/7 |
| Complete complementary requests | 2/2 | 2/2 |
| Paraphrases retrieving the intended passage | 1/4 | 1/4 |
| Paraphrases accepted by CLEAR | 0/4 | 0/4 |
| Restriction controls incorrectly approved | 0/9 | 0/9 |
| Selected original URL/revision/fetch-time preservation | 100% | 100% |

This independent corpus shows unchanged behavior, not another improvement over
the development benchmark. Three paraphrases retrieve nothing. The reactor
paraphrase retrieves the relevant passage through one shared system noun, but
the unchanged coverage gate withholds approval. Raw SQL also admits an unrelated
cooling-valve passage for an anchor-opening question because the bounded OR query
contains “open”; post-query selection excludes it. Similarity or a positive SQL
rank does not create claim support.

The nine controls cover foreign game, foreign edition, incompatible platform,
known old patch, stored-unverified retention, reference-only retention, a real
revocation hold, missing durable grant and malformed content-bound applicability.
Unverified, reference-only, revoked and missing-grant rows are still visible to
the raw repository query with reassessment required; service selection withholds
them. Old-patch text may remain readable but CLEAR rejects it. Malformed
applicability may remain readable but CLEAR requests clarification. Neither
becomes approved generation evidence. The fixture supplies no verified-patch
resolver, so it does not manufacture patch verification.

The spoiler case removes an unrelated ending paragraph while retaining the
requested Glass Key instructions. Two additional partial controls per runner
retain one useful passage while withholding complete coverage and CLEAR approval
when the complementary passage is absent. They are excluded from retrieval
metrics because full requested coverage is intentionally unavailable.

## Latency and resource observations

Per-question SQL and service timing remains in the raw receipt. Positive-case
observations from these short runs were:

| Observation | Original base | Reviewed head |
| --- | --- | --- |
| Identity lookup plus raw SQL search median / maximum | 3.04 / 5.85 ms | 3.34 / 5.63 ms |
| Stored-service lookup/selection median / maximum | 6.70 / 53.98 ms | 7.34 / 54.05 ms |
| Jest process heap used at report | 131,487,240 bytes | 82,664,856 bytes |
| Jest process maximum RSS | 314,216 KiB | 201,104 KiB |

These are observational samples from a small local corpus, include test-runner
and initial module/cache effects, and are not throughput, performance-regression
or memory-improvement claims. The database has no production-scale corpus or
concurrency load. Quality outcomes and authority assertions are permanent;
timings have no unstable acceptance threshold.

## Reproduction and authority

Run with Node 24.18.1 / npm 11.16.0 and current shared-package builds. The SQL suite
requires a separately authorized disposable loopback PostgreSQL 18 target through
`JOB_CLAIM_FENCING_TEST_DATABASE_URL`; set
`ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1` to prohibit silent database skips. Keep
credential values in the process environment and out of commands, logs and docs.

```powershell
node scripts/run-jest.mjs --runTestsByPath tests/gaming-heldout-lexical.test.ts tests/integration/gaming-heldout-lexical.pg18.integration.test.ts --coverage=false --runInBand --silent=false --verbose
```

The corpus is in
[gamingHeldoutLexicalFixtures.ts](../../../../tests/testUtils/gamingHeldoutLexicalFixtures.ts).
The raw receipt records exact fixture hashes and separate execution revisions;
`studyHead` identifies the reviewed feature head, not the baseline execution.
Local tests and these scoped disposable SQL operations were authorized and
executed. A larger held-out semantic/lexical comparison remains proposed follow-up
work; no embeddings, new model, vector infrastructure, deployment or production
change occurred here. Canonical authority remains
[Gaming guide assistance](../../../GAMING_GUIDE_ASSISTANCE.md),
[discovery recovery](../../../GAMING_DISCOVERY_RECOVERY.md), and
[database migrations](../../../DATABASE_MIGRATIONS.md). Preserve these captures;
add identified follow-up evidence rather than rewriting them as final acceptance.

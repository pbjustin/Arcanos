# Post-merge integration of PR #1543

PR #1542 merged into `main` as
`f34da2cc1565bd2105af4254cf41b0a9634afe9e`, with the reviewed parent
`e24d5614748f39e25e27a0c062dfba2ea0adbb77` and identical tree
`90aef1606605e7445b9958325458029364d33576`.

PR #1543's reviewed head before integration was
`741b00a8236f66c02beec700f68a9e1aa42e95b7`. The merge base with current
main is the reviewed #1542 head. The isolated integration merged main with an
ordinary non-fast-forward merge and no conflicts, cherry-picks or duplicate
changes. Its effective capability diff starts after that reviewed head. This
record supplements the historical [original receipt](validation.json) and
[independent review receipt](independent-validation.json); their captured
states and hashes remain unchanged.

The universal identity implementation and all six independent-review repairs
remain in the resulting code. The added regression cases remain: 33 identity,
11 acquired CLEAR/storage, six performance boundaries, 14 workflow, five
historical stored-assessment controls, and one queued policy-version control.
The merge from main did not change runtime source or tests. Post-merge
adversarial review found three additional identity-authority gaps; the surgical
repairs and new regression cases are recorded below. Public `gaming-clear/v1`
and hybrid-v2 contracts remain unchanged. Internal `gaming-clear-policy/v4`
still rejects obsolete v1-v3 decisions.

## Post-merge blocker review

- **P1, generic refresh:** A current or obsolete approved source could be
  refreshed through the generic queue without its CLEAR assessment. The new
  revision had no explicit obsolete assessment and could reuse independently
  stored applicability to regain generation authority. The repair carries a
  server-owned reassessment restriction into the queue, revision identity and
  provenance. Workers recheck old queued refreshes before writing. The source
  stays readable, but a fresh v4 approval is required for generation again.
- **P1, unapproved durable ingestion:** The generic intake could derive a
  requested game's complete applicability from the request and matching
  title/URL, even when acquired prose explicitly identified a different game
  or never proved any game. The repair assesses independently acquired source
  identity before persisted applicability can be complete. Definitive new
  wrong-game submissions are rejected, uncertainty remains unverified, and a
  changed refresh supersedes an older approved revision without restoring its
  authority. Independently proven unfamiliar game prose can pass a misleading
  topic title without a production registry entry.
- **P1, untouched historical records:** Correcting future ingestion alone
  would leave older unapproved revisions with a complete requested-game
  applicability snapshot eligible for generation before their next refresh.
  The stored-knowledge reader now requires current server-written independent
  identity proof or a bound current CLEAR assessment before that snapshot can
  authorize generation. Earlier text and restrictions remain readable; a
  normal reassessment is required. No database backfill or automatic write is
  performed.

All three defects were reproduced with deterministic acquired documents and the
real resolver, queued ingestion, stored retrieval and CLEAR evidence decision.
The original main merge itself was conflict-free; these are defects in the
incremental #1543 implementation exposed by the post-merge adversarial review.

The direct-ingestion probe first had three failed intended-behavior assertions
and one positive control. The untouched-record probe then showed two more
wrong/anonymous historical acceptances before the read-time repair. After all
three repairs, the six independent positive and negative end-to-end probe
scenarios pass; the source-ingestion, stored-knowledge, CLEAR, and resolved
source focused set passes 197 tests. Historical source projections are changed
only in memory during reads, and the regression checks assert no database
write. The [new receipt](post-merge-validation.json) fingerprints the repaired
source, tests and current documentation separately from the immutable prior
receipts.

## Local validation at merged main

Validation uses exact Node 24.18.1 with npm 11.16.0 and the isolated checkout.
The deterministic fixtures exercise real hybrid-v2 orchestration with synthetic
external transports and provider responses. They are not live acceptance.

| Check | Result |
| --- | --- |
| Type-check | PASS |
| Lint | PASS; zero errors, 77 repository warnings |
| Build and preview semantic pins | PASS |
| All Gaming suites | PASS; 5,240 passed, nine local PostgreSQL skips, 165 suites |
| Native preview boundary | PASS; 410 passed |
| Static Railway validation | PASS |
| Documentation, local links and indexes | PASS; 719 local link targets |
| Commit guard and sync drift check | PASS |
| Hosted full CI and PostgreSQL 18 at final pushed SHA | PENDING |

Exact local commands run from the repository root with Node 24.18.1 and npm
11.16.0:

```text
npm run type-check
npm run lint
npm run build
npm run validate:railway
npm run docs:check
npm run docs:links -- --local-only
npm run reindex:check
git diff --check
$gamingFiles = @(rg --files tests | Where-Object { $_ -match 'gaming.*\.test\.[jt]s$' })
node scripts/run-jest.mjs --runTestsByPath $gamingFiles --coverage=false --maxWorkers=2 --json --outputFile=local_artifacts/integration-preparation/integrated-gaming.json
node scripts/run-jest.mjs --runTestsByPath tests/native-pr-preview-import-boundary.test.js --coverage=false --runInBand --json --outputFile=local_artifacts/integration-preparation/integrated-preview-boundary.json
node scripts/run-jest.mjs --runTestsByPath tests/gaming-universal-performance.test.ts tests/gaming-independent-performance-review.test.ts tests/gaming-execution-budget.test.ts tests/gaming-hybrid-edition-budget.test.ts tests/gaming-trinity-generation-budget.test.ts --coverage=false --runInBand
node scripts/check-native-pr-preview-imports.mjs
npm run guard:commit
npm run sync:check
```

The broad Gaming suite includes the existing Elden Ring and Fallout 76
acceptance paths, unregistered titles and generic topics, source integrity,
CLEAR v4, stored knowledge, hybrid-v2 orchestration, Trinity evidence and
workflow budgets. The performance checks cover the 14 current identity cases,
long documents and operational clamps; they exclude acquisition, SQL and
provider latency, so they are not end-to-end speed evidence. Local PostgreSQL
tests are guarded when Docker is unavailable; hosted PostgreSQL 18 is the SQL
gate. The PR description links terminal hosted run evidence tied to the pushed
merge commit. Older receipts remain historical evidence for their earlier heads.

No live Gaming workflow, durable guide storage, production database operation,
Railway deployment or configuration change is part of this integration.

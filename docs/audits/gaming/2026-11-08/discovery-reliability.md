# Gaming discovery intelligence and reliability

Implementation baseline: freshly fetched main
`eea2d0b6ed72d00e3489a9f8ddf45335b3aa1e86`. The shared checkout and all existing
worktrees were preserved. This change uses an isolated feature worktree, Node
24.18.1 and npm 11.16.0. No live publisher/search requests, paid models, database
operations, Railway changes, deployments or merges are part of this evidence.

## Baseline and reproduced deficiencies

Merged PRs [#1591](https://github.com/pbjustin/Arcanos/pull/1591),
[#1592](https://github.com/pbjustin/Arcanos/pull/1592),
[#1593](https://github.com/pbjustin/Arcanos/pull/1593) and
[#1594](https://github.com/pbjustin/Arcanos/pull/1594) were inspected against current
source. Their PR descriptions contain historical intermediate states; GitHub's
merged state and the fetched tree establish this baseline.

Already implemented: sanitized failed-URL exclusions in normal live discovery,
protected redirects and transport deadlines, class-based publisher extraction,
independent article scopes, metadata/navigation isolation, short factual prose,
source-global applicability and source-use restrictions, bounded v2 recovery,
retention/reselection of complementary accepted artifacts, full-pool conflicts,
final citation checks, and durable unverified/reference/revoked-authority fences.
Those paths were retained. HTTP 403/404, publisher timeouts and prohibited
redirects are external access limitations, not evidence that a guide is absent
and not grounds to bypass acquisition policy.

| Reproduction | Before | Focused correction |
| --- | --- | --- |
| Generic official/wiki landing or category versus specific guide | Generic page outranked concrete gameplay hints | Stronger index penalty and penalty for zero topic overlap; public community/wiki articles remain eligible |
| Dragon Quest 3 versus Dragon Quest 11 | Different numbered title passed loose lexical overlap | Negative explicit installment check; existing Roman numeral normalization reused |
| Long exact edition/platform/version scope | Per-field or final query truncation silently lost constraints | Indivisible sanitized scope; withhold a query that cannot fit 180 characters |
| Same query with newly permitted recovery | Cached exhausted results hid replacement hints | Explicit internal search-cache refresh only for an already granted backend recovery |
| Explicit wiki property table using row headers | Useful stat tuple rejected as ambiguous | Support exact nonspanning row-header/value pairs inside one row group |
| Explicit base-game request with shorter DLC prose and valid base prose | DLC displaced valid evidence; later CLEAR vetoed answer | Reuse edition compatibility before evidence subset selection |

The initial permanent discovery ranking reproductions failed **3 cases** while
101 existing cases passed. Recovery-cache and scope regressions were separately
observed failing before repair. The finalized discovery suite has **117 cases**,
including 16 additions. The finalized property-table fixture at the exact base
passed **14 and failed 9**; repaired code passes **23/23**. The lexical fixture
passed **9 and failed 4** with original selection behavior; repaired code passes
**13/13**. Failures were preserved as regression assertions, not disabled.

## Implementation and compatibility

The existing provider interface gains an internal opt-in two-query plan sharing
one existing deadline and total result ceiling. Normal single-query callers keep
their behavior. Host query planning shares the targeted variations. Search
metadata remains untrusted and cannot verify a fact, game, platform or edition.

One necessary operator option,
`ARCANOS_GAMING_HYBRID_BACKEND_DISCOVERY_ENABLED=false`, controls backend-assisted
discovery. The existing discovery flag/provider must also be configured. A new
v2 query first checks stored knowledge; only a granted gameplay search may run.
The adapter reserves the workflow operation while searching, then submits URL
hints through the existing candidate method with the same actor, workflow,
expected revision and stable idempotency key. It may use the single existing
recovery grant. Identical/rebudgeted query retries cannot restart search.

The unchanged limits remain two gameplay submissions, at most three URLs in each,
six distinct submitted URLs, 12 seconds per acquisition batch and 24 seconds
cumulative acquisition. Search remains separately bounded by the existing
discovery timeout. Submitted URLs and sanitized protected-hop destinations are
negative exclusions only; they grant no identity or authority. Search failures
leave host discovery available with the actual controlled failure reason.

V1, explicit supplied-guide questions, official-currentness discovery, OAuth/MCP
schemas and source-storage consent retain their existing behavior. No response
schema, protocol version, dependency, SQL, migration or production config changes.
Row-header extraction changes content interpretation, so resolver revision v8
invalidates old derived content identities; **CLEAR policy remains v7**. Two
reviewed native-preview semantic pins are updated; their permitted import graph
and success-marker/failure behavior remain unchanged.

## Coverage and answer presentation

Existing v2 selection already searches the complete bounded accepted pool for
relevant sections, combines independent complementary sources and retains
accepted evidence during recovery. The full-pool conflict veto precedes subset
selection. This change does not replace those working policies. Source and
revision identities, original public citations, spoiler context, platform,
edition and patch qualifications remain bound through generation and final audit.

The authenticated HTTP fixture exercises real MCP admission, provider adapter,
protected acquisition/DNS admission, extraction, identity/applicability, source
selection, CLEAR, four generation/audit stages and final citations. Search,
publisher transport and SDK outputs are deterministic substitutes; retrieval
starts from an explicitly empty stored context. Added positive cases cover Zelda,
Elite Dangerous and an unfamiliar authored game. A redirect-to-403 case proves
the failed destination is acquired once, excluded, and replaced by a different
publisher within the same workflow.

Incomplete gameplay requirements still withhold a finished answer and identify
the remaining coverage. Existing qualified currentness/advisory behavior is
retained where policy permits it; no new permission to answer unsupported facts
is introduced. Inaccessibility is reported separately from missing evidence.
Existing regression suites cover contradictory sources, partial complementary
support, exhausted recovery, invalid citations and qualifications, spoilers,
patch restrictions, source-use restrictions and durable authority changes.

## Benchmark and Phase 3

The [15-case lexical benchmark](gaming-lexical-benchmark.md) and its
[raw results](gaming-lexical-benchmark.json) measure the production pure
post-query selector, formatter, coverage assessment and deterministic CLEAR gate.
Recall@3 improves **80.00% to 86.67%**, fixed-slot precision@3 **31.11% to 33.33%**,
and CLEAR evidence acceptance **11/15 to 12/15**. Exact mechanics remain **8/8**;
paraphrase retrieval remains **2/4**. False authority acceptance remains zero.
Timing and memory observations do not establish a speedup.

This is a bounded candidate-selection benchmark, not actual PostgreSQL ranking
or generated-answer quality. The separate Phase 3 proposal requires a larger
held-out corpus, actual disposable PostgreSQL retrieval, bounded lexical
expansion versus an optional offline semantic seam, final answer evaluation and
latency/cost measurements before choosing embeddings. No semantic service or
model dependency is added here.

## Validation and remaining limits

Final validation results are recorded with the PR. Local commands include:

```powershell
npm run type-check
npm run lint
npm run build
node scripts/run-jest.mjs --runTestsByPath tests/gaming-backend-discovery.test.ts tests/gaming-intelligent-search-http.integration.test.ts tests/gaming-search-discovery.test.ts tests/gaming-row-header-extraction.test.ts tests/gaming-lexical-retrieval-benchmark.test.ts --coverage=false --runInBand
node scripts/run-jest.mjs --runTestsByPath tests/native-pr-preview-import-boundary.test.js --coverage=false --runInBand
npm run docs:check
npm run docs:links -- --local-only
```

The complete root Gaming suite group is also run with explicit file paths.
Required CI must independently validate the published head. Local synthetic
success does not establish live provider quality or production readiness.

Unchanged limitations include publisher access controls, unsupported rendering,
complex mixed/spanning property tables, bounded acquired-scope inspection,
unknown synonym recall, and no general proof that every online game guide can
be accepted. No live PostgreSQL suite is claimed: SQL/storage/authority schemas
were not changed and no exact disposable database target was configured for
this task. Actual SQL benchmarking and live search/provider acceptance remain
separate follow-ups, not synthetic evidence relabeled as production proof.

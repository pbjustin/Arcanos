# Authenticated procedural guide regressions

**Final local frozen-source receipt:** application, authority and final distinct
PostgreSQL cases pass on the recorded uncommitted source snapshot. The initial
PostgreSQL HTTP harness timeout and unchanged successful isolated rerun are
preserved below. This is not a live-provider or deployment acceptance claim.

The starting PR #1597 head is `ab8380e70116a50a0bfb524820cb97abdec3ccf4`;
the original base remains `2df6e6a0fb409aaa42e1b5f687ea2622c8dde560`.
The [sanitized stage receipt](delivery-regressions.json) binds the fixture and
runtime source hashes. The final build-source digest is
`36c15f4a83ab27f1971213187a4bf083cf41c80885b6db495c4dfb6b06c821c2`. The exact starting-head checkout kept its production
source diff empty while running the same final regression file.

## What the application actually exercised

The existing delivery suite runs actual RSA/JWK OAuth verification, MCP
validation/execution, the hybrid-v2 query/search-grant/submission workflow,
protected-reader boundaries, extraction, independent game identity, source
CLEAR, stored/hybrid selection, question coverage, Trinity orchestration and
final answer/citation binding. Search, DNS, publisher responses and SDK/model
outputs are explicitly authored substitutes. Durable writes are forbidden.

The synthetic semantic judge checks source-bound claims. It is deliberately not
a live model or an independent semantic oracle for whether a non-procedural
fact answers a starting question. The baseline therefore proves incorrect
deterministic coverage admission and exercised downstream plumbing; it does not
prove that a real model or publisher approved a bad answer.

| Case group | Exact starting head | Repaired application snapshot |
| --- | --- | --- |
| Three non-procedural continuations after a starting frame | Independently acquired identity and source CLEAR pass; coverage incorrectly true; all four synthetic model stages run; answer present | Sources remain accepted; starting coverage false; no model dispatch or answer |
| Explicit start-target-by and colon-imperative forms | Sources accepted but no passages selected; no Trinity | Source-bound answers reach all Trinity stages and final audit |
| First three acquired actions | Source accepted and passage selected, but request coverage fails | Three preserved acquired steps reach the audited answer |
| Materials and same-sentence acquisition anaphora | Source accepted; material-location coverage missing | Both supported facts reach the source-bound audited answer |
| Unrelated locations, other-material locations, missing one material location | All three withhold generation | All three continue to withhold generation |
| Wrong game and explicit wrong edition | Both reject before model work | Both continue to reject before model work |

The exact final regression file changes from **17 passed / seven failed** on
starting-head source to **24 passed / zero failed** on the final recorded repair.
The original five game scenarios remain intact: five deterministic delivered
answers, with seven of seven expected citations bound to accepted evidence.
Unsupported generated quantities and wrong-source citations remain withheld by
the existing final audit plumbing using the synthetic semantic judge.

Independent review exposed an intermediate regression: an unquoted book name
containing an action count was interpreted as a demand for that many procedural
actions. Its actual authenticated source path accepted the book's location but
selected no evidence. The permanent acquisition-object control passed at the
starting head, failed on that intermediate implementation, and passes after the
bounded named-object correction. It is separate from the seven starting-head
failures above.

The first-three-action fixture also isolated an existing projection boundary.
The complete acquired text and candidate record retained the whole authored
procedure, while scoped projection omitted its final Choose/Register sentence.
The correction retains a directly scoped counted starting sequence within the
existing four-successor bound. Original evidence text and citation identity
remain authoritative; the extractor and acquisition budgets do not change.

## Authority and live evidence boundaries

A separate **22-test** existing workflow suite passes for hybrid-v1/v2 authority
holds, changed epochs, unavailable authority and cached/equivalent-query reuse.
It uses mocked durable authority snapshots and a synthetic generation response;
it is separate from the [real PostgreSQL receipt](postgresql-regressions.json).

The final guarded database result covers seven suites and 167 distinct tests,
all passing on their latest execution, with zero skips or open handles. The
existing nine SQL authority restriction controls accept zero false authorities.
Actual compiled MCP/OAuth, SQL queue/worker, fresh-process authority and
SDK/Trinity transport run against synthetic loopback publisher/search/model
endpoints. The exact source hashes and execution HEAD remain unchanged across
all database executions.

The first combined database attempt had 166 passes and one failure: the compiled
HTTP parent's 90-second timeout expired while waiting for its fresh-reader
child, after the grounded response and answer audit had passed at 61.2 seconds.
The fixture intentionally waits about 60 seconds for its existing owner rate
window. The 240-suite Gaming run was active concurrently. No assertion failure
or leaked fixture process/database session was observed. After those workers
finished, only the failed HTTP suite was rerun without code, fixture or timeout
changes; both cases passed in 65.155 seconds. Resource contention is consistent
with the observations, but its exact contribution is not conclusively proved.
The initial failure remains recorded rather than being rewritten as success.

The new owned PostgreSQL 18.6 cluster used loopback port 56509 and the guarded
disposable database. Zero Gaming schemas remained after validation. Exact data
directory ownership was verified before stopping only that server. Earlier
stopped cluster artifacts and the new ignored artifacts are preserved. No
configured application database was used.

## Reproduce the guarded database checks

Run from the repository root with Node 24.18.1/npm 11.16.0, installed development
dependencies and a fresh successful `npm run build`. Configure the dedicated
`JOB_CLAIM_FENCING_TEST_DATABASE_URL` and `ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE`
prerequisites for a newly owned disposable PostgreSQL 18 target accepted by
[the repository guard](../../../../../tests/integration/postgresTestDatabase.ts).
The suites create and remove their own test schemas. This receipt intentionally
includes environment variable names only.

The exact seven-suite invocation was:

```powershell
node scripts/run-jest.mjs --runTestsByPath tests/integration/gaming-durable-rag.pg18.integration.test.ts tests/integration/gaming-authority-read.pg18.integration.test.ts tests/integration/gaming-cr2-source-hold.pg18.integration.test.ts tests/integration/gaming-hybrid-authority-revocation.pg18.integration.test.ts tests/integration/gaming-heldout-lexical.pg18.integration.test.ts tests/integration/gaming-historical-status.pg18.integration.test.ts tests/integration/gaming-authority-http.pg18.integration.test.ts --coverage=false --runInBand --detectOpenHandles --json --outputFile=tmp/pr1597-adversarial-pg-20261110/final-seven-results.json
```

After inspecting the timeout and verifying no owned fixture processes, sessions
or schemas remained, the unchanged failed suite was rerun alone:

```powershell
node scripts/run-jest.mjs --runTestsByPath tests/integration/gaming-authority-http.pg18.integration.test.ts --coverage=false --runInBand --detectOpenHandles --json --outputFile=tmp/pr1597-adversarial-pg-20261110/http-isolated-results.json
```

The real retained [Frontier source diagnosis](../../2026-11-09/guide-answer/frontier-diagnosis.md)
is separate evidence. These new publisher documents are authored fixtures and
must not be represented as Frontier quotations or current-patch gameplay proof.
No source ingestion, production request, paid model call or configuration change
is performed by this regression suite. Real repaired-head provider acceptance
remains **BLOCKED** without an authorized non-production target and its Gaming
OAuth/provider configuration. Qualified partial delivery remains a separate
contract follow-up; mandatory factual coverage is not bypassed.

The starting-head review snapshot was read without waiting for CI. Its required
checks had terminal success; the exact-head CodeRabbit check was skipped. One
historical review thread was resolved, with all thread/comment pages exhausted;
three review submissions were COMMENTED. Those states do not approve the later
repair. No new review request, merge or deployment was triggered.

# PR #1592 exact-head CI investigation

This follow-up starts at `088650db60db17e3bdd75a07b4cd8fc8b4949035`, verified
against the remote PR before editing. The original base is
`52d859c2ae15c3cc15befbc7d6cc7538f20753b5`. This record explains the repairs;
the separately exported commit-bound receipts own final acceptance and CI status.
It is not merge, deployment, production, or live-provider authorization.

## Actual failing evidence

The CI/CD job `128544954131` in run `42419439762` reports 24,124 passed and
three failed assertions. PR CI job `128544474764` in run `42419439864` reports
24,120 passed and seven failures. Both use one Jest worker with V8 coverage.
The CI/CD checkout is a synthetic test merge with the same complete tree as
the intended head. Its preserved counter artifact proves that equality.

The failures comprise late structured-row and full-artifact lifecycle timeouts,
a current-index `failed` versus `stored` result, large HTML and bounded-truncation
timeouts, an acquired-scope `STORAGE_FAILED`, and two missing-currentness-proof
timeouts. Actual logs and a machine-readable transcription of their assertion
summaries are preserved separately. The historical workflows did not retain
assertion-level Jest JSON: one retained counters only, the other no Jest artifact.
The transcription is explicitly not represented as original Jest output.

## Causal findings and corrections

1. The new pure source-use observer parsed the same accepted HTML independently
   for metadata and embedded candidates. CPU profiles show parse5 dominating the
   large-document cases, with the observer adding repeated linear work. It now
   shares one local, read-only DOM between those readers. Neither the DOM nor a
   permission result is cached. Supported fields, raw-body limits, instruction
   rejection, source-use latches and downstream authority checks remain intact.
   A deterministic parse-count regression fails before this repair and passes
   afterward, including a restriction beyond the ordinary preview.
2. Timed-out scenarios continued after Jest advanced to the next test. The suites'
   shared database/HTTP pointers were reset while the old coroutine still ran.
   Controlled HTTP barriers reproduce the exact canonical-hash collision and
   `STORAGE_FAILED`/failed-current-index signatures. The same sources succeed in
   fresh fixtures. A test-only tracker now registers the entire scenario promise
   before execution and drains it before reset or mock restoration. It returns
   the original promise and preserves rejection. Permanent barrier regressions
   cover post-worker continuations, current-index storage and non-authoritative
   acquired-scope retention. No application queue or transaction policy changes.
3. A separate large-input defect copied and split the whole preceding document
   at every acquired game scope. At 512 and 1,024 scopes, measured string work
   grows from 15.5 million to 61.9 million code units. A backward scan now reads
   only the two complete tokens needed by the unchanged suffix decision regex,
   preserving arbitrary whitespace, negation, conditionals and clause boundaries.
   Deterministic work-count and exact-output controls cover the correction.
   Actual failing CI fixture bodies do not repeat those named scopes; this is a
   separate confirmed performance repair, not the claimed cause of those timeouts.
4. The final three currentness-negative cases used Jest's default five seconds
   despite executing the same cumulative full-guide proof chain as the earlier
   thirty-second cases. The file and these boundaries already exist on the base.
   Focused current/base executions pass. Covered current cases take up to 2.5
   seconds locally; profiling attributes only 41 ms across both cases to the
   currentness fixture itself. The chain's acquired bodies, element counts,
   structured records and chunk counts remain independently bounded. These three
   tests now use the existing thirty-second whole-guide budget and drain their
   scenarios. This changes neither a production deadline nor an assertion.
5. Both workflows now preserve full assertion JSON even on failure, alongside
   the existing checkout-bound counters. PR CI requests Jest JSON explicitly.
   Regression checks require the result path and unconditional artifact retention.

## Security and attribution boundaries

The SQL errors above use in-memory SQL boundaries, so real PostgreSQL pool
contention is not their cause. Real PostgreSQL transactions, row-lock races,
rollback, restriction epochs and fresh-process selection require the separate
guarded PostgreSQL acceptance. Passing those mock-boundary tests is not SQL proof.

No authority verdict is cached by these repairs. Retention does not authorize
generation. Existing server-owned current assessments, content-bound approvals,
owner checks, source-use holds, historical revision fencing, exact citations,
retrieval pagination/deadlines, CLEAR v7 and read-only v6 compatibility remain
subject to independent regression and current compiled HTTP/MCP acceptance.

Original assertion calls and the long lifecycle bodies are compared against the
starting head. Historical captures are preserved. Native Windows baseline claims
require the same commands and assertion/failure signatures on both trees; Linux
or equal aggregate counts cannot replace that check. Current-head CI may remain
pending at user-requested closeout and must not be reported as passing.

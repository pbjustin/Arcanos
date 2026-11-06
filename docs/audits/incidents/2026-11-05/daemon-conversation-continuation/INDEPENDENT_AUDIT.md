# Independent continuation audit

This is a dated local evidence record for draft PR #1589, supplementing the
[original investigation](README.md) and [automatic recovery acceptance](AUTOMATIC_RECOVERY.md).
The independent audit began at `2f7e7cfb128ce5bc933e05ec4042a7842a3489ec`, against
base `f72a504333bcc7c1a8cf360f03b6638a5788cbb6`. Repairs and test results below
describe the local working changes; they do not establish deployment or
production acceptance. The [Python daemon guide](../../../../../daemon-python/README.md#async-backend-client-flow)
remains the canonical behavior owner. The final remote revision and CI status are
recorded in the PR audit comment; this document cannot embed its own commit hash.

## A — Clear-history privacy

**Confirmed; locally repaired and tested.** Current-source inspection covered
the complete PR changes to `history_db.py` and `schema.py`, their history tests,
the unchanged clear/history callers, and maintained retention/audit guidance.
`ui_ops.handle_clear` promises to clear stored conversation history. Legacy
`Memory.clear_conversations` removes JSON turns, but the new SQLite path only
changed `history_visible`, leaving displayed question and answer text readable.

The reproduction used actual `Memory`, SQLite and synthetic text in a temporary
profile. It completed a turn, acknowledged display, cleared history, then queried
`conversation_deliveries` directly. No production database or provider was used.

| Observation | Before repair | After repair |
| --- | --- | --- |
| Visible history / legacy JSON turns after clear | 0 / 0 | 0 / 0 |
| Original question / answer readable through SQL | Yes / yes | No / no |
| Recovery receipt retained | 1 | 1 |
| Lifetime request total, including one legacy turn | 2 | 2 |
| Durable completion policy event retained | 1 | 1 |

The repair blanks the cleared displayed row's question, answer and session fields
and reduces its logical payload size. Delivery identity, timestamps, usage and
acknowledgement flags remain as replay receipts. The existing policy event and
its audit metadata remain. A clear before display hides the turn immediately but
retains its approved payload until display acknowledgement, preserving interrupted
delivery. That acknowledgement then scrubs the hidden payload. Opening the history
database also scrubs older hidden displayed rows from the previous hide-only behavior.

The migration is a guarded update of the existing bounded receipt table, with no
new table, scheduler or result store. It does not match undisplayed rows. Existing
limits remain 2,048 receipts and 64 MiB of logical payload; displayed receipts can
be pruned after eight days and lifetime totals survive pruning.

Clearing between display acknowledgement and the console audit claim must not
change a successful completion into a failed audit. Result reads now expose
`output_accepted` from the existing `conversation.completed` or
`conversation.withheld` policy event, independently of the deleted prose. A
missing legacy event can use retained approved text; after deletion it cannot
invent acceptance. The controller uses that outcome when claiming its console audit.

| Executed check | Result |
| --- | --- |
| New privacy regressions before repair | **8 failed**, reproducing the defect. |
| Final focused history suite | **33 passed**, including both audit states, deferred display deletion, legacy reopen, missing legacy event and scrub-transaction rollback. |
| Affected history, schema, UTF-8, memory, manual and automatic continuation suites | **108 passed**; two additional legacy-event history checks subsequently passed in the 33-test focused run. |

Local logs are `tmp/history-clear-content-before.log`,
`tmp/history-clear-content-after.log` and `tmp/history-clear-affected.log`.
The direct post-repair SQL probe also retained `output_accepted: true` with
`audit_emitted: false`, proving that content deletion does not erase completion evidence.

This is logical deletion from the active conversation table. It does not promise
physical erasure from SQLite pages, WAL files, independent backups, prior terminal
output, or separate audit records. Clear does not cancel backend jobs or erase
their separately governed retained results.

## JSON backup boundary

`Memory.export_backup` still exports legacy JSON state only. An actual synthetic
probe observed one recovered conversation and one request through normal getters,
but zero conversations and zero requests in the exported JSON. No daemon CLI
caller of this helper was found. Root retained this as an explicit compatibility
limitation rather than expanding the repair into a backup subsystem. This JSON
export must not be described as a complete SQLite history or recovery backup.
Pending bearer capabilities remain excluded from it.

## B — Foreground delivery ownership

**Confirmed and repaired.** Two actual `python -m arcanos.cli` processes ran in
native Windows ConPTY under the same Windows account, data directory and backend,
with different conversation identities. The observer became global monitor leader;
the other console submitted the ordinary question. Before repair the observer
made both result GETs and displayed the question/answer. The submitting terminal
made no result GET and received no answer. One generation POST, one synthetic
provider invocation and one durable SQL completion were observed. This was a
delivery-isolation defect, not a server authorization bypass.

The existing coordination file now holds eight native per-job owner claims,
acquired before publishing the encrypted accepted record. Each foreground reads
its own jobs even when it is not the orphan-adoption leader. The existing global
leader only adopts work without a live owner. Native process death releases claims;
stored session IDs remain correlation data, never ownership or authentication.
The existing result-read claim still serializes each job's retrieval and delivery.
No IPC, service, second repository or persisted PID was added.

Five native HTTP regressions passed: distinct-session live ownership, the default
shared-session control, clean originating-process exit, forced process death, and
fresh-process restart. Each used one generation POST and one synthetic provider
invocation, one saved turn and one durable completion. A live observer performed
zero result GETs for the other console's job. After owner exit or death, takeover
delivered the retained answer once. Pending reads may precede the one final read;
the guarantee is no competing owner or duplicate completed retrieval/delivery.

Two additional reproduced lifecycle defects were repaired:

- A failure while hydrating SQLite usage during controller construction left
  newly restored manual-cache entries and native owner handles after the CLI
  discarded that controller. Two regressions failed before cleanup and pass after;
  failed construction removes only its newly restored cache entries and releases
  its native claims, preserving encrypted work and the primary error.
- A protected commit followed by an unlock error and temporary snapshot-read
  failure made `contains()` miss already protected work. Manual fallback saved a
  legacy turn, then automatic recovery saved another SQL turn and success event.
  The failing-before reproduction observed those duplicates from one original
  generation. The controller now recognizes its existing native owner claim and
  keeps manual reads on the protected idempotent path. It fails closed during the
  outage and later completes once.

The combined storage/controller suite passed 63 tests. Before logs are
`tmp/ownership-before.log`, `tmp/ownership-startup-before.log` and
`tmp/ownership-read-failure-before.log`; after logs are `tmp/ownership-after.log`
and `tmp/ownership-python-final.log`.

## C — Optional terminal editor failure

**Confirmed and repaired.** Six injected setup failures previously escaped editor
entry and terminated ordinary interaction: missing optional package, console
acquisition, application session, completer, prompt session and stdout proxy.
Setup now unwinds its scoped resources, reports a fixed message and retains
ordinary builtin input. Automatic output starts only for an explicitly redraw-safe
reader; builtin fallback keeps manual recovery without concurrent terminal writes.
Three actual ConPTY HTTP-200 fallback cases passed with one POST each, no result
GETs, polling, action, speech or credential disclosure.

A separate permanent active-reader failure reproduced repeated error reads.
It now prints a fixed restart notice and exits through normal controller/editor/
daemon cleanup. It never switches readers after partial input. Command-processing
errors retain their existing ability to accept the next question. The focused
terminal/runner/guard matrix passed 97 tests. Before/after logs are
`tmp/audit-terminal-active-before.log` and `tmp/audit-terminal-active-after.log`.

## D — Concurrent hourly admission

**Confirmed and repaired.** With `MAX_REQUESTS_PER_HOUR=1`, sequential pending
questions and overlapping admission while the first POST was paused both sent
two generation requests and invoked the synthetic provider twice. Both focused
regressions failed before repair (`tmp/audit-quota-before.log`). No answer had
completed, so completion-only charging never occupied hourly capacity.

The existing limiter now reserves an hourly admission under its reentrant lock
before dispatch. A valid accepted job transfers that reservation to its existing
backend/job delivery digest; protected restoration rehydrates its original-hour
admission. Completion consumes it once, separately from authoritative token/cost
charging and completed history. Known pre-dispatch rejection refunds capacity;
uncertain or failed dispatched attempts retain their hourly admission. Reservation
bookkeeping expires with the hourly window. No second durable quota store or new
cross-process quota policy was introduced.

Independent review reproduced a partial-commit double-count: protected storage
committed then reported an unlock error, leaving the old admission key while
recovery used the delivery digest. One original request became two hourly charges.
Its regression failed before the additional repair (`tmp/quota-post-commit-before.log`).
The accepted reservation now uses the canonical delivery key before attempting
protected persistence, including process-private manual fallback on storage failure.
The affected quota/manual/automatic/concurrency/rollover matrix passed 89 tests
(`tmp/audit-quota-final.log`), including this crash boundary.

The native `quota_pending` case entered two questions in the actual CLI while the
first provider was held. It observed one POST/provider invocation; both pending
snapshots had hourly requests 1, tokens/cost 0 and history 0. The original answer
then appeared automatically, with one SQL turn and one completion audit. Evidence:
`tmp/automatic-continuation/quota_pending-counters.json` and
`tmp/automatic-continuation/process-owner-quota-receipt.json`.

## E — Accepted work during a backend status-read outage

**Confirmed and repaired.** The backend accepted work durably and invoked priority
execution once, then its foreground status read failed. The old HTTP 503 carried
valid coordinates with `ok:false`; the daemon classified it as an HTTP failure
and discarded the continuation. Two regressions failed before repair.

The catch after accepted work now returns the existing HTTP 202 pending projection,
without claiming completion or creating another job. Creation and signing failures
before acceptance still return HTTP 503 without job coordinates. OpenAPI examples
and API documentation match those states. Backend acceptance/result/security tests
passed 219 cases; dispatch/OpenAPI checks passed 71. The native
`wait_storage_outage` HTTP case observed one injected storage failure, one POST202,
one provider invocation, two capability-bound original-job GETs, automatic original
answer/history once, and no manual resume or leaks. See
`tmp/automatic-continuation/wait_storage_outage-proof.json`.

## Other classifications

| Question | Classification and evidence |
| --- | --- |
| Typed expired or denied/missing result incorrectly retried | **Not reproduced.** The actual `/jobs/:id/result` contract returns HTTP 200 with typed `expired` or `not_found`, which become terminal nonanswers. Its separate status route's 404 is not the recovery route. |
| Duplicate generation or provider calls during recovery | **Not reproduced.** Actual HTTP counters exercise the original generation and capability-bound result GETs; no recovery generation, fallback or credential refresh is allowed. |
| Completion without retained output | **Accepted limitation, truthfully reported.** A completed row without persisted output returns unavailable; recovery cannot reconstruct lost prose without prohibited new inference. |
| Global quota across arbitrary simultaneous CLI processes | **Accepted limitation.** The established limiter is process-local. Pending records and completed recovery usage are restored; this change does not claim distributed atomic admission. |
| Automatic timed erasure of idle acknowledged history | **Accepted limitation.** Retention is a minimum receipt window with bounded storage and write-driven pruning, not a maximum-time deletion service. Explicit clear now logically deletes acknowledged content immediately. |
| Physical reboot, different real Windows account and live PostgreSQL restart | **Needs external evidence.** Fresh processes, actual current-user DPAPI, injected different-SID denial and controlled repository/backend restart are exercised locally. No physical reboot, second account, live database or production acceptance is claimed. |

## Integration status

All 56 starting changed-file diffs and the affected unchanged call paths were
reviewed across the independent tracks, including generated inventory, dependency,
workflow and public contract changes. All ten existing CodeRabbit threads were
resolved at the starting revision; their fixes remain covered and none was reopened
without a reproduced regression. No automatic or manual CodeRabbit review was requested.

| Final local validation | Result |
| --- | --- |
| Full Python daemon pytest | **3,123 passed, 18 skipped**, 134.57 seconds. Skips require Windows symlink privilege or the separate Linux/POSIX sandbox environment. |
| Python-to-Express acceptance | **28 passed**, 181.81 seconds: 24 actual Windows ConPTY scenarios and four real-HTTP controlled crash/duplicate-worker fixtures. Three additional native editor-fallback cases pass inside pytest. |
| Backend, queue/result/auth/dispatch and direct-answer regressions | **630 passed** across 19 suites; the updated dispatch/OpenAPI projection also passed its 71-test focused check. |
| Type-check / production build | **Passed** with Node 24.18.1 / npm 11.16.0. Build output remains uncommitted. |
| ESLint | **Passed**, zero errors and 77 existing warnings. |
| Documentation / local links / generated indexes | **Passed**: 1,188 documentation checks, 811 local links, all four regenerated inventories current. |
| Backend/CLI contract and Python offline validator | **Passed**. |
| Repository synchronization | **Passed**, zero errors/warnings and five existing informational notices. |

Full-suite logs remain under `tmp/audit-python-final.log`, `tmp/audit-http-full.log`,
`tmp/audit-backend-matrix.log`, `tmp/audit-typecheck.log`, `tmp/audit-lint.log`,
`tmp/audit-build.log`, and the corresponding `tmp/audit-{docs,links,sync,contract,offline}.log`.
The exact-head CI and draft PR receipt are reported in the PR audit comment.
Required checks must pass at that exact remote head before merge readiness can be claimed.
This record contains no merge, deployment, credential-change or paid-inference authorization.

# Full-system continuation acceptance

**Verdict: PARTIAL pending final-head CI.** Automatic delivery, protected restart
recovery and real PostgreSQL persistence passed the recorded local scenarios.
The subsequently authorized cancellation transport repairs the slow-header
shutdown blocker: the final native ConPTY case stopped its active worker in **0.016 s**,
retained one encrypted pending record, and delivered the original answer on
relaunch with one history turn and 144 tokens. Earlier failing measurements below
remain historical evidence. Final-head required CI is a separate acceptance gate.

This is a maintained acceptance dashboard for PR #1589, not a production
runbook or merge approval. The [Python daemon guide](../../../../../daemon-python/README.md#async-backend-client-flow)
and [database contracts](../../../../DATABASE_MIGRATIONS.md) remain canonical.
The lead updates this dashboard only from newly executed evidence; earlier
captures remain historical. Final publication SHA, required CI and review state
belong to the final PR receipt, not a claim inferred from local tests.

| Identity | Recorded boundary |
| --- | --- |
| Repository / PR | `pbjustin/Arcanos` / #1589; preserve its existing review lifecycle. |
| Base | `f72a504333bcc7c1a8cf360f03b6638a5788cbb6` |
| Starting HEAD | `945334ca4d0521eb9c28872be5f77a9628c9885c` plus the local corrections under acceptance. |
| Toolchain | Native Windows, Python 3.11.7, Node 24.18.1, npm 11.16.0. |
| Data / providers | Isolated synthetic profiles and credentials; synthetic model transport. |
| Production / paid inference | **NOT_RUN / 0**; no deployment, merge or production modification. |

## Genuine runtime boundaries

The [PostgreSQL acceptance suite](../../../../../tests/daemon-conversation-continuation-pg18.e2e.test.ts)
uses the existing native ConPTY CLI fixture, actual `python -m arcanos.cli`,
HTTP transport, production `createApp()` middleware/routes, CORE/Trinity,
priority execution, real job repository/query/transaction code, PostgreSQL,
job-read verification, native DPAPI, SQLite history and terminal presentation.
It does not call `startAppRuntimeOnce` or activate backend workers.

Only pool ownership and unrelated infrastructure are isolated; job SQL,
acceptance transactions, leases and terminal fencing are unchanged. Runtime
`job_data`/`job_events` definitions and the existing claim-generation migration
are installed in a random disposable schema; the migration runs twice.
This does not prove every unrelated database migration or full server startup.

An official portable PostgreSQL **18.6** instance ran only on loopback in the
task checkout. The guard required the existing disposable database
`arcanos_audit_pg18_20260727`. Restart tests compared `SHOW data_directory` with
the owned task directory before invoking the owned `pg_ctl`. The cluster was
stopped afterward, with no listener or postmaster PID remaining; evidence and
data were retained. No Windows service or account configuration was changed.

The broader [HTTP matrix](../../../../../tests/daemon-conversation-continuation-http.e2e.test.ts)
uses actual Express leaf routes and security middleware with controlled job
storage. Its result is real HTTP evidence, not PostgreSQL proof or proof of the
entire application composition. The PostgreSQL suite closes that persistence
and `createApp()` coverage gap independently.

## PostgreSQL and accounting acceptance

All **15 PostgreSQL scenarios passed**, together with **six CI truth-contract
checks: 21/21** in the final recorded run. Four native cases cover immediate
HTTP 200, automatic HTTP 202, CLI exit/relaunch, and a fresh backend serving
process followed by CLI recovery. Each records one original POST, one controlled
provider invocation, one history turn, **144 tokens**, one completed audit and
zero speech events. Recovery never submits another generation POST.

The fresh serving child runs the actual application and database client against
the retained PostgreSQL schema. It rejects non-GET requests and traps/counts
outbound HTTP attempts; its provider/generation counters remained zero.
Closing the original listener and serving from a different process is not a
production restart or an arbitrary in-flight provider-process crash test.

| Real persistence check | Observation |
| --- | --- |
| Commit before 202 | A PostgreSQL trigger waits on an owned advisory lock. No response or provider call occurs while insertion is blocked; an independent connection sees the row when 202 is emitted. |
| Accepted coordinates | Original committed job ID, matching fixed-header capability and same-job result path. |
| Idempotent repository reuse | Reusing the exact original authoritative scope returns its existing row; no new inference. |
| Terminal fencing | A stale generation/owner fence, expired lease and terminal overwrite attempts cannot replace the current result. |
| Failure before acceptance | Actual transaction timeout returns HTTP 503, no accepted coordinates, no row and no provider invocation. |
| Failure saving completed output | Actual PostgreSQL rejection becomes a failed job with no retained answer; one provider call, no regeneration. |
| Terminal result reads | Completed, failed, cancelled, expired and completed-with-missing-output states remain distinct; missing output reports `JOB_RESULT_UNAVAILABLE`. |
| Authorization/privacy | Missing, invalid and cross-job capabilities fail closed; missing and unauthorized work retain the existing access-hiding contract. |
| Real database outage/restart | Retained result reads return 503 while the owned PostgreSQL server is stopped, then return the same completed job after restart; zero generation/provider calls. |
| Retention/compaction | Real cleanup expires eligible pending/terminal rows, later compacts expired work, and preserves unexpired results. |

The sanitized PostgreSQL HTTP ledger records **69 requests**, **seven original
POSTs** (one failed before acceptance), **six controlled provider invocations**,
**41 result GETs**, **zero replacement POSTs**, and **zero paid calls**.
The four native cases account for 31 of those requests; totals must not count
their per-case receipts again. Actual capabilities were absent from scanned
native profile/log/SQLite/temporary artifacts, receipts and persisted job output.

Idempotency is scoped, not universal. A raw Authorization header or caller
session ID does not establish an authenticated actor for public GPT writes.
Anonymous public requests receive separate server-owned scopes; repeating the
POST is not a supported recovery mechanism. The test proves reuse under the
original stored scope, not anonymous HTTP POST deduplication. Existing stale-job
retry policy can independently re-execute work; these GETs do not change it.

Default completed retention is 24 hours, failed six hours, cancelled one hour,
pending maximum 30 minutes, with expired compaction after a further 24 hours.
An authorized expired-row read can retain its old output until compaction, but
returns `JOB_EXPIRED`; the daemon rejects that state before considering output.
SQL/process-restart tests do not prove survival of hardware or fsync failure.

## Confirmed defects and fixture gaps

| Classification | Reproduction and correction |
| --- | --- |
| Product: immediate usage | Actual HTTP 200 contained `result.meta.tokens.total_tokens=144`, but CLI history saved zero. The parser now promotes only established execution metadata from one dispatcher wrapper, preserves outer values and does not promote nested presentation. Native acceptance now saves 144. |
| Product: SQLite writer wait | Real WAL contention let stop return with a live worker and a later history commit. Recovery-only waits are now 250 ms; the same probe stopped in 0.188 s with no late history. |
| Product: lazy SQLite reader wait | An exclusive lock blocked the schema probe beyond stop. The same bounded recovery wait produces a 0.609 s stop, no live worker and no result GET. |
| Product: connection cleanup | Corrupt-database setup left a native SQLite handle open in the traceback. Explicit cleanup now permits the native file operation while the traceback remains alive. |
| Product: slow response body | A dribbled body outlasted the previous inactivity timeout. Streaming consumption now has a size/deadline/cancellation boundary; the real slow-body stop probe completed in 0.812 s with the pending record retained. |
| Product: header acquisition (repaired follow-up) | Earlier slow headers overran shutdown: stop returned at 3.000 s with a live worker, finishing at 6.031 s. The authorized contained transport now cancels and reaps the entire Requests GET, including acquisition, with no late completion; see the follow-up below. |
| Fixture: synthetic storage | An in-memory job map could not prove commits, fencing or restarts across PostgreSQL. The guarded real PostgreSQL suite now covers those boundaries. |
| Fixture: crash simulation | Raised-exception recovery cases are identified separately from new actual CLI `os._exit(97)` cases and the abrupt SQLite transaction child. |
| Previously repaired fixture (verified): early diagnostics | The starting revision already preserves early primary failure receipts despite uninitialized SQLite. Available history remains best effort and unknown counts remain null; this is verified prior work, not a new repair. |
| Fixture: streamed observation | The response observer eagerly consumed `stream=True` bodies before the recovery reader could enforce its body budget. Lazy JSON observation now preserves the actual consumer boundary; focused observer regressions cover it. |
| Fixture: shared rate budget | Reused synthetic control-plane identity exhausted the existing rate budget, producing five failures. Per-scenario fixture identity preserves the real limit; all 37 HTTP cases now pass with zero HTTP 429 responses. |
| Fixture: known-job nonowner | Idle-observer coverage did not exercise a second live CLI explicitly resuming a known accepted job ID. The real nonowner attempt now verifies denial without a result GET or wrong-console delivery. |
| Fixture: full-suite readiness control | A fake console's observations no longer satisfied the extended ownership readiness check, so its intended SQL-error assertion was not reached. The fixture control was corrected and the final full Python suite passed. |
| Fixture: Docker address assumption | Exact-head CI at `dba06fac` failed ten PostgreSQL cases during setup: the server reported its Docker bridge address behind the loopback port forward. The fixture now validates the actual database/version and retains the existing strict loopback client-URL/disposable-database guard; it no longer confuses the server's internal address with the configured client target. This does not admit remote or arbitrary database URLs. |

## Crash and delivery boundaries

| Actual fault boundary | Established behavior / limit |
| --- | --- |
| Before encrypted acceptance persistence | Fresh launch has no durable local handle and does not regenerate; automatic recovery cannot reconstruct the lost coordinates. |
| After encrypted persistence | Fresh CLI restores the original accepted job and original question. |
| During result GET / after successful result receipt | Fresh process rereads the same job; no replacement generation. |
| Before SQLite commit | No fabricated history; original accepted work remains recoverable. |
| During SQLite transaction | Abrupt child exit rolls back partial turn/totals/event writes; fresh connection commits once. This is distinct from raised exceptions. |
| After SQLite commit | The existing delivery receipt prevents duplicate stored history, usage and durable completion events. |
| During display / before display acknowledgement | A fresh process can repeat display; terminal output and SQLite cannot commit atomically. Stored turns and accounting remain idempotent. |
| Slow headers during shutdown | Before the cancellation follow-up, stop returned before the worker ended. The repaired native case now stops/reaps the worker and retains the encrypted record for fresh-process recovery; no late history or extra generation. |

Exactly-once durable history/accounting does not imply an absolute exactly-once
terminal display or console-audit guarantee across arbitrary process death.
Logical clear is not physical erasure of SQLite pages, WAL, backups or prior
terminal output. Legacy JSON backup is not a complete SQLite/recovery backup.

## Earlier validation ledger (before cancellation follow-up)

| Check | Recorded result / final update |
| --- | --- |
| PostgreSQL/full application | **15 passed**; with six CI truth checks, **21 passed**. |
| Existing PostgreSQL/strict guard matrix | **68 passed, one skipped**; that optional owned-cluster restart was separately executed successfully. |
| Docker-fixture follow-up guards | **25 passed** across the existing disposable-URL, required-database and CI truth-contract suites; no target allowlist was broadened. |
| Native HTTP matrix | **37 passed**: 33 ConPTY scenarios and four object-fault HTTP scenarios; controlled repository, not PostgreSQL. |
| Native HTTP counters | 262 requests, 37 original POSTs/providers, 63 result GETs, zero replacement POSTs/paid calls. Separate from the PostgreSQL ledger. |
| Combined acceptance counters | **331 HTTP requests, 44 original POST attempts, 43 controlled provider invocations, 104 result GETs; zero replacement POSTs/paid calls.** One PostgreSQL attempt failed before acceptance, explaining 44 versus 43. |
| Backend contract/security/budget matrix | **630 passed** across 19 suites. |
| Persistence/security/accounting | **118 passed, two skipped**; skipped native symlink creation lacks Windows privilege. |
| Read deadline/client regressions | **232 passed**; this does not override the separate slow-header overrun. |
| Full Python / CI-equivalent coverage | **3,151 passed, 20 skipped** in 192.29 s after the readiness-fixture correction: seven unavailable symlink cases and 13 Linux/POSIX cases. |
| Focused fake-terminal fixture control | **Five passed** in 0.12 s; the intended SQL-error control is reached. |
| Type check / ESLint / production build | **Passed**; lint has 77 existing warnings and zero errors. |
| Backend/CLI contract, offline validation and repository sync | **Passed** in the lead's final validation. |
| Documentation / indexes | Documentation audit **1,201/1,201 passed** after the new acceptance record was tracked; generated indexes current. Final publication checks belong to the lead. |
| Exact-head CI / reviews / mergeability | **PENDING_FINAL_HEAD_VERIFICATION** in the final PR receipt; old-head CI cannot validate these working changes. No new CodeRabbit review requested. |

Local evidence is retained under ignored `tmp/`; paths identify reproducible
captures, not published attachments. Primary records are
`full-system-pg18-final.log`, `full-system-pg18-affected.log`,
`full-system-postgres/http-ledger.json`,
`full-system-postgres/aggregate-evidence.json`,
`full-system-pg18-immediate-before.log`,
`full-system-immediate-usage-before.log` / `-after.log`,
`full-system-contention-before.log` / `-after.log`,
`full-system-connection-before.log` / `-after.log`,
`full-system-slow-read-before.log` / `-final.log`, and
`full-system-slow-headers-final.log`. The Docker setup failure is preserved in
`full-system-pg-ci-failed.log`; the final PR receipt identifies its follow-up
validation and exact-head CI. Captured values are synthetic and receipts
must remain free of raw bearer credentials or personal data.

Physical Windows reboot, a second named-account logon, production PostgreSQL
restart, production acceptance and paid inference were **NOT_RUN**. Actual
anonymous-principal DPAPI/ACL denial and fresh-process restart simulations are
separately identified evidence. File/directory symlink tests were unavailable
without additional Windows privilege; no privilege or account changes were made.

## Authorized cancellation follow-up

Starting from `6b71111c`, five new real-HTTP regressions failed before repair:
dripped headers/status could bypass the elapsed budget, and silent headers/body
could delay shutdown until socket inactivity. The replacement is scoped to
production conversation-recovery GETs. Ordinary synchronous/typed API transport,
job authorization, pending ownership and generation paths are unchanged.

One temporary Python child runs the existing Requests library with a two-second
parent deadline and its own hard lifetime. Cancellation kills and reaps it and
joins the pipe reader. If the parent exits abruptly, the child timer bounds the
orphan lifetime. No persistent service or resolver/reader thread is left behind.
The fixed helper permits only a canonical original-job result GET, disables
redirects, bounds decoded output to 512 KiB, and reads at most 4 KiB of anonymous
stdin. Job/writing credentials never enter arguments, environment or disk.
Existing proxy/CA settings are retained, but provider/backend environment secrets
and arbitrary Python startup hooks are excluded. Installed Requests dependencies
are resolved from the parent; `-S` prevents daemon/site startup in the helper.

Real tests verify cancellation, elapsed deadlines, socket closure, helper cleanup
after abrupt parent death, TLS default trust/custom CA/hostname validation,
redirect rejection and credential isolation. A real native slow-header case
exits without forced termination, then a fresh CLI retrieves the same accepted
answer automatically: one generation POST/provider invocation, two job GETs,
one saved turn, 144 tokens, no manual resume and no late history/display.

The final PR receipt records rerun counts and exact-head CI. Earlier local logs
remain retained; new evidence uses `tmp/cancel-transport-*` and
`tmp/cancellation-transport-boundaries.log`. A cold-CI evidence-directory setup
failure and the migrated native observer timestamp were corrected without
weakening target, ownership or HTTP assertions.

| Cancellation follow-up validation | Executed result |
| --- | --- |
| Full Windows Python / coverage | **3,168 passed, 20 platform skips**, 194.88 s. |
| Native HTTP matrix | **38 passed**, 259.04 s: 34 ConPTY scenarios and four object-level HTTP fault scenarios. |
| Header/body/status cancellation and deadline cases | **13 passed**; with six existing fixture controls, **19 passed**. Five new cases failed before the repair. |
| Helper process/security boundaries | **12 passed**: actual parent death, pipe/process cleanup, credentials, input failure, redirect, TLS trust/hostname and proxy routing. |
| Full-app PostgreSQL / native acceptance | **15 passed plus six CI truth checks: 21 passed**; cold missing-evidence-directory case also passed separately. Owned PostgreSQL stopped afterward. |
| Native acceptance counters | 264 HTTP requests, 38 original POSTs/provider invocations, 59 result GETs, zero replacement or paid calls. Two interrupted responses are recorded as cancelled rather than completed. |
| PostgreSQL acceptance counters | 67 HTTP requests, seven original POST attempts, six provider invocations and 39 result GETs; one POST rejected before acceptance. |
| Combined primary acceptance counters | **331 HTTP requests, 45 original POST attempts, 44 controlled provider invocations, 98 result GETs; zero replacement generation or paid calls.** Separate focused/security traffic is excluded. |
| Native slow-header shutdown and restart | Active worker exited in **0.016 s**, one encrypted record retained; restart delivered one original 144-token turn with one POST/provider and two GETs. |
| Type check / lint / production build | **Passed**; lint zero errors, 77 existing warnings. |
| Documentation / indexes / contract / offline / sync | **Passed**; 1,201 documentation checks, 812 local targets, all four indexes current. |

No second job repository, persistent service, background action loop, dependency
or generic encrypted database framework was added. Command polling and
self-healing remain disabled. Full-system acceptance remains **PARTIAL** until
required final-head CI completes; local success is not merge/deployment approval.

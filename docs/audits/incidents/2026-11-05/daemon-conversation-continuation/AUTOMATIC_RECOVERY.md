# Automatic recovery acceptance for PR #1589

This extends the [original investigation](README.md). That document captures
the earlier manual-only implementation. This follow-up starts from
`d574d2103e80d84f68464bc53258f679e41cffe8` on the existing draft branch; it
does not establish what happened to the original production job.

## Delivery and recovery boundary

The ordinary Windows CLI automatically monitors only validated accepted jobs.
It never repeats the generation POST. The existing `/resume` operation remains
available for diagnosis and process-private recovery if secure retention fails.
Automatic recovery defaults on; `CONVERSATION_RECOVERY_ENABLED=false` disables
only this monitor, without enabling or changing daemon command polling,
self-healing, local execution, or speech.

Each foreground monitor performs sequential result GETs for its owned jobs.
Native per-job claims reserve delivery for the originating console until it exits;
one leader per Windows user, data directory and authenticated backend adopts
orphaned work. There are at most eight accepted/in-flight
contexts, a two-second read timeout, and per-job exponential waits capped at
30 seconds for pending work and 60 seconds for transient failures. An OS claim
serializes manual and automatic delivery. Shutdown interrupts waits and retains
unfinished recovery. Backend responses, rather than guessed local deadlines,
determine expiration: a pending job can acquire a different terminal retention
deadline when it completes.

The whole bounded recovery snapshot uses current-user Windows DPAPI, an
explicit account SID, restrictive filesystem ACLs, integrity validation, and
atomic ciphertext replacement. The original question, capability, session
correlation and lifecycle fields are encrypted together. No plaintext recovery
journal or temporary file is created. The snapshot is limited to eight records,
2 MiB overall and 128 KiB per question. Backend URL and configured authenticated
writing credential are hashed into its recovery identity; process instance IDs
can change. A stored session ID never grants server authorization. Credential
rotation, a different backend, corrupt ciphertext or inaccessible protection
fails closed. There is no automatic generation fallback.

Approved/redacted history and available usage commit transactionally to the
daemon's existing SQLite database, keyed by a digest of backend identity and
original job ID. A deterministic completion policy event commits in the same
transaction. Delivery receipts are bounded to 2,048 records / 64 MiB of logical
payload; acknowledged receipts can be pruned after eight days, beyond the
supported seven-day maximum backend terminal retention. Totals survive receipt
pruning. Capabilities and raw result payloads are never passed to SQLite. Normal
history views still include these turns when monitoring is disabled.

The terminal cannot commit atomically with SQLite. Output occurs after the
history transaction and acknowledgement occurs after output. A crash in that
gap may repeat terminal text, while stored turns, usage and completion policy
events remain idempotent. The console audit claim is durable and at most once;
a crash after its claim may omit that console line, while the transactional
policy event remains. Pending work is never recorded as completed.

## Backend findings

Existing acceptance commits `findOrCreateGptJob` before returning accepted
coordinates. Existing terminal updates store status and output together under
worker/claim-generation/live-lease fencing. Regression tests explicitly reject
acceptance on commit failure and reject a successful model invocation as proof
of terminal persistence. Result GETs cannot dispatch generation. Repository
outages remain retryable rather than becoming synthetic missing results.

A confirmed contract gap was a completed row whose actual stored output is
null/undefined. It now returns the existing typed failed-result envelope with
`JOB_RESULT_UNAVAILABLE`, preserving its actual completed lifecycle. Missing and
unauthorized jobs retain existing access-hiding behavior. This is distinct from
an authorized result projection that intentionally withholds output.

Defaults remain completed 24 hours, failed six hours, cancelled one hour, and
pending maximum 30 minutes. Configured terminal retention is bounded to seven
days. Existing stale-running retry policy is unchanged: backend execution can
retry work under its own policy, independently of these read-only GETs. If a
model answer was never durably stored, recovery reports the loss; it cannot
reconstruct that answer. Synthetic storage tests do not prove PostgreSQL
locking, disk durability, or live-provider billing.

## Evidence

Native acceptance runs `python -m arcanos.cli` in Windows ConPTY against the
actual loopback Express GPT/dispatcher/CORE/Trinity/provider-mapping and jobs
routes. Only paid provider transport, database I/O and unrelated effects are
controlled. Request counters separately count generation POSTs, provider calls
and result GETs. The final fixtures cover automatic delivery during partial
input, multiple accepted conversations, application exit/relaunch, transient
503s and a new backend serving process loading retained controlled output.
The backend restart fixture closes the original listener and clears its store;
a fresh Node child imports the compiled jobs router and real capability verifier
at the same backend address, with no generation endpoint or provider.

Additional native DPAPI/controller/SQLite regressions cover tampering, backend
and credential isolation, duplicate workers, offline reads, malformed results,
failed/cancelled/expired/lost results, SQL rollback under abrupt process exit,
and failures before and after terminal output begins. An isolated child using
the actual anonymous Windows security principal cannot decrypt the DPAPI blob.
This is not a second named-account logon. A fresh-process recovery simulates the
application boundary after a system restart; a physical Windows reboot is not
performed.

No production backend, installed daemon profile, production credentials,
paid inference, deployment, or merge is part of this acceptance.

The requested scenario matrix uses these distinct evidence boundaries:

| Scenario | Evidence |
| --- | --- |
| HTTP 200 immediate delivery | Actual Windows CLI and Express route. |
| HTTP 202 automatic completion | Actual ConPTY, original POST/provider once, original-job GETs. |
| Exit before completion | Native CLI exits with encrypted pending work and no success. |
| Application restart | Fresh native CLI process, changed instance ID, original answer/history once. |
| System restart simulation | Same protected disk profile and Windows account, fresh process; physical reboot not run. |
| Concurrent pending jobs | Two original questions, two provider calls, correctly isolated answers/history/audits. |
| Offline backend then recovery | Listener unavailable beyond the two-second read timeout, then restored. |
| Temporary HTTP 503 | Two retryable lookups before the original completed result. |
| Backend process restart | Fresh compiled jobs-router child, retained controlled job, no generation endpoint. |
| Expired result | Native HTTP terminal failure, no completed turn. |
| Invalid capability | Actual capability verification denies access, no answer or history. |
| Tampered protected file | Fresh native startup fails closed without a job GET. |
| Different Windows owner | Fresh-process SID mismatch prevents reads; actual anonymous-principal DPAPI test independently denies decryption. No named second-account logon. |
| Different backend URL | Fresh native startup at another port makes no job GET. |
| Duplicate workers | Actual HTTP with two controllers and the shared protected/OS leader; separate cross-process claim tests. |
| Crash during history commit | Actual HTTP with transaction rollback and fresh process; separate native child exits abruptly inside a real SQLite transaction. |
| Failure after output begins | Actual HTTP, partial terminal write, fresh process; one stored turn/usage/durable event. |
| Completed model with no stored output | Actual Express terminal contract reports `JOB_RESULT_UNAVAILABLE`, never regeneration. |
| Cancelled/failed work | Actual native HTTP terminal-state cases. |
| Security/privacy/trust regressions | Full daemon pytest, backend capability/response/session matrix and direct-answer/output-integrity suites. |

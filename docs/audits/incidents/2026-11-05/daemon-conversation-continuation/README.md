# Windows daemon conversation continuation

The [automatic recovery follow-up](AUTOMATIC_RECOVERY.md) supersedes this
capture's manual-only delivery and process-local retention limitations.

This is a dated incident investigation and local acceptance record, not a
production runbook or deployment approval. Its canonical behavior owner is the
[Python daemon guide](../../../../../daemon-python/README.md#async-backend-client-flow).
Source observations below were made against `origin/main`
`f72a504333bcc7c1a8cf360f03b6638a5788cbb6`, which includes PRs #1585–#1588.
Validation results must identify actual execution separately from source review.
No production request, provider call, credential change, or deployment is part
of this investigation.

## Evidence artifacts and lifecycle

These captures share the canonical [Python daemon guide](../../../../../daemon-python/README.md#async-backend-client-flow).
They record authorized local work already executed; they do not authorize any
production operation. Later PR comments identify subsequent exact-head validation.

| Artifact | Lifecycle, purpose and capture boundary | Validation status | Canonical owner | Action status |
| --- | --- | --- | --- | --- |
| [This incident capture](README.md) | Historical investigation and manual-continuation acceptance, starting at `f72a5043`; superseded for automatic delivery and persistence. Original production job availability remains unproven. | Local failing-before/passing-after evidence below; no production acceptance. | Python daemon guide | Authorized local repair/tests executed; no deployment. |
| [Automatic recovery acceptance](AUTOMATIC_RECOVERY.md) | Historical automatic/restart-recovery acceptance starting at `d574d210`, with maintained delivery-boundary notes; synthetic provider and controlled storage. | Local HTTP/ConPTY acceptance and limitations recorded in that capture. | Python daemon guide | Authorized local implementation/tests executed; no production or paid inference. |
| [Independent defect audit](INDEPENDENT_AUDIT.md) | Historical independent audit capture, starting at `2f7e7cfb` and published at `746aaf78`; privacy, console ownership, quota and failure-path repairs. | 3,123 Python, 28 HTTP and 630 backend tests passed locally; exact-head CI status belongs to the linked PR audit comment. | Python daemon guide | Authorized fixes/tests and draft-PR publication executed; no merge/deployment. |
| [Full-system E2E acceptance](full-system-e2e.md) | Final acceptance starting at `945334ca`; actual PostgreSQL, full Express middleware, native crash boundaries, storage contention and authorized cancellation follow-up from `6b71111c`. | **PARTIAL pending exact-head CI**: local automatic recovery and slow-header shutdown repair pass; final checks belong to the PR acceptance comment. | Python daemon guide | Authorized local repairs and existing-PR publication; current review lifecycle preserved, no merge/deployment. |

## Incident correlation and limits

Existing Windows daemon transport records independently correlate the supplied
November 5 incident: an authenticated `GET /system-state` returned HTTP 200 at
09:34:35 UTC; one `POST /gpt/arcanos-daemon` began at 09:34:35 UTC and returned
HTTP 202 with error kind `pending` at 09:34:43 UTC. These are sanitized facts
from local historical records, not new requests.

Those records contain no response body, accepted job ID, job-read capability,
execution-plan reason, original message list, or server configuration. They
cannot establish whether this particular answer was durably saved, whether it
completed before or after the HTTP response, or whether it remains retrievable.
The supplied backend account reports a successful model invocation; that alone
does not prove terminal job persistence. The exact production selection cause
and original result availability remain **NOT_PROVEN**.

## Request lifecycle findings

| Question | Current source evidence and boundary |
| --- | --- |
| A. Why can a short conversation return 202? | The chat route supports job-backed execution and a bounded direct-return window. A short last user message does not determine the complete request's execution mode. An unfinished accepted job can return 202 without another generation request. The incident's precise branch is unknown. |
| B. What selects async handling? | The ordinary daemon request sends `prompt`, conversation `messages`, metadata, and `sessionId` derived from its instance identity; it does not force an execution mode. The router separately considers explicit mode/action, CORE async configuration, prompt length, message count, requested output size, diagnostic answer mode, and fast-path fallback. Default heavy thresholds are 1,200 prompt characters, eight messages, or 700 requested words. A session ID alone does not select async. Independently authenticated memory/session hydration instead forces synchronous request-local dispatch and bypasses jobs. Priority queue admission and the direct-return timeout operate after job-backed execution is selected. |
| C. Are safe coordinates available? | Accepted public GPT job responses are built with an actual job ID, result path, `jobReadToken`, and the fixed `x-arcanos-job-read-token` header name. Direct-return timeout preserves those fields and adds `status: timeout`, `timedOut: true`, and an empty `result`. The original incident body is unavailable, so its coordinates are not proven. |
| D. Was the answer stored? | The priority execution service persists the output envelope through the existing fenced terminal job update. Model success and a pending HTTP response do not establish that this update succeeded. Production storage state is unknown; local fixtures control the existing repository boundary and do not prove PostgreSQL durability. |
| E. When did generation finish? | Direct execution continues independently of the route's bounded result wait. Either completion ordering is possible. The incident's eight-second elapsed HTTP time is compatible with the default priority direct-return threshold of 8,000 ms, but does not prove that branch or its configured value. |
| F. Can a result be read without generation? | Existing `GET /jobs/:id/result` reads the accepted job using its job-specific capability. It does not enqueue or invoke the provider. There is no need to repeat `POST /gpt/arcanos-daemon`. |
| G. What did the client lose? | Before this repair, the ordinary chat transport classified HTTP 202 as a pending error before chat parsing. The CLI accurately withheld completion, but discarded the continuation coordinates and original-question association. Typed explicit async methods already retained job metadata; they are a separate compatibility surface. |
| H. What guarantees already exist? | Existing job creation uses request fingerprint/idempotency scopes; claimed execution uses fenced updates; lifecycle responses expose retention and terminal status. Generic result reads require the dedicated job-specific capability, deny missing/invalid/cross-job values, and preserve recognized queue provenance. A caller-supplied session ID is not server-side tenant authentication. This repair retains those contracts. |

The implementation boundaries are
[the canonical GPT route](../../../../../src/routes/gptRouter.ts),
[execution classification](../../../../../src/routes/_core/gptRouteExecutionPolicy.ts),
[async response construction](../../../../../src/routes/_core/gptAsyncJobResponses.ts),
[priority execution](../../../../../src/services/priorityGptDirectExecutionService.ts),
[generic job reads](../../../../../src/routes/genericJobsRouter.ts), and
[job capability verification](../../../../../src/shared/jobs/jobReadCapability.ts).

## Focused repair and containment

The daemon retains validated accepted-job coordinates privately with the original
question, originating CLI instance, and backend identity. `/resume <jobId>` reads
that same job once through the existing result API. `/resume` lists process-local
job IDs. The maximum of eight contexts bounds retained state; exiting the CLI
discards them. There is no second job store, persistent capability file,
background scheduler, automatic polling, generation retry, or credential refresh
loop.

Only a completed, validated answer may reach normal presentation and history.
Pending stays unconfirmed. Terminal failures remain terminal outcomes. Completion
uses the original question and is delivered once; a later question cannot take
ownership of another pending answer. Capability values remain excluded from
terminal output, URLs, prompts, history, audit, and logging. Existing trust,
confirmation, disclosure, and action policies continue to apply; a result read
does not establish fresh FULL trust.

The canonical dispatcher also projects the existing process-local finalized
answer marker into the optional outer `presentation: "public-answer-v1"` field
before a completed envelope is stored. This preserves approved public headings
after JSON persistence. It does not reconstruct a Symbol from stored content or
promote raw model/nested module presentation fields. Unmarked legacy envelopes
retain their existing private-section protection.

The backend intentionally obscures missing versus denied result reads using
`not_found`. Explicit retained `expired` results can be reported as expired, but
an absent row or rejected capability cannot be diagnosed more precisely from
that response. No new server ownership guarantee is inferred from the local
continuation context.

## Acceptance status

The pre-repair native fixture reproduced the failure against the original
source: the ordinary question `what can u do?` caused one generation POST and
one successful controlled provider invocation at the dispatcher fixture seam;
the actual Express GPT route returned
202 with valid accepted-job coordinates; the controlled repository subsequently
held the completed output. The real Windows CLI displayed no answer, recorded
an unconfirmed outcome, saved no completed conversation, and made no result
GET. This demonstrates loss of continuation in the client independently of
production result availability.

The preserved local pre-repair receipt is
`tmp/conversation-continuation/before-accepted-job-proof.json`; it is a local
artifact, not a production record. The final post-repair acceptance strengthens
that boundary: it uses the real dispatcher, module registry, CORE action,
Trinity DIRECT_ANSWER and Responses request mapper, replacing provider transport
and database I/O with isolated fixtures. The ordinary request shape and actual
Windows CLI entrypoint are retained. It recorded one generation POST, one
Responses provider invocation with a 1,000-token allocation, and two explicit result
GETs: first pending, then completed. Replay made no result GET. The original
question and exact answer appeared once in conversation history, the completed
answer was displayed, and no credential disclosure was observed. Registry trust
expired to DEGRADED during continuation; the read did not restore FULL trust.
The exact original public headings, Markdown and Unicode survived serialized job
storage, display and history. An independent incomplete-provider case made one
provider invocation, stored a failed job, and displayed/saved no answer or success.
The local receipts are
`tmp/conversation-continuation/real-core-completed-proof.json` and
`tmp/conversation-continuation/real-core-incomplete-proof.json`.

Executed validation at this capture:

| Check | Result |
| --- | --- |
| Focused Python client, CLI and existing job-routing regressions | **PASS**, 162 tests. |
| Native Windows real CORE/Trinity HTTP 202 continuation | **PASS**, completed and incomplete-provider cases; one original generation and one provider invocation per case. |
| Final native HTTP and existing registry/security harness | **PASS**, two suites and four tests, including 36 existing native scenarios (ten ConPTY cases). |
| Full Python daemon suite | **PASS**, 2,960 passed and 18 skipped. Skipped cases are not acceptance evidence. |
| Affected backend response, queue, capability, session, security and direct-answer suites | **PASS**, 40 suites and 1,155 tests. |
| TypeScript type-check | **PASS**. |
| ESLint | **PASS**, zero errors; 76 existing warnings in unchanged files. |
| Production build | **PASS**, including compiled import and alias checks; no server started. |
| Documentation audit and generated indexes | **PASS**, 1,179 checks passed; generated indexes current. |
| Local documentation links | **PASS**, 811 local targets, zero failures; external network checks skipped. |
| Backend/CLI contract validator | **PASS**. |
| Backend/CLI offline validator | **PASS**. |
| Repository synchronization check | **PASS**, zero errors and zero warnings; five pre-existing informational findings retained. |
| Optional broader root Jest sweep on Windows | **INCOMPLETE**: stopped after sustained resource use; three failures in the unchanged workflow-summary helper test were independently reproduced as Windows/WSL environment forwarding failures. No assertions or security checks were weakened. |

Exact remote branch identity and publication checks were pending at this capture. Test presence alone is not
a pass. Production acceptance is **NOT_RUN**.

The required local boundary is the actual Windows `python -m arcanos.cli`
entrypoint, real loopback HTTP, the actual Express GPT and job-result routes,
and a controlled provider/repository fixture. Acceptance must count original
generation POSTs, provider invocations, and result GETs independently. Synthetic
provider and repository fixtures do not establish live provider billing or
PostgreSQL locking/durability.
An absent usage/cost field or a synthetic zero is not billing evidence. Result
delivery must use only available authoritative result metadata and must not
record pending work as a completed conversation.

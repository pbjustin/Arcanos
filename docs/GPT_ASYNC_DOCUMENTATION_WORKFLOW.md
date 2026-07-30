# ARCANOS GPT Async Documentation Workflow

## /gpt/:gptId API Behavior
`POST /gpt/:gptId` is the writing plane. Use it to create durable GPT generation work with `query` or non-core `query_and_wait`; core `query_and_wait` executes synchronously through the direct action lane. Do not use it to retrieve jobs, inspect queues, read DAG traces, or invoke MCP tools.

Non-core `query_and_wait` may complete inside the direct execution window. If the job is still queued or running when that bounded window expires, the response returns job coordinates and the caller must poll the jobs API. Core `query_and_wait` returns the final inline result or a typed execution error; it does not synthesize bounded fallback content.

Canonical async response shape:
```json
{
  "ok": true,
  "status": "completed | queued | running | timeout",
  "jobId": "job-id",
  "poll": "/jobs/job-id/result",
  "stream": "/jobs/job-id/stream",
  "jobReadToken": "v1.<job-specific-signature>",
  "jobReadTokenHeader": "x-arcanos-job-read-token",
  "timedOut": true
}
```

## Job Polling Contract
Canonical route rule: send the creation response's `jobReadToken` only in
`x-arcanos-job-read-token` (never in the URL). Poll
`GET /jobs/:id/result` until the status is terminal, sending exactly one such
header on every request. The same capability is required by `GET /jobs/:id` and
`GET /jobs/:id/stream`; it is bound to that job id and is not accepted from a
query parameter, cookie, or request body. Treat it as a bearer secret.
`completed` is successful only when the result is not degraded. `failed`,
`cancelled`, `expired`, and `not_found` are terminal failures.

Clients must bound total polling time and use a capped interval/backoff.
Missing `jobId`, `jobReadToken`, or the fixed `jobReadTokenHeader` on a queued,
running, or timed-out acknowledgement is a client-visible protocol error
because there is no safe canonical job to poll. All job-backed creation and
generic read responses are `no-store`; the SSE stream also uses `no-cache` and
`no-transform`.

Generic reads expose only `gpt` and `ask` job types. Missing, malformed,
duplicated, incorrect, and cross-job capabilities are concealed like an absent
job: status and stream return `404`, while result retains its compatible HTTP
`200` `status: "not_found"` envelope.

Repository-unavailable HTTP `503` responses are not `not_found`. Retain any
accepted `jobId`, `poll`, `stream`, `jobReadToken`, and
`jobReadTokenHeader` fields and retry the same lookup with bounded backoff; do
not submit replacement work solely because durable status storage is
temporarily unavailable. A post-enqueue GPT wait failure uses
`ASYNC_GPT_JOBS_UNAVAILABLE`, while direct job routes use
`JOB_REPOSITORY_UNAVAILABLE`.

Job-backed creation fails with `JOB_READ_AUTH_UNAVAILABLE` when the server's
current `ARCANOS_JOB_READ_CAPABILITY_SECRET` is absent or invalid. New tokens
use only that current key. Reads fail with the same code only when neither the
current key nor the distinct optional
`ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET` is valid for verification.
Deploy the old key as previous with the new current key, then remove it after
the retained-job window drains; changing the current key without that overlap
immediately invalidates outstanding job-read tokens.

`POST /jobs/:id/cancel` accepts the same job-specific capability but also
requires confirmation and authenticated actor ownership. Never treat a token
as sufficient mutation authority.

## Degraded Pipeline Fallback
ARCANOS core can return a completed job that is degraded fallback output after a pipeline timeout. Documentation generation must not treat that output as usable.

Detect fallback when any of these fields are present on the envelope or nested result:
```ts
result?.fallbackFlag === true
result?.timeoutKind === "pipeline_timeout"
result?.activeModel?.includes("static-timeout-fallback")
result?.auditSafe?.auditFlags?.includes("CORE_PIPELINE_TIMEOUT_FALLBACK")
```

If fallback is detected, retry once with a narrower prompt. If it repeats, return:

`ARCANOS completed in degraded fallback mode; documentation generation must be split into smaller tasks.`

## Documentation Chunking
The docs generator splits updates into independent markdown sections:

- `/gpt/:gptId` API behavior
- Job polling and async contract
- Priority GPT behavior
- Queue diagnostics
- DAG tracing and slow-node timing
- Known limitations / operational caveats

Each section is one pollable ARCANOS job. Prompts must avoid full repository analysis and request markdown only.

## Priority GPT Caveats
Priority routing and fast-path eligibility do not guarantee inline completion. Priority GPT clients still need to handle `queued`, `running`, and `timedOut` responses and poll the canonical jobs API.

## Queue Diagnostics
Use direct control surfaces for queue state:

- `GET /workers/status`
- `GET /worker-helper/health`
- `GET /api/arcanos/workers/status`
- `GET /api/arcanos/workers/queue`
- explicit `queue.inspect` or `workers.status` control actions when the GPT compatibility dispatcher is the only available integration point

Do not prompt `/gpt/:gptId` to inspect the queue.

## DAG Tracing
DAG execution and trace retrieval are control-plane operations. Use:

- `GET /api/arcanos/dag/runs/{runId}`
- `GET /api/arcanos/dag/runs/{runId}/trace`
- `GET /api/arcanos/dag/runs/{runId}/tree`
- `GET /api/arcanos/dag/runs/{runId}/nodes/{nodeId}`
- `GET /api/arcanos/dag/runs/{runId}/metrics`
- `GET /api/arcanos/dag/runs/{runId}/errors`
- `GET /api/arcanos/dag/runs/{runId}/lineage`
- `GET /api/arcanos/dag/runs/{runId}/verification`
- MCP tools such as `dag.run.trace` when operating through ARCANOS MCP

Slow trace timing and node metrics should be read from DAG trace/metrics responses or MCP diagnostics, not generated through the writing pipeline.

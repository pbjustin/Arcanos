# Operator Intent Dispatcher

`OperatorIntentDispatcher` classifies operator text before any GPT job is created. It keeps runtime, worker, queue, diagnostics, logs, DB explain, MCP, Railway deployment, and job-result lookups on direct `/gpt-access/*` control-plane endpoints.

GPT reasoning is used only for writing, review, planning, summarization, generation, refactor, prompt drafting, architecture advice, and code-review style work.

Hybrid requests run the control-plane tool first, sanitize the result, and then create a GPT reasoning job with only the sanitized operational summary as context.

## Approved Endpoints

Control-plane tools:

```text
/gpt-access/status
/gpt-access/workers/status
/gpt-access/worker-helper/health
/gpt-access/diagnostics/deep
/gpt-access/db/explain
/gpt-access/logs/query
/gpt-access/mcp
/gpt-access/jobs/result
```

GPT reasoning jobs:

```text
/gpt-access/jobs/create
/gpt-access/jobs/result
```

The dispatcher must not route through `/gpt/:gptId`.

## Control-Plane Safety

The control-plane adapter exposes typed wrappers for the approved endpoints only. It rejects raw SQL, arbitrary URL fields, proxy fields, raw headers, auth fields, bearer tokens, cookies, and token forwarding before the transport is called.

Allowed DB explain keys:

```text
worker_claim
worker_liveliness_upsert
queue_pending
job_result_lookup
```

Allowed MCP tools:

```text
runtime.inspect
workers.status
queue.inspect
self_heal.status
diagnostics
```

Hybrid sanitization removes secrets, tokens, API keys, cookies, raw headers, session IDs, database URLs, and full environment variable maps. It preserves operational facts such as statuses, counts, timestamps, sanitized error categories, and trace IDs.

## Railway Verification

Confirm the linked Railway project, service, and environment before changing variables or releasing:

```bash
railway status
railway env production
railway variable list --service <web-service> --environment production
railway variable list --service <worker-service> --environment production
```

The web service must run the API runtime:

```bash
railway variable set ARCANOS_PROCESS_KIND=web --service <web-service> --environment production
```

The worker service must run the async queue runtime:

```bash
railway variable set ARCANOS_PROCESS_KIND=worker --service <worker-service> --environment production
```

Inspect logs for both services:

```bash
railway logs --service <web-service> --environment production
railway logs --service <worker-service> --environment production
```

Expected web startup log:

```text
[railway-launcher] starting web runtime ARCANOS_PROCESS_KIND=web RUN_WORKERS=false
```

Expected worker startup log:

```text
[railway-launcher] starting worker runtime ARCANOS_PROCESS_KIND=worker RUN_WORKERS=true
```

Run repository validation before deployment:

```bash
npm run build:packages
npm run validate:railway
```

Deploy only after validation passes.

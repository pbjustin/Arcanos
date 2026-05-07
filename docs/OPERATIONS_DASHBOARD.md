# Operations Dashboard Spec

This dashboard is for queue and GPT job operations. Do not include raw prompts, completions, headers, cookies, bearer tokens, API keys, database URLs, or `job_events.metadata` values as labels.

## Panels

| Panel | Prometheus metric | Suggested alert |
| --- | --- | --- |
| Queue depth | `worker_queue_depth{state="pending"}` | warn above 25 for 10m; critical above 100 for 5m |
| Oldest pending age | `worker_queue_latency_ms{scope="oldest_pending"}` | warn above 60000ms for 10m; critical above 300000ms for 5m |
| Worker health | `worker_health_status` and `worker_heartbeat_age_ms` | heartbeat age above `2 * JOB_WORKER_STALE_AFTER_MS` |
| Stale recovery | `worker_stale_total`, `worker_stalled_jobs_total`, `worker_recovery_actions_total` | any sustained increase for 10m |
| AI provider latency | `ai_call_duration_ms` by provider/model/operation | p95 above 30000ms for 10m |
| AI failures/timeouts | `ai_calls_total{outcome!="ok"}`, `dependency_failures_total`, `dependency_timeouts_total` | error ratio above 5% for 10m |
| Retry exhaustion | `worker_failures_total`, `worker_retries_total`, `gpt_job_events_total{event="job.failed"}` | dead-letter increase above 3 in 15m |
| Event throughput | `gpt_job_events_total`, `job_events_cleanup_rows_total` | sudden zero event rate while jobs are active |
| Retention cleanup | `job_events_cleanup_runs_total`, `job_events_cleanup_duration_ms`, `job_events_cleanup_rows_total` | cleanup failures above 0 for 15m; p95 duration above 10000ms |
| Trace correlation | derive from `job_events` timeline queries by `trace_id` | trace missing from new queued GPT jobs |

## SLOs

| SLO | Target |
| --- | --- |
| Async GPT queue admission | 99% of accepted jobs emit `job.created` and `job.queued` within 5s |
| Queue wait | 95% of jobs are claimed within 60s |
| Worker execution | 95% of non-retried jobs complete or fail terminally within the configured worker budget |
| Provider latency | 95% of OpenAI calls complete within 30s, excluding upstream incidents |
| Stale recovery | 99% of stale running jobs are recovered, cancelled, or dead-lettered within 2 inspection intervals |
| Retention cleanup | Cleanup completes within 10s and deletes no more than `JOB_EVENT_CLEANUP_BATCH_SIZE` rows per run |

## Replay Workflow

Build first, then query timelines with one or more filters:

```bash
npm run build
npm run job-events:timeline -- --job-id <uuid> --output text
npm run job-events:timeline -- --trace-id <trace-id> --limit 200
```

The timeline utility returns redacted metadata, chronological events, trace and worker summaries, queue wait, execution, and provider latency. It is read-only and bounded by `MAX_JOB_EVENT_TIMELINE_LIMIT`.

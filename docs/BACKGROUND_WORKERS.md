# ⚙️ Background Worker Architecture

Arcanos ships with an optional background automation layer that loads worker
modules from the `workers/` directory and schedules them with
[`node-cron`](https://github.com/kelektiv/node-cron). This document explains how
`initializeWorkers()` (`src/utils/workerBoot.ts`) runs, what context objects look
like, and how to author new workers that integrate with the persistence layer and
AI stack.

---

## 🔌 Enabling workers

Worker startup is controlled by the `RUN_WORKERS` environment variable. The boot
code treats the flag as enabled only when the value is `"true"` or `"1"`.
Leaving it unset keeps automation off by default, which is ideal for local
development. The helper still initializes the database (and records the current
connection state) before checking the flag, so `/workers/status` and
`/api/memory/health` can report accurate persistence information even when no
cron jobs are running.

> **Tip:** Jest and other tests set `NODE_ENV=test`, which disables workers by
> default. Set `RUN_WORKERS=true` in local shells or managed deployments to opt
> into background automation.

---

## 🧵 Boot sequence

`initializeWorkers()` performs the following steps:

1. Resolve the workers directory. `resolveWorkersDirectory()` searches for the
   `workers/` folder relative to `process.cwd()`, the compiled module path, and
   the optional `WORKERS_DIRECTORY` override.
2. Attempt to initialize PostgreSQL (via `initializeDatabase('worker-boot')`).
   The result is stored on the returned `workerResults.database` object whether
   or not workers are enabled.
3. If `RUN_WORKERS` is disabled, return immediately with the captured database
   status so API consumers can still see connectivity.
4. Load `worker-logger.js` first so that log messages are centralized, then boot
   the planner engine. The planner automatically schedules itself when the
   database is connected.
5. Iterate through every remaining `.js` file, create a worker context, and
   either schedule the default export (when it exposes `schedule` + `run`) or run
   the legacy export immediately.
6. Track the resulting cron jobs in `scheduledTasks` so that
   `stopScheduledWorkers()` can cleanly shut them down on process exit.

---

## 🧰 Worker execution context

Every worker receives the object produced by
`createWorkerContext(workerId)` (`src/utils/workerContext.ts`). The factory
provides:

- `log` / `error` helpers that write to stdout and call `logExecution()` so
  `execution_logs` stays up to date even if the server restarts.
- `db.query()` – the shared query helper with caching/retry support. Workers can
  run arbitrary SQL without re-implementing pool management.
- `ai.ask()` – a convenience wrapper that routes prompts through the Trinity
  reasoning pipeline (`logic/trinity.ts`). When no API key is configured the
  helper falls back to deterministic mock responses so jobs still complete.

Workers consume the context by exporting a default object with `id`, `name`,
`description`, optional `schedule`, and an async `run(context)` function.
Legacy workers that export `run()` directly continue to work; they simply skip
context injection.

---

## 🗓️ Built-in workers

The repository includes several ready-to-run modules under `workers/`:

| Worker ID | Schedule | Responsibility |
| --- | --- | --- |
| `worker-logger` | Heartbeat only | Initializes the centralized worker execution logger and emits periodic heartbeats so status dashboards stay warm. |
| `worker-planner-engine` | `*/5 * * * *` | Scans the `job_data` table, logs queue depth, and can coordinate future scheduling. Scheduling is automatically skipped when the database is offline. |
| `worker-memory` | `*/10 * * * *` | Counts rows in the `memory` table and records synchronization telemetry. |
| `worker-gpt5-reasoning` | `*/15 * * * *` | Requests a GPT‑5.1 reasoning summary about background services and stores the response via the worker context. |

Each worker follows the same default-export contract, which keeps new modules
straightforward to author.

---

## 🛠️ Authoring a new worker

1. Create a new `.js` file under `workers/` with a unique `id`.
2. Export `name`, `description`, an optional cron `schedule`, and an async
   `run(context)` function. Importing TypeScript helpers from `dist/` builds is
   not required; the worker context exposes the database and AI clients.
3. Use `context.log()`/`context.error()` for observability, `context.db.query()`
   for persistence, and `context.ai.ask()` for AI calls.
4. Handle errors gracefully and return a structured object so `/workers/run/:id`
   can display a useful payload.
5. Restart the server or call `initializeWorkers()` manually; the new module will
   be detected automatically.

---

## 🧹 Managing workers at runtime

- Call `stopScheduledWorkers()` before shutting down custom tooling to ensure all
  cron jobs stop cleanly.
- Use `/workers/status` to inspect which files were loaded, which schedules are
  active, and whether the planner connected to PostgreSQL.
- Toggle automation without deleting files by setting `RUN_WORKERS=false`.

With these mechanics in place, Arcanos can run recurring AI diagnostics,
persistence syncs, queue planners, and custom automation tasks in a structured,
observable manner.

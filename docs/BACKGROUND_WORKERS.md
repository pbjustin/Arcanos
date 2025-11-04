# ⚙️ Background Worker Architecture

Arcanos ships with an optional background automation layer that loads worker modules from the `workers/` directory and schedules them with [`node-cron`](https://github.com/kelektiv/node-cron). The following guide describes how the worker boot process runs, how execution context is provided to workers, and how to add new automation tasks to the system.

---

## 🔌 Enabling workers

Worker startup is controlled by the `RUN_WORKERS` environment variable. During server boot the flag is evaluated inside `initializeWorkers()` and the process is skipped when the variable resolves to `false`/`0`. The same routine establishes and records database connectivity before attempting to load any modules, so the status response can indicate whether persistence is available even when workers are disabled. 【F:src/utils/workerBoot.ts†L25-L71】【F:docs/backend.md†L59-L118】

> **Tip:** Tests disable workers automatically. Set `RUN_WORKERS=true` (or `1`) in local shells and deployment environments to opt into automation runs.

---

## 🧵 Boot sequence

The worker boot logic resides in `src/utils/workerBoot.ts`:

1. Resolve the workers directory. `resolveWorkersDirectory()` searches for the `workers/` folder near the current working directory and module root, with an optional override via `WORKERS_DIRECTORY`. 【F:src/utils/workerPaths.ts†L1-L61】
2. Ensure the directory exists, then list the `.js` worker modules to load. Legacy "shared" files are ignored. 【F:src/utils/workerBoot.ts†L73-L100】
3. Initialize the logging worker first. If present, `worker-logger` prints an initialization banner and registers heartbeat logging. 【F:src/utils/workerBoot.ts†L102-L119】【F:workers/worker-logger.js†L1-L31】
4. Load the planner engine and start its scheduler if the database connection is healthy. The planner performs queue heartbeats and optional scheduling coordination. 【F:src/utils/workerBoot.ts†L121-L150】【F:workers/worker-planner-engine.js†L1-L39】
5. Iterate through every remaining module, create a context, and either schedule or invoke it immediately depending on the exports that are provided. Scheduled workers are registered with `node-cron` and tracked for future shutdown. 【F:src/utils/workerBoot.ts†L152-L208】
6. Print an initialization summary, including counts of initialized, scheduled, and failed workers. 【F:src/utils/workerBoot.ts†L210-L216】

When the server shuts down, `stopScheduledWorkers()` stops each registered cron job and clears the registry. 【F:src/utils/workerBoot.ts†L220-L236】

---

## 🧰 Worker execution context

Every worker receives a helper context built by `createWorkerContext(workerId)`. The factory returns async `log`/`error` functions that write both to stdout and the structured worker execution log. It also exposes a database query helper and an AI helper that routes prompts through the Trinity reasoning pipeline while respecting mock fallbacks when no API key is configured. 【F:src/utils/workerContext.ts†L1-L61】

Workers consume the context by exporting a default object with `name`, `description`, `schedule`, and `run(context)` fields. The scheduler passes the context instance into every run so the worker can write audit trails, talk to the database, or issue AI queries without re-implementing the plumbing.

---

## 🗓️ Built-in workers

The repository includes several ready-to-run workers under `workers/`:

| Worker ID | Schedule | Responsibility |
|-----------|----------|----------------|
| `worker-logger` | Heartbeat only | Provides a central execution logger and keeps lightweight heartbeats even when the scheduler is disabled. 【F:workers/worker-logger.js†L1-L31】 |
| `worker-planner-engine` | `*/5 * * * *` | Inspects the `job_data` queue, records planner heartbeats, and can coordinate further scheduling once database access is ready. 【F:workers/worker-planner-engine.js†L1-L39】 |
| `worker-memory` | `*/10 * * * *` | Counts memory entries and logs synchronization work. 【F:workers/worker-memory.js†L1-L38】 |
| `worker-gpt5-reasoning` | `*/15 * * * *` | Requests a status summary from the AI system and records the response for diagnostics. 【F:workers/worker-gpt5-reasoning.js†L1-L34】 |

Each file follows the same export pattern, simplifying the process of authoring new workers.

---

## 🛠️ Authoring a new worker

To add a new automated task:

1. Create a new `.js` module inside `workers/` with a unique `id` and descriptive metadata.
2. Export a default object containing `id`, `name`, `description`, an optional cron `schedule`, and an async `run(context)` function.
3. Use the provided context helpers for logging, error reporting, database queries, and AI prompts.
4. Handle failures gracefully and return a structured object describing the execution.

Once the file is present, restart the server (or call `initializeWorkers()` manually) and the new worker will be detected, scheduled, and logged alongside the existing modules.

---

## 🧹 Managing workers at runtime

- Call `stopScheduledWorkers()` before shutting down to stop any active cron tasks when embedding the worker boot module in custom tooling. 【F:src/utils/workerBoot.ts†L220-L236】
- The `/workers/status` API endpoint surfaces worker boot results, including the list of scheduled workers and database health, for operations dashboards.
- Disable automation temporarily by setting `RUN_WORKERS=false` without removing the worker files.

---

With these mechanics in place, Arcanos can run recurring AI diagnostics, persistence syncs, queue planners, and custom automation tasks in a structured, observable manner.

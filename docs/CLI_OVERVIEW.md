# Arcanos CLI Overview

## What the Arcanos CLI is

Arcanos includes a TypeScript CLI package (`@arcanos/cli`) that provides a stable command-line surface for talking to the Arcanos backend and protocol runtime. It ships two executable names:

- `arcanos`
- `arcanos-protocol`

Both binaries point at the same entrypoint and command parser. The standard command mode is optimized for day-to-day operator workflows (`ask`, `plan`, `status`, etc.), while the `protocol` subcommand mode gives direct access to protocol-level requests for automation/integration use cases. 

---

## What it can do

### 1) Submit prompt tasks to Arcanos (`ask`)

```bash
arcanos ask "Summarize current worker health"
```

- Sends your prompt as a protocol `task.create` request.
- The CLI routes this to the backend GPT endpoint (`/gpt/{gptId}`) and returns text output in human-readable mode.

### 2) Generate implementation plans (`plan`)

```bash
arcanos plan "Add a runtime metrics endpoint"
```

- Sends a protocol `plan.generate` request.
- The prompt is wrapped with plan-focused instructions before being sent to backend GPT.

### 3) Queue execution work (`exec`)

```bash
arcanos exec "Apply the approved patch"
```

- Sends `exec.start` with a deterministic task id.
- Prints execution id and status (for example, `Execution queued: exec-... (queued)`).

### 4) Inspect runtime status (`status`)

```bash
arcanos status
```

- Sends `context.inspect` and `daemon.capabilities` protocol requests.
- Also reads backend `/status` + `/health` snapshots.
- Returns a compact summary with health, cwd, and supported command count.

### 5) Inspect worker fleet health (`workers`)

```bash
arcanos workers
```

- Calls backend routes for worker/runtime health (`/workers/status` and `/worker-helper/health`).
- Useful for quick operational checks.

### 6) Read recent self-heal/runtime events (`logs --recent`)

```bash
arcanos logs --recent
```

- Calls `/api/self-heal/events` and reports recent runtime event count.
- Currently supports only `--recent` form.

### 7) Inspect self-heal state (`inspect self-heal`)

```bash
arcanos inspect self-heal
```

- Calls `/status/safety/self-heal` and summarizes status.
- Currently supports only the `self-heal` subject.

### 8) Run implementation doctor check (`doctor implementation`)

```bash
arcanos doctor implementation
```

- Dispatches protocol `tool.invoke` with tool id `doctor.implementation`.
- Returns doctor status summary.

### 9) Dispatch raw protocol commands (`protocol`)

```bash
arcanos protocol exec.status --payload-json '{"executionId":"exec-123"}'
```

- Validates command id against the protocol command registry.
- Builds/validates a full protocol request envelope.
- Dispatches over configured transport and emits deterministic JSON.

---

## Global CLI options

Most commands support these global flags:

- `--json` → deterministic JSON output envelope
- `--base-url <url>` → backend base URL (default: `ARCANOS_BACKEND_URL` or `http://127.0.0.1:3000`)
- `--session-id <id>`
- `--project-id <id>`
- `--environment <workspace|sandbox|host|remote>`
- `--cwd <path>`
- `--shell <name>`
- `--python-bin <path>`
- `--transport <python|local>`

---

## Transport model

Arcanos CLI supports two protocol transport strategies:

- `python` (default): spawns `python -m arcanos.protocol_runtime` in `daemon-python`
- `local`: dispatches to the local in-process TypeScript protocol dispatcher

Use `--transport local` for local-only workflows; use default/python when you need parity with the Python protocol runtime.

---

## Output model and exit codes

- Human mode: prints concise human-readable text.
- JSON mode (`--json`): prints deterministic, key-sorted JSON.
- Exit code `0`: command succeeded (`response.ok === true`).
- Exit code `1`: protocol/runtime failure, validation error, or CLI parsing error.

---

## Command surface (quick reference)

```text
arcanos ask "..." [--json]
arcanos plan "..." [--json]
arcanos exec ["..."] [--json]
arcanos status [--json]
arcanos workers [--json]
arcanos logs --recent [--json]
arcanos inspect self-heal [--json]
arcanos doctor implementation [--json]
arcanos protocol <command> --payload-json '{}'
```

---

## Typical workflows

### Operator: fast status + logs check

```bash
arcanos status
arcanos workers
arcanos logs --recent
```

### Prompt-first development loop

```bash
arcanos ask "Propose safe refactor for command router"
arcanos plan "Implement the approved refactor"
arcanos exec "Apply patch for approved plan"
```

### Automation/integration

```bash
arcanos protocol context.inspect --payload-json '{"includeProject":true,"includeAvailableEnvironments":true}' --transport local
```

Use `--json` for machine parsing in scripts/CI.

---

## Scope and current constraints

- `logs` currently supports only `--recent`.
- `inspect` currently supports only `self-heal`.
- `doctor` currently supports only `implementation`.
- Unknown commands or invalid flags fail fast with explicit CLI errors.


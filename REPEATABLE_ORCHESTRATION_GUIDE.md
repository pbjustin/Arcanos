# Repeatable Worker Orchestration Guide

This guide explains how to run a continuous worker orchestration loop in ARCANO’s backend. The process re-registers workers, confirms routing with the AI model and records the results.

## Overview
The orchestration loop performs these steps for each known worker:

1. **Re-register every worker every 60 seconds** using the existing `registerWorker` function.
2. **Ping the AI model** via `safeOrchestrateWorker` to confirm that routing succeeds.
3. **Retry failed orchestrations** automatically through the fallback logic inside `safeOrchestrateWorker`.
4. **Timestamp each routing record** so you can trace when a worker was last confirmed.
5. **Log all routing results** into the diagnostic registry for later inspection.

## Usage

Import the helper and start the loop:

```typescript
import { startRepeatableOrchestration } from './services/repeatable-orchestration';

// Start a 60 second orchestration cycle
startRepeatableOrchestration();
```

The diagnostic registry keeps the most recent records in memory:

```typescript
import { getDiagnosticRecords } from './services/diagnostic-registry';

const records = getDiagnosticRecords();
console.log(records);
```

## Diagnostic Registry Fields
- `worker` – name of the worker that was routed
- `status` – `success` or `failed`
- `timestamp` – ISO timestamp of the orchestration attempt
- `error` – optional error message if the attempt failed

This simple loop makes orchestrations repeatable and observable without adding heavy dependencies.

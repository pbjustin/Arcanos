# Backend Sync & GPT Integration Implementation

This document explains how backend synchronization and GPT integration are
implemented in the current Arcanos service. The implementation centres around a
file-backed state store, `/status` endpoints, and helper utilities that fetch the
latest backend state before invoking OpenAI.

## Overview

The implementation provides:
- **System State Management** – Persistent state storage using
  `systemState.json`.
- **Status API Endpoints** – `GET /status` and `POST /status` for state
  read/write operations.
- **GPT Integration with Backend Sync** – `services/gptSync.ts` fetches backend
  state before issuing diagnostics against the API.
- **Seamless Integration** – Additive changes that do not require additional
  scripts or binaries.

## Key Components

### `src/services/stateManager.ts`
```typescript
loadState(): SystemState
updateState(data: Partial<SystemState>): SystemState
getBackendState(port?: number): Promise<SystemState>
```
- Stores state in `systemState.json` at the repository root.
- Automatically timestamps updates via the `lastSync` field.
- Falls back to the file snapshot when HTTP retrieval fails.

### `src/routes/status.ts`
```http
GET  /status  # Retrieve current system state
POST /status  # Update system state (requires x-confirmed: yes)
```
- Uses `confirmGate` to protect write operations.
- Returns validation errors for empty payloads or malformed data.

### `src/services/gptSync.ts`
```typescript
askGPTWithSync(prompt: string, port?: number): Promise<string>
runSystemDiagnostic(port?: number): Promise<string>
askGPTWithContext(prompt: string, context: string, port?: number): Promise<{
  response: string;
  backendState: SystemState;
  context: string;
}>;
```
- Ensures the latest state is fetched via `getBackendState()` before issuing an
  OpenAI request.
- Powers the post-boot diagnostic triggered in `src/server.ts`.

### Server integration (`src/server.ts`)
- Mounts the status router on the Express app.
- Calls `updateState()` after a successful boot to write the active port,
  environment, and start timestamp.
- Schedules `runSystemDiagnostic()` shortly after start-up.

## Usage Examples

### Read and update state
```bash
curl http://localhost:8080/status
curl -X POST http://localhost:8080/status \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"status":"running","customField":"value"}'
```

### Programmatic access
```typescript
import { loadState, updateState } from './dist/services/stateManager.js';

const currentState = loadState();
const newState = updateState({
  status: 'processing',
  lastChecked: new Date().toISOString()
});
```

### GPT sync diagnostic
```typescript
import { runSystemDiagnostic } from './dist/services/gptSync.js';

await runSystemDiagnostic(8080);
```

## Configuration

The implementation relies on the following environment variables:

| Variable | Description |
| --- | --- |
| `OPENAI_API_KEY` | Required for GPT-backed diagnostics. |
| `PORT` / `SERVER_URL` | Used to resolve the correct `/status` endpoint when the runtime port differs from the preferred port. |
| `BACKEND_STATUS_ENDPOINT` | Optional override for the status URL (defaults to `/status`). |

## Testing & Validation

- The Jest suite includes state management coverage in
  `tests/session-memory-roundtrip.test.ts` and related specs.
- `npm test` is sufficient to validate the backend sync pipeline in CI.
- `npm run build && npm start` confirms that `systemState.json` is seeded and the
  diagnostic executes without crashing.

## Error Handling

- Missing or malformed payloads on `POST /status` return HTTP 400 with guidance.
- HTTP fetch failures in `getBackendState()` log the error and fall back to the
  file snapshot.
- `runSystemDiagnostic()` catches diagnostic failures so startup continues while
  surfacing errors in the log.

## File Structure

```
src/
├── routes/
│   └── status.ts                # /status endpoints
├── services/
│   ├── stateManager.ts          # State persistence & synchronization
│   └── gptSync.ts               # GPT integration with backend sync
└── server.ts                    # Startup integration and diagnostics
```

These components keep the backend state synchronized for both manual and GPT
clients without relying on external scripts or one-off runners.

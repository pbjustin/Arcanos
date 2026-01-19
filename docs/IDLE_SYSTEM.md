# IDLE System Documentation

## Overview
The IDLE system determines when the backend can be treated as idle and adjusts behavior based on activity and memory usage. It provides:

- Memory-aware idle detection (RSS + heap growth) to avoid sleeping under load.
- Dynamic idle timeouts that adapt to traffic rate.
- Optional OpenAI request batching + caching to deduplicate requests.
- Periodic idle state monitoring that updates the system state for diagnostics.

## Core Components

### 1) Idle Manager (`src/utils/idleManager.ts`)
The idle manager is the core logic engine. It tracks traffic, memory usage, and derives an "idle" decision.

**Key responsibilities**
- **Traffic tracking**: `noteTraffic()` records activity and updates a smoothed traffic rate (EWMA).
- **Dynamic timeouts**: idle timeout increases under higher traffic and decreases under low traffic.
- **Memory awareness**: RSS threshold + heap growth detection prevent idle decisions during memory growth.
- **OpenAI memoization**: `wrapOpenAI()` batches identical requests and caches responses.
- **Cleanup**: `destroy()` clears timers and cached data.

**Public API**
- `noteTraffic(meta?)`: Records traffic and updates the idle timeout heuristics.
- `isIdle()`: Returns `true` only if memory is stable, RSS is under threshold, and the idle timeout has elapsed.
- `wrapOpenAI(openai)`: Returns a client wrapper that batches and caches requests.
- `getStats()`: Returns diagnostic stats (idle timeout, traffic rate, memory growth state).
- `destroy()`: Stops batching and clears caches.

### 2) Idle State Service (`src/services/idleStateService.ts`)
This service runs periodic checks and updates the system state when transitions occur.

**Key responsibilities**
- **Monitoring loop**: calls `idleManager.isIdle()` on an interval.
- **State updates**: on transitions, calls `updateState()` with `idle` or `running`.
- **User activity**: `noteUserPing()` marks the system as running and refreshes activity.

**Public API**
- `noteUserPing(meta?)`: Records user activity to prevent idle transitions.
- `startMonitoring()`: Starts periodic idle checks.
- `stopMonitoring()`: Stops checks and destroys the idle manager.
- `getSnapshot()`: Returns the last known idle snapshot for diagnostics.

### 3) Server Integration (`src/server.ts`)
The server creates the idle state service, starts monitoring on boot, and stops it on shutdown.

### 4) API Integration (`src/routes/api-arcanos.ts`)
The `/ask` endpoint treats `ping` as user activity and calls `noteUserPing()`.

### 5) Cost Control Integration (`src/middleware/costControlMiddleware.ts`)
The cost control middleware uses idle state to adjust request rate limits and also records traffic
for idle heuristics.

## Configuration
The following environment variables control idle behavior:

| Variable | Default | Description |
| --- | --- | --- |
| `IDLE_MEMORY_THRESHOLD_MB` | `150` | RSS threshold before idle is disallowed |
| `MEMORY_GROWTH_WINDOW_MS` | `60000` | Interval to check heap growth |
| `INITIAL_IDLE_TIMEOUT_MS` | `30000` | Starting idle timeout |
| `MIN_IDLE_TIMEOUT_MS` | `10000` | Lower bound on idle timeout |
| `MAX_IDLE_TIMEOUT_MS` | `120000` | Upper bound on idle timeout |
| `EWMA_DECAY` | `0.85` | Smoothing factor for traffic rate |
| `OPENAI_CACHE_TTL_MS` | `60000` | Cache lifetime for OpenAI memoization |
| `OPENAI_BATCH_WINDOW_MS` | `150` | Batch window for OpenAI requests |
| `IDLE_CHECK_INTERVAL_MS` | `5000` | Idle check interval for the monitoring loop |

## Decision Flow (High-Level)
1. Traffic is recorded via `noteTraffic()` (requests, pings, or middleware).
2. `isIdle()` checks:
   - Memory growth over the last window.
   - RSS above threshold.
   - Time since last traffic exceeds the current idle timeout.
3. Idle state service updates system state when transitions occur.

## When to Keep or Disable
- **Keep it** if you want idle-aware throttling, memory-safe shutdowns, and request batching.
- **Disable it** if you want a permanently "active" server without idle heuristics.

## Minimal Test Plan
- **Happy path**: send traffic, verify `isIdle()` returns `false` until timeout passes.
- **Edge cases**: ensure `isIdle()` stays `false` when RSS is above threshold or heap grows quickly.
- **Failure modes**: verify idle state updates handle `updateState()` errors without crashing.

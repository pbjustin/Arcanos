import { randomUUID } from 'crypto';

interface MonotonicClockState {
  baseEpochMs: number;
  baseHrNs: bigint;
  lastTimestampMs: number;
  sequence: number;
}

const clockState: MonotonicClockState = {
  baseEpochMs: Date.now(),
  baseHrNs: process.hrtime.bigint(),
  lastTimestampMs: 0,
  sequence: 0
};

function computeMonotonicTimestampMs(): number {
  const elapsedNs = process.hrtime.bigint() - clockState.baseHrNs;
  const elapsedMs = Number(elapsedNs / 1_000_000n);
  return clockState.baseEpochMs + elapsedMs;
}

/**
 * Purpose: Return a process-monotonic timestamp in milliseconds.
 * Inputs/Outputs: No inputs; returns a monotonic numeric timestamp.
 * Edge cases: Ensures strict monotonic ordering even when wall clock stalls.
 */
export function getMonotonicTimestampMs(): number {
  const computed = computeMonotonicTimestampMs();
  //audit Assumption: monotonic timestamps must never move backwards; failure risk: version-order corruption; expected invariant: returned timestamp is strictly increasing; handling strategy: force increment when needed.
  if (computed <= clockState.lastTimestampMs) {
    clockState.lastTimestampMs += 1;
    return clockState.lastTimestampMs;
  }

  clockState.lastTimestampMs = computed;
  return computed;
}

/**
 * Purpose: Build a deterministic version identifier bound to monotonic time.
 * Inputs/Outputs: Optional prefix; returns unique version ID string.
 * Edge cases: Sequence counter prevents collisions within the same millisecond.
 */
export function createVersionId(prefix: string = 'version'): string {
  const monotonicTimestampMs = getMonotonicTimestampMs();
  clockState.sequence += 1;
  const entropy = randomUUID().slice(0, 8);
  return `${prefix}-${monotonicTimestampMs}-${clockState.sequence}-${entropy}`;
}

/**
 * Purpose: Produce both monotonic timestamp and version identifier together.
 * Inputs/Outputs: Optional prefix; returns { versionId, monotonicTimestampMs }.
 * Edge cases: Always derives version from the same monotonic tick.
 */
export function createVersionStamp(prefix: string = 'version'): {
  versionId: string;
  monotonicTimestampMs: number;
} {
  const monotonicTimestampMs = getMonotonicTimestampMs();
  clockState.sequence += 1;
  const entropy = randomUUID().slice(0, 8);
  return {
    versionId: `${prefix}-${monotonicTimestampMs}-${clockState.sequence}-${entropy}`,
    monotonicTimestampMs
  };
}


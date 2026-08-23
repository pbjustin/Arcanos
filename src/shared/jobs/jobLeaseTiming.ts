export const JOB_LEASE_MINIMUM_MS = 3_000;
export const JOB_LEASE_DEFAULT_MS = 15_000;
export const JOB_LEASE_MAXIMUM_MS = 300_000;
export const JOB_LEASE_HEARTBEAT_MINIMUM_MS = 1_000;
export const JOB_LEASE_HEARTBEAT_MAXIMUM_MS = 10_000;

export function normalizeJobLeaseMs(
  value: number,
  fallback = JOB_LEASE_DEFAULT_MS
): number {
  const normalized = Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
  return Math.max(
    JOB_LEASE_MINIMUM_MS,
    Math.min(JOB_LEASE_MAXIMUM_MS, normalized)
  );
}

/** Keep at least two renewal opportunities inside every live lease. */
export function resolveJobLeaseHeartbeatIntervalMs(leaseMs: number): number {
  const normalizedLeaseMs = normalizeJobLeaseMs(leaseMs);
  return Math.max(
    JOB_LEASE_HEARTBEAT_MINIMUM_MS,
    Math.min(
      JOB_LEASE_HEARTBEAT_MAXIMUM_MS,
      Math.floor(normalizedLeaseMs / 3)
    )
  );
}

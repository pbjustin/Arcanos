export const BACKSTAGE_NOTION_SNAPSHOT_STATUSES = [
  'current_complete',
  'last_known_good',
  'unavailable',
] as const;

export type BackstageNotionSnapshotStatus =
  (typeof BACKSTAGE_NOTION_SNAPSHOT_STATUSES)[number];

export const BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES = [
  'running',
  'activated',
  'unchanged',
  'failed',
] as const;

export type BackstageNotionSyncAttemptOutcome =
  (typeof BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES)[number];

export const BACKSTAGE_NOTION_SYNC_FAILURE_PHASES = [
  'authorization',
  'root_resolution',
  'discovery',
  'page_fetch',
  'block_fetch',
  'pagination',
  'normalization',
  'chunking',
  'embedding',
  'persistence',
  'completeness_validation',
  'activation',
  'cleanup',
  'deadline',
  'lease',
] as const;

export const BACKSTAGE_NOTION_SYNC_FAILURE_REASONS = [
  'deadline_exhausted',
  'rate_limit_exhausted',
  'transient_retry_exhausted',
  'permanent_notion_error',
  'inaccessible_page',
  'pagination_incomplete',
  'discovered_page_missing',
  'source_changed',
  'chunk_limit_reached',
  'embedding_failed',
  'persistence_failed',
  'completeness_mismatch',
  'activation_failed',
  'lease_lost',
  'invalid_configuration',
  'unexpected_failure',
] as const;

export type BackstageNotionSyncFailurePhase =
  (typeof BACKSTAGE_NOTION_SYNC_FAILURE_PHASES)[number];
export type BackstageNotionSyncFailureReason =
  (typeof BACKSTAGE_NOTION_SYNC_FAILURE_REASONS)[number];

export interface BackstageNotionLatestSyncAttemptState {
  attemptId: string;
  startedAt: Date;
  completedAt: Date | null;
  outcome: BackstageNotionSyncAttemptOutcome;
  activatedSnapshotId: string | null;
  failurePhase: BackstageNotionSyncFailurePhase | null;
  failureReason: BackstageNotionSyncFailureReason | null;
}

export interface BackstageNotionSnapshotStatusInput {
  activeSnapshotId: string | null;
  activeSnapshotReadable: boolean;
  activeSnapshotVerifiedAt: Date | null;
  now: Date;
  maximumStalenessMs: number;
  latestSyncAttempt: BackstageNotionLatestSyncAttemptState | null;
}

export interface BackstageNotionSnapshotStatusResolution {
  status: BackstageNotionSnapshotStatus;
  fresh: boolean;
  newerRefreshIncomplete: boolean;
}

const MAXIMUM_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SYNC_ATTEMPT_OUTCOMES = new Set<string>(
  BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES
);
const SYNC_FAILURE_PHASES = new Set<string>(BACKSTAGE_NOTION_SYNC_FAILURE_PHASES);
const SYNC_FAILURE_REASONS = new Set<string>(BACKSTAGE_NOTION_SYNC_FAILURE_REASONS);

function isFiniteDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Project active-snapshot availability independently from the latest refresh.
 * This function deliberately never upgrades an unreadable snapshot and never
 * describes a failed or incomplete newer refresh as current.
 */
export function resolveBackstageNotionSnapshotStatus(
  input: BackstageNotionSnapshotStatusInput
): BackstageNotionSnapshotStatusResolution {
  const nowMs = isFiniteDate(input.now) ? input.now.getTime() : Number.NaN;
  const verifiedAtMs = isFiniteDate(input.activeSnapshotVerifiedAt)
    ? input.activeSnapshotVerifiedAt.getTime()
    : Number.NaN;
  const validMaximumStaleness = Number.isSafeInteger(input.maximumStalenessMs)
    && input.maximumStalenessMs >= 0;
  if (
    typeof input.activeSnapshotId !== 'string'
    || !UUID_PATTERN.test(input.activeSnapshotId)
    || !input.activeSnapshotReadable
    || !Number.isFinite(nowMs)
    || !isFiniteDate(input.activeSnapshotVerifiedAt)
    || !validMaximumStaleness
    || verifiedAtMs - nowMs > MAXIMUM_CLOCK_SKEW_MS
  ) {
    return {
      status: 'unavailable',
      fresh: false,
      newerRefreshIncomplete: false,
    };
  }

  const fresh = nowMs - verifiedAtMs <= input.maximumStalenessMs;
  const latest = input.latestSyncAttempt;
  const latestStartedAtMs = latest && isFiniteDate(latest.startedAt)
    ? latest.startedAt.getTime()
    : Number.NaN;
  const latestCompletedAtMs = latest && isFiniteDate(latest.completedAt)
    ? latest.completedAt.getTime()
    : Number.NaN;
  const latestIsValid = latest === null || (
    typeof latest.attemptId === 'string'
    && UUID_PATTERN.test(latest.attemptId)
    && SYNC_ATTEMPT_OUTCOMES.has(latest.outcome)
    && Number.isFinite(latestStartedAtMs)
    && latestStartedAtMs - nowMs <= MAXIMUM_CLOCK_SKEW_MS
    && (latest.completedAt === null || (
      Number.isFinite(latestCompletedAtMs)
      && latestCompletedAtMs >= latestStartedAtMs
      && latestCompletedAtMs - nowMs <= MAXIMUM_CLOCK_SKEW_MS
    ))
    && (
      latest.outcome === 'running'
        ? latest.completedAt === null
          && latest.activatedSnapshotId === null
          && latest.failurePhase === null
          && latest.failureReason === null
        : latest.outcome === 'failed'
          ? latest.completedAt !== null
            && latest.activatedSnapshotId === null
            && typeof latest.failurePhase === 'string'
            && SYNC_FAILURE_PHASES.has(latest.failurePhase)
            && typeof latest.failureReason === 'string'
            && SYNC_FAILURE_REASONS.has(latest.failureReason)
          : latest.completedAt !== null
            && typeof latest.activatedSnapshotId === 'string'
            && UUID_PATTERN.test(latest.activatedSnapshotId)
            && latest.failurePhase === null
            && latest.failureReason === null
    )
  );
  if (!latestIsValid) {
    return {
      status: 'unavailable',
      fresh: false,
      newerRefreshIncomplete: false,
    };
  }

  const newerRefreshIncomplete = latest !== null
    && latestStartedAtMs >= verifiedAtMs
    && (latest.outcome === 'running' || latest.outcome === 'failed');
  const latestSuccessfulDifferentSnapshot = latest !== null
    && (latest.outcome === 'activated' || latest.outcome === 'unchanged')
    && latest.activatedSnapshotId !== input.activeSnapshotId;

  if (!fresh || newerRefreshIncomplete || latestSuccessfulDifferentSnapshot) {
    return {
      status: 'last_known_good',
      fresh,
      newerRefreshIncomplete,
    };
  }

  return {
    status: 'current_complete',
    fresh: true,
    newerRefreshIncomplete: false,
  };
}

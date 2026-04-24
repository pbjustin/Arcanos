import type {
  QueueLane,
  RetryState,
  SchedulerClaimDecision,
  SchedulerPolicy,
  SchedulerState
} from './types.js';

const DEFAULT_PRIORITY_QUEUE_WEIGHT = 5;
const DEFAULT_PRIORITY_LANE_MAX_PRIORITY = 10;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

export function buildSchedulerPolicy(input: Partial<SchedulerPolicy> = {}): SchedulerPolicy {
  return {
    priorityQueueEnabled: input.priorityQueueEnabled ?? true,
    priorityQueueWeight: normalizePositiveInteger(
      input.priorityQueueWeight,
      DEFAULT_PRIORITY_QUEUE_WEIGHT
    ),
    priorityLaneMaxPriority: normalizePositiveInteger(
      input.priorityLaneMaxPriority,
      DEFAULT_PRIORITY_LANE_MAX_PRIORITY
    )
  };
}

export function classifyQueueLane(input: {
  priority: number | undefined;
  priorityLaneMaxPriority?: number;
}): QueueLane {
  const priority = Number.isFinite(input.priority)
    ? Math.trunc(input.priority as number)
    : Number.MAX_SAFE_INTEGER;
  const priorityLaneMaxPriority = normalizePositiveInteger(
    input.priorityLaneMaxPriority,
    DEFAULT_PRIORITY_LANE_MAX_PRIORITY
  );

  return priority <= priorityLaneMaxPriority ? 'priority' : 'standard';
}

export function resolveSchedulerClaimLane(input: {
  policy?: Partial<SchedulerPolicy>;
  state?: Partial<SchedulerState>;
} = {}): SchedulerClaimDecision {
  const policy = buildSchedulerPolicy(input.policy);
  const priorityClaimsSinceStandard = Math.max(
    0,
    Math.trunc(input.state?.priorityClaimsSinceStandard ?? 0)
  );

  if (!policy.priorityQueueEnabled) {
    return {
      lane: 'priority',
      reason: 'priority_queue_disabled',
      priorityQueueWeight: policy.priorityQueueWeight,
      priorityClaimsSinceStandard
    };
  }

  if (priorityClaimsSinceStandard >= policy.priorityQueueWeight) {
    return {
      lane: 'standard',
      reason: 'standard_weight_due',
      priorityQueueWeight: policy.priorityQueueWeight,
      priorityClaimsSinceStandard
    };
  }

  return {
    lane: 'priority',
    reason: 'priority_weight_available',
    priorityQueueWeight: policy.priorityQueueWeight,
    priorityClaimsSinceStandard
  };
}

export function updateSchedulerClaimState(
  state: SchedulerState,
  claimedLane: QueueLane | null
): SchedulerState {
  if (!claimedLane) {
    return state;
  }

  if (claimedLane === 'priority') {
    return {
      priorityClaimsSinceStandard: Math.max(0, state.priorityClaimsSinceStandard) + 1
    };
  }

  return {
    priorityClaimsSinceStandard: 0
  };
}

export function shouldRetryJob(
  retryState: RetryState,
  maxRetries: number
): boolean {
  const attempts = Math.max(0, Math.trunc(retryState.attempts));
  const retryLimit = Math.max(0, Math.trunc(maxRetries));
  return attempts < retryLimit;
}

import {
  BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS,
  BACKSTAGE_GENERATION_STAGE_TIMEOUT_MAX_MS,
} from './backstageActionPolicy.js';

export const BACKSTAGE_CONTINUITY_OPERATION_TIMEOUT_MS = 45_000;
export const BACKSTAGE_CONTINUITY_MODEL_STAGE_TIMEOUT_DEFAULT_MS = 20_000;
export const BACKSTAGE_CONTINUITY_MODEL_STAGE_TIMEOUT_MAX_MS = 25_000;
export const BACKSTAGE_SYNC_OPERATION_TIMEOUT_MS = 55_000;
export const BACKSTAGE_WORKER_JOB_TIMEOUT_DEFAULT_MS = 180_000;
export const BACKSTAGE_WORKER_JOB_TIMEOUT_MIN_MS = 120_000;
export const BACKSTAGE_WORKER_JOB_TIMEOUT_MAX_MS = 180_000;
export const BACKSTAGE_WORKER_MODEL_STAGE_TIMEOUT_DEFAULT_MS = 80_000;
export const BACKSTAGE_WORKER_MODEL_STAGE_TIMEOUT_MIN_MS = 45_000;
export const BACKSTAGE_WORKER_MODEL_STAGE_TIMEOUT_MAX_MS = 90_000;
export const BACKSTAGE_WORKER_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS = 45_000;
export const BACKSTAGE_SYNC_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS = 10_000;
export const BACKSTAGE_CONTINUITY_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS = 15_000;
export const BACKSTAGE_WORKER_FINALIZATION_RESERVE_MS = 10_000;
export const BACKSTAGE_WORKER_ABORT_DRAIN_TIMEOUT_MS = 2_000;
export const BACKSTAGE_SYNC_FINALIZATION_RESERVE_MS = 5_000;
export const BACKSTAGE_HRC_STAGE_RESERVE_MS = 10_000;
export const BACKSTAGE_WORKER_ORCHESTRATION_RESERVE_MS = 30_000;
// The smallest supported direct-answer budget is 96 tokens. Reserving exactly
// that floor keeps compact one-item recovery available while still preventing
// a retry when no complete supported response can fit.
export const BACKSTAGE_RECOVERY_OUTPUT_TOKEN_RESERVE = 96;
export const BACKSTAGE_WORKER_RECOVERY_OUTPUT_TOKEN_RESERVE = 1_200;
export const BACKSTAGE_RESULT_POLL_WAIT_MS = 500;

export type BackstageExecutionBudgetProfile =
  | 'continuity_sync'
  | 'bounded_sync_generation'
  | 'queued_generation';

export type BackstageGenerationAction =
  | 'generateBooking'
  | 'generateBookingWithHRC';

export interface BackstageExecutionBudgetPolicy {
  profile: BackstageExecutionBudgetProfile;
  action: BackstageGenerationAction | 'queryContinuity';
  totalTimeoutMs: number;
  operationTimeoutMs: number;
  modelStageTimeoutMs: number;
  recoveryStageTimeoutMs: number;
  finalizationReserveMs: number;
  abortDrainTimeoutMs: number;
  hrcStageReserveMs: number;
  orchestrationReserveMs: number;
  recoveryOutputTokenReserve: number;
  maxRecoveryAttempts: 1;
  resultPollWaitMs: number;
}

export interface BackstageExecutionBudgetConfiguration {
  generationStageTimeoutMs?: number;
  continuityStageTimeoutMs?: number;
  workerJobTimeoutMs?: number;
  workerGenerationStageTimeoutMs?: number;
  workerRecoveryStageTimeoutMs?: number;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const normalized = typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
  return Math.max(minimum, Math.min(maximum, normalized));
}

/**
 * Resolve one finite timeout hierarchy without reading ambient configuration.
 * Every stage is constrained below its enclosing operation and a terminal
 * persistence reserve is never loaned to provider or recovery work.
 */
export function resolveBackstageExecutionBudgetPolicy(input: {
  profile: BackstageExecutionBudgetProfile;
  action?: BackstageGenerationAction | 'queryContinuity';
  configuration?: BackstageExecutionBudgetConfiguration;
}): BackstageExecutionBudgetPolicy {
  const configuration = input.configuration ?? {};

  if (input.profile === 'continuity_sync') {
    const finalizationReserveMs = BACKSTAGE_SYNC_FINALIZATION_RESERVE_MS;
    return {
      profile: input.profile,
      action: 'queryContinuity',
      totalTimeoutMs: BACKSTAGE_CONTINUITY_OPERATION_TIMEOUT_MS,
      operationTimeoutMs:
        BACKSTAGE_CONTINUITY_OPERATION_TIMEOUT_MS - finalizationReserveMs,
      modelStageTimeoutMs: clampInteger(
        configuration.continuityStageTimeoutMs,
        BACKSTAGE_CONTINUITY_MODEL_STAGE_TIMEOUT_DEFAULT_MS,
        1_000,
        BACKSTAGE_CONTINUITY_MODEL_STAGE_TIMEOUT_MAX_MS
      ),
      recoveryStageTimeoutMs: BACKSTAGE_CONTINUITY_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS,
      finalizationReserveMs,
      abortDrainTimeoutMs: 0,
      hrcStageReserveMs: 0,
      orchestrationReserveMs: 0,
      recoveryOutputTokenReserve: BACKSTAGE_RECOVERY_OUTPUT_TOKEN_RESERVE,
      maxRecoveryAttempts: 1,
      resultPollWaitMs: 0,
    };
  }

  if (input.profile === 'bounded_sync_generation') {
    const finalizationReserveMs = BACKSTAGE_SYNC_FINALIZATION_RESERVE_MS;
    const action = input.action === 'generateBookingWithHRC'
      ? 'generateBookingWithHRC'
      : 'generateBooking';
    const hrcStageReserveMs = action === 'generateBookingWithHRC'
      ? BACKSTAGE_HRC_STAGE_RESERVE_MS
      : 0;
    const operationTimeoutMs = BACKSTAGE_SYNC_OPERATION_TIMEOUT_MS - finalizationReserveMs;
    const maximumModelStageTimeoutMs = Math.min(
      BACKSTAGE_GENERATION_STAGE_TIMEOUT_MAX_MS,
      operationTimeoutMs
        - BACKSTAGE_SYNC_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS
        - hrcStageReserveMs
    );
    return {
      profile: input.profile,
      action,
      totalTimeoutMs: BACKSTAGE_SYNC_OPERATION_TIMEOUT_MS,
      operationTimeoutMs,
      modelStageTimeoutMs: clampInteger(
        configuration.generationStageTimeoutMs,
        BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS,
        1_000,
        maximumModelStageTimeoutMs
      ),
      recoveryStageTimeoutMs: BACKSTAGE_SYNC_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS,
      finalizationReserveMs,
      abortDrainTimeoutMs: 0,
      hrcStageReserveMs,
      orchestrationReserveMs: 0,
      recoveryOutputTokenReserve: BACKSTAGE_RECOVERY_OUTPUT_TOKEN_RESERVE,
      maxRecoveryAttempts: 1,
      resultPollWaitMs: 0,
    };
  }

  const action = input.action === 'generateBookingWithHRC'
    ? 'generateBookingWithHRC'
    : 'generateBooking';
  const totalTimeoutMs = clampInteger(
    configuration.workerJobTimeoutMs,
    BACKSTAGE_WORKER_JOB_TIMEOUT_DEFAULT_MS,
    BACKSTAGE_WORKER_JOB_TIMEOUT_MIN_MS,
    BACKSTAGE_WORKER_JOB_TIMEOUT_MAX_MS
  );
  const finalizationReserveMs = BACKSTAGE_WORKER_FINALIZATION_RESERVE_MS;
  const operationTimeoutMs = totalTimeoutMs - finalizationReserveMs;
  const hrcStageReserveMs = action === 'generateBookingWithHRC'
    ? BACKSTAGE_HRC_STAGE_RESERVE_MS
    : 0;
  const maximumRecoveryStageTimeoutMs = Math.max(
    BACKSTAGE_SYNC_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS,
    operationTimeoutMs
      - BACKSTAGE_WORKER_MODEL_STAGE_TIMEOUT_MIN_MS
      - hrcStageReserveMs
      - BACKSTAGE_WORKER_ORCHESTRATION_RESERVE_MS
  );
  const recoveryStageTimeoutMs = clampInteger(
    configuration.workerRecoveryStageTimeoutMs,
    BACKSTAGE_WORKER_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS,
    BACKSTAGE_SYNC_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS,
    Math.min(
      BACKSTAGE_WORKER_RECOVERY_STAGE_TIMEOUT_DEFAULT_MS,
      maximumRecoveryStageTimeoutMs
    )
  );
  const maximumModelStageTimeoutMs = Math.min(
    BACKSTAGE_WORKER_MODEL_STAGE_TIMEOUT_MAX_MS,
    operationTimeoutMs
      - recoveryStageTimeoutMs
      - hrcStageReserveMs
      - BACKSTAGE_WORKER_ORCHESTRATION_RESERVE_MS
  );

  return {
    profile: input.profile,
    action,
    totalTimeoutMs,
    operationTimeoutMs,
    modelStageTimeoutMs: clampInteger(
      configuration.workerGenerationStageTimeoutMs,
      BACKSTAGE_WORKER_MODEL_STAGE_TIMEOUT_DEFAULT_MS,
      BACKSTAGE_WORKER_MODEL_STAGE_TIMEOUT_MIN_MS,
      maximumModelStageTimeoutMs
    ),
    recoveryStageTimeoutMs,
    finalizationReserveMs,
    abortDrainTimeoutMs: BACKSTAGE_WORKER_ABORT_DRAIN_TIMEOUT_MS,
    hrcStageReserveMs,
    orchestrationReserveMs: BACKSTAGE_WORKER_ORCHESTRATION_RESERVE_MS,
    recoveryOutputTokenReserve: BACKSTAGE_WORKER_RECOVERY_OUTPUT_TOKEN_RESERVE,
    maxRecoveryAttempts: 1,
    resultPollWaitMs: BACKSTAGE_RESULT_POLL_WAIT_MS,
  };
}

export function hasBackstageRecoveryBudget(input: {
  policy: BackstageExecutionBudgetPolicy;
  runtimeRemainingMs: number;
  requestRemainingMs: number | null;
  remainingOutputTokens: number;
  recoveryAttempted: boolean;
}): boolean {
  if (input.recoveryAttempted) {
    return false;
  }
  if (
    !Number.isFinite(input.runtimeRemainingMs)
    || input.runtimeRemainingMs
      < input.policy.recoveryStageTimeoutMs + input.policy.hrcStageReserveMs
  ) {
    return false;
  }
  const requestRecoveryReserveMs = input.policy.recoveryStageTimeoutMs
    + input.policy.hrcStageReserveMs
    + (input.policy.profile === 'queued_generation'
      ? 0
      : input.policy.finalizationReserveMs);
  if (
    input.requestRemainingMs !== null
    && (
      !Number.isFinite(input.requestRemainingMs)
      || input.requestRemainingMs < requestRecoveryReserveMs
    )
  ) {
    return false;
  }
  return Number.isFinite(input.remainingOutputTokens)
    && input.remainingOutputTokens >= input.policy.recoveryOutputTokenReserve;
}

export function resolveBackstageWorkerOperationDeadlineAt(
  startedAt: Date | string | number | undefined,
  policy: BackstageExecutionBudgetPolicy,
  fallbackNowMs = Date.now()
): number {
  const parsedStartedAtMs = startedAt instanceof Date
    ? startedAt.getTime()
    : typeof startedAt === 'number'
      ? startedAt
      : typeof startedAt === 'string'
        ? Date.parse(startedAt)
        : Number.NaN;
  const anchorMs = Number.isFinite(parsedStartedAtMs)
    ? Math.trunc(parsedStartedAtMs)
    : Math.trunc(fallbackNowMs);
  return anchorMs + policy.operationTimeoutMs;
}

export function resolveBackstageProviderDeferralDelayMs(input: {
  deadlineAt: number;
  requestedDelayMs: number;
  nowMs?: number;
}): number | null {
  const nowMs = Number.isFinite(input.nowMs)
    ? Math.trunc(input.nowMs as number)
    : Date.now();
  const remainingMs = Math.trunc(input.deadlineAt) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return null;
  }
  const requestedDelayMs = Number.isFinite(input.requestedDelayMs)
    && input.requestedDelayMs > 0
    ? Math.trunc(input.requestedDelayMs)
    : 1;
  return requestedDelayMs < remainingMs ? requestedDelayMs : null;
}

import type { TrinityAnswerMode } from '@core/logic/trinityTypes.js';
import type { Tier } from '@core/logic/trinityTier.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';

export type TrinitySelfHealingStage = 'intake' | 'reasoning' | 'final';
export type TrinitySelfHealingAction = 'enable_degraded_mode' | 'bypass_final_stage';

export interface TrinitySelfHealingMitigationCommandResult {
  applied: boolean;
  rolledBack: boolean;
  stage: TrinitySelfHealingStage;
  action: TrinitySelfHealingAction | null;
  reason: string;
  activeAction: TrinitySelfHealingAction | null;
  verified: boolean;
  expiresAtMs: number | null;
}

type StageState = {
  observations: number[];
  attempts: number;
  activeAction: TrinitySelfHealingAction | null;
  activeSinceMs: number | null;
  expiresAtMs: number | null;
  verificationSuccesses: number;
  verificationFailures: number;
  verifiedAtMs: number | null;
  cooldownUntilMs: number | null;
  failedActions: TrinitySelfHealingAction[];
};

type MitigationSnapshot = {
  activeAction: TrinitySelfHealingAction | null;
  stage: TrinitySelfHealingStage | null;
  bypassFinalStage: boolean;
  forceDirectAnswer: boolean;
  verified: boolean;
};

const DEFAULT_TRIGGER_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_COOLDOWN_MS = 2 * 60_000;
const DEFAULT_ACTION_TTL_MS = 10 * 60_000;
const DEFAULT_VERIFY_SUCCESS_THRESHOLD = 3;
const DEFAULT_VERIFY_FAILURE_THRESHOLD = 2;

const ACTION_ORDER: Record<TrinitySelfHealingStage, TrinitySelfHealingAction[]> = {
  intake: ['enable_degraded_mode'],
  reasoning: ['enable_degraded_mode'],
  final: ['bypass_final_stage', 'enable_degraded_mode']
};

const stageState: Record<TrinitySelfHealingStage, StageState> = {
  intake: createStageState(),
  reasoning: createStageState(),
  final: createStageState()
};

function createStageState(): StageState {
  return {
    observations: [],
    attempts: 0,
    activeAction: null,
    activeSinceMs: null,
    expiresAtMs: null,
    verificationSuccesses: 0,
    verificationFailures: 0,
    verifiedAtMs: null,
    cooldownUntilMs: null,
    failedActions: []
  };
}

function getRuntimeConfig() {
  const cfg = getConfig();
  return {
    enabled:
      cfg.selfImproveEnabled &&
      cfg.selfImproveActuatorMode === 'daemon' &&
      cfg.selfImproveAutonomyLevel >= 3 &&
      !cfg.selfImproveFrozen,
    triggerThreshold: DEFAULT_TRIGGER_THRESHOLD,
    windowMs: DEFAULT_WINDOW_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    actionTtlMs: DEFAULT_ACTION_TTL_MS,
    verifySuccessThreshold: DEFAULT_VERIFY_SUCCESS_THRESHOLD,
    verifyFailureThreshold: DEFAULT_VERIFY_FAILURE_THRESHOLD
  };
}

function pruneWindow(values: number[], nowMs: number, windowMs: number): number[] {
  const cutoff = nowMs - windowMs;
  return values.filter((value) => value >= cutoff);
}

function expireActionIfNeeded(stage: TrinitySelfHealingStage, nowMs: number): void {
  const state = stageState[stage];
  if (state.expiresAtMs !== null && state.expiresAtMs <= nowMs) {
    logger.info('self_heal.v2.action_expired', {
      module: 'self_heal.v2',
      stage,
      action: state.activeAction,
      activeSinceMs: state.activeSinceMs,
      verifiedAtMs: state.verifiedAtMs
    });
    state.activeAction = null;
    state.activeSinceMs = null;
    state.expiresAtMs = null;
    state.verificationSuccesses = 0;
    state.verificationFailures = 0;
    state.verifiedAtMs = null;
  }
}

function applyAction(stage: TrinitySelfHealingStage, action: TrinitySelfHealingAction, nowMs: number, reason: string): TrinitySelfHealingAction {
  const cfg = getRuntimeConfig();
  const state = stageState[stage];
  state.activeAction = action;
  state.activeSinceMs = nowMs;
  state.expiresAtMs = nowMs + cfg.actionTtlMs;
  state.verificationSuccesses = 0;
  state.verificationFailures = 0;
  state.verifiedAtMs = null;
  state.attempts += 1;

  logger.warn('self_heal.v2.action_applied', {
    module: 'self_heal.v2',
    stage,
    action,
    attempts: state.attempts,
    reason,
    expectedOutcome:
      action === 'bypass_final_stage'
        ? 'Avoid final-stage aborts by returning the validated reasoning output in degraded mode.'
        : 'Avoid repeated Trinity stage aborts by forcing the lightweight direct-answer mode for simple traffic.'
  });

  return action;
}

function rollbackAction(stage: TrinitySelfHealingStage, nowMs: number, reason: string): void {
  const cfg = getRuntimeConfig();
  const state = stageState[stage];
  const action = state.activeAction;
  if (!action) {
    return;
  }

  if (!state.failedActions.includes(action)) {
    state.failedActions.push(action);
  }

  logger.warn('self_heal.v2.rollback', {
    module: 'self_heal.v2',
    stage,
    action,
    reason,
    verificationFailures: state.verificationFailures
  });

  state.activeAction = null;
  state.activeSinceMs = null;
  state.expiresAtMs = null;
  state.verificationSuccesses = 0;
  state.verificationFailures = 0;
  state.verifiedAtMs = null;
  state.cooldownUntilMs = nowMs + cfg.cooldownMs;
}

function nextActionForStage(stage: TrinitySelfHealingStage): TrinitySelfHealingAction | null {
  const state = stageState[stage];
  for (const candidate of ACTION_ORDER[stage]) {
    if (!state.failedActions.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildMitigationCommandResult(
  stage: TrinitySelfHealingStage,
  reason: string,
  params: {
    applied?: boolean;
    rolledBack?: boolean;
    action?: TrinitySelfHealingAction | null;
  } = {}
): TrinitySelfHealingMitigationCommandResult {
  const state = stageState[stage];
  return {
    applied: params.applied ?? false,
    rolledBack: params.rolledBack ?? false,
    stage,
    action: params.action ?? state.activeAction,
    reason,
    activeAction: state.activeAction,
    verified: state.verifiedAtMs !== null,
    expiresAtMs: state.expiresAtMs
  };
}

export function activateTrinitySelfHealingMitigation(params: {
  stage: TrinitySelfHealingStage;
  action: TrinitySelfHealingAction;
  reason: string;
}): TrinitySelfHealingMitigationCommandResult {
  const cfg = getRuntimeConfig();
  if (!cfg.enabled) {
    return buildMitigationCommandResult(params.stage, 'disabled');
  }

  if (!ACTION_ORDER[params.stage].includes(params.action)) {
    return buildMitigationCommandResult(params.stage, 'action_not_supported_for_stage', {
      action: params.action
    });
  }

  const nowMs = Date.now();
  const state = stageState[params.stage];
  expireActionIfNeeded(params.stage, nowMs);
  state.observations = pruneWindow(state.observations, nowMs, cfg.windowMs);

  if (state.activeAction === params.action) {
    return buildMitigationCommandResult(params.stage, 'already_active', {
      action: params.action
    });
  }

  if (state.attempts >= cfg.maxAttempts) {
    return buildMitigationCommandResult(params.stage, 'attempt_budget_exhausted', {
      action: params.action
    });
  }

  if (state.cooldownUntilMs !== null && state.cooldownUntilMs > nowMs) {
    return buildMitigationCommandResult(params.stage, 'cooldown_active', {
      action: params.action
    });
  }

  if (state.failedActions.includes(params.action)) {
    return buildMitigationCommandResult(params.stage, 'recently_failed', {
      action: params.action
    });
  }

  if (state.activeAction && state.activeAction !== params.action) {
    rollbackAction(params.stage, nowMs, 'superseded_by_operator_loop');
  }

  const appliedAction = applyAction(params.stage, params.action, nowMs, params.reason);
  return buildMitigationCommandResult(params.stage, 'applied', {
    applied: true,
    action: appliedAction
  });
}

export function rollbackTrinitySelfHealingMitigation(params: {
  stage: TrinitySelfHealingStage;
  reason: string;
  action?: TrinitySelfHealingAction | null;
}): TrinitySelfHealingMitigationCommandResult {
  const cfg = getRuntimeConfig();
  if (!cfg.enabled) {
    return buildMitigationCommandResult(params.stage, 'disabled', {
      action: params.action ?? null
    });
  }

  const nowMs = Date.now();
  const state = stageState[params.stage];
  expireActionIfNeeded(params.stage, nowMs);

  if (!state.activeAction) {
    return buildMitigationCommandResult(params.stage, 'no_active_action', {
      action: params.action ?? null
    });
  }

  if (params.action && state.activeAction !== params.action) {
    return buildMitigationCommandResult(params.stage, 'active_action_mismatch', {
      action: params.action
    });
  }

  const previousAction = state.activeAction;
  rollbackAction(params.stage, nowMs, params.reason);
  return buildMitigationCommandResult(params.stage, 'rolled_back', {
    rolledBack: true,
    action: previousAction
  });
}

export function recordTrinityStageFailure(params: {
  stage: TrinitySelfHealingStage;
  error: string;
  requestId: string;
  sourceEndpoint?: string;
}): TrinitySelfHealingAction | null {
  const cfg = getRuntimeConfig();
  if (!cfg.enabled) {
    return null;
  }

  const nowMs = Date.now();
  const state = stageState[params.stage];
  expireActionIfNeeded(params.stage, nowMs);
  state.observations = pruneWindow(state.observations, nowMs, cfg.windowMs);
  state.observations.push(nowMs);

  logger.warn('self_heal.v2.observed', {
    module: 'self_heal.v2',
    stage: params.stage,
    requestId: params.requestId,
    sourceEndpoint: params.sourceEndpoint,
    error: params.error,
    observationsInWindow: state.observations.length,
    activeAction: state.activeAction,
    attempts: state.attempts
  });

  if (state.activeAction) {
    state.verificationFailures += 1;
    logger.warn('self_heal.v2.verify', {
      module: 'self_heal.v2',
      stage: params.stage,
      action: state.activeAction,
      outcome: 'failure',
      verificationFailures: state.verificationFailures,
      verificationSuccesses: state.verificationSuccesses
    });

    if (state.verificationFailures >= cfg.verifyFailureThreshold) {
      rollbackAction(params.stage, nowMs, 'verification_failure_threshold_reached');
      const nextAction = nextActionForStage(params.stage);
      if (nextAction && state.attempts < cfg.maxAttempts) {
        return applyAction(
          params.stage,
          nextAction,
          nowMs,
          `Repeated ${params.stage} stage aborts persisted after the previous mitigation.`
        );
      }
    }

    return state.activeAction;
  }

  if (
    state.observations.length < cfg.triggerThreshold ||
    state.attempts >= cfg.maxAttempts ||
    (state.cooldownUntilMs !== null && state.cooldownUntilMs > nowMs)
  ) {
    return null;
  }

  const nextAction = nextActionForStage(params.stage);
  if (!nextAction) {
    return null;
  }

  return applyAction(
    params.stage,
    nextAction,
    nowMs,
    `Observed ${state.observations.length} ${params.stage} stage aborts within the verification window.`
  );
}

export function noteTrinityMitigationOutcome(params: {
  stage: TrinitySelfHealingStage;
  outcome: 'success' | 'failure';
  requestId: string;
  sourceEndpoint?: string;
  action?: TrinitySelfHealingAction | null;
}): void {
  const cfg = getRuntimeConfig();
  if (!cfg.enabled) {
    return;
  }

  const nowMs = Date.now();
  const state = stageState[params.stage];
  expireActionIfNeeded(params.stage, nowMs);
  const action = params.action ?? state.activeAction;
  if (!action || state.activeAction !== action) {
    return;
  }

  if (params.outcome === 'failure') {
    state.verificationFailures += 1;
  } else {
    state.verificationSuccesses += 1;
  }

  logger.info('self_heal.v2.verify', {
    module: 'self_heal.v2',
    stage: params.stage,
    action,
    outcome: params.outcome,
    requestId: params.requestId,
    sourceEndpoint: params.sourceEndpoint,
    verificationFailures: state.verificationFailures,
    verificationSuccesses: state.verificationSuccesses
  });

  if (state.verificationFailures >= cfg.verifyFailureThreshold) {
    rollbackAction(params.stage, nowMs, 'verification_failure_threshold_reached');
    return;
  }

  if (state.verificationSuccesses >= cfg.verifySuccessThreshold && state.verifiedAtMs === null) {
    state.verifiedAtMs = nowMs;
    logger.info('self_heal.v2.action_retained', {
      module: 'self_heal.v2',
      stage: params.stage,
      action,
      verifiedAtMs: state.verifiedAtMs,
      verificationSuccesses: state.verificationSuccesses
    });
  }
}

export function getTrinitySelfHealingMitigation(params: {
  tier: Tier;
  answerMode: TrinityAnswerMode;
}): MitigationSnapshot {
  const cfg = getRuntimeConfig();
  if (!cfg.enabled || params.tier !== 'simple') {
    return {
      activeAction: null,
      stage: null,
      bypassFinalStage: false,
      forceDirectAnswer: false,
      verified: false
    };
  }

  const nowMs = Date.now();
  expireActionIfNeeded('intake', nowMs);
  expireActionIfNeeded('reasoning', nowMs);
  expireActionIfNeeded('final', nowMs);

  const intakeState = stageState.intake;
  const reasoningState = stageState.reasoning;
  const finalState = stageState.final;
  const activeStage: TrinitySelfHealingStage | null =
    intakeState.activeAction !== null
      ? 'intake'
      : reasoningState.activeAction !== null
        ? 'reasoning'
        : finalState.activeAction !== null
          ? 'final'
          : null;

  const bypassFinalStage = finalState.activeAction === 'bypass_final_stage';
  const forceDirectAnswer =
    intakeState.activeAction === 'enable_degraded_mode' ||
    reasoningState.activeAction === 'enable_degraded_mode' ||
    finalState.activeAction === 'enable_degraded_mode';

  return {
    activeAction: intakeState.activeAction ?? reasoningState.activeAction ?? finalState.activeAction,
    stage: activeStage,
    bypassFinalStage,
    forceDirectAnswer,
    verified:
      intakeState.verifiedAtMs !== null ||
      reasoningState.verifiedAtMs !== null ||
      finalState.verifiedAtMs !== null
  };
}

export function getTrinitySelfHealingSnapshot() {
  const nowMs = Date.now();
  expireActionIfNeeded('intake', nowMs);
  expireActionIfNeeded('reasoning', nowMs);
  expireActionIfNeeded('final', nowMs);
  return {
    intake: { ...stageState.intake, failedActions: [...stageState.intake.failedActions] },
    reasoning: { ...stageState.reasoning, failedActions: [...stageState.reasoning.failedActions] },
    final: { ...stageState.final, failedActions: [...stageState.final.failedActions] }
  };
}

export function getTrinitySelfHealingStatus() {
  const cfg = getRuntimeConfig();
  return {
    enabled: cfg.enabled,
    config: {
      triggerThreshold: cfg.triggerThreshold,
      windowMs: cfg.windowMs,
      maxAttempts: cfg.maxAttempts,
      cooldownMs: cfg.cooldownMs,
      actionTtlMs: cfg.actionTtlMs,
      verifySuccessThreshold: cfg.verifySuccessThreshold,
      verifyFailureThreshold: cfg.verifyFailureThreshold
    },
    snapshot: getTrinitySelfHealingSnapshot()
  };
}

export function resetTrinitySelfHealingStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }

  stageState.intake = createStageState();
  stageState.reasoning = createStageState();
  stageState.final = createStageState();
}

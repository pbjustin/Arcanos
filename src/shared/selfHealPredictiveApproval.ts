export type PredictiveReactiveApprovalSource =
  | 'predictive_already_executed'
  | 'predictive_execution_uncertain'
  | 'predictive_disabled'
  | 'predictive_state_invalid'
  | 'deterministic_fallback'
  | 'authoritative_predictive_result';

export interface PredictiveReactiveApproval {
  allowLegacyReactiveEffects: boolean;
  source: PredictiveReactiveApprovalSource;
}

export interface PredictiveExecutionDisposition {
  action: string;
  attempted: boolean;
  decisionAction: string;
  decisionSafeToExecute: boolean;
  decisionTarget: string | null;
  mode: 'recommend_only' | 'dry_run' | 'operator_execute' | 'auto_execute';
  status:
    | 'skipped'
    | 'dry_run'
    | 'executed'
    | 'cooldown'
    | 'unsupported'
    | 'refused'
    | 'failed';
  target: string | null;
}

export interface SelfHealingEffectAuthorization {
  allowAutomaticController: boolean;
  allowReactiveAction: boolean;
}

/**
 * Resolve ownership between predictive execution and the legacy reactive path.
 *
 * This module is deliberately config-free and effect-free so both the runtime
 * loop and the contained PR-preview contract can execute the same policy.
 */
export function resolvePredictiveReactiveApproval(params: {
  predictiveHealingEnabled: boolean;
  predictiveFallback: boolean;
  execution: PredictiveExecutionDisposition;
}): PredictiveReactiveApproval {
  if (params.execution.status === 'executed') {
    const executionStateConsistent =
      params.execution.attempted &&
      (params.execution.mode === 'auto_execute' || params.execution.mode === 'operator_execute') &&
      params.execution.decisionAction !== 'none' &&
      params.execution.decisionSafeToExecute &&
      params.execution.action === params.execution.decisionAction &&
      params.execution.target === params.execution.decisionTarget;
    return executionStateConsistent
      ? {
          allowLegacyReactiveEffects: false,
          source: 'predictive_already_executed'
        }
      : {
          allowLegacyReactiveEffects: false,
          source: 'predictive_state_invalid'
        };
  }

  const automaticExecutionPhaseUncertain =
    params.execution.mode === 'auto_execute' || params.execution.mode === 'operator_execute';
  if (
    params.execution.attempted ||
    params.execution.status === 'failed' ||
    automaticExecutionPhaseUncertain
  ) {
    return {
      allowLegacyReactiveEffects: false,
      source: 'predictive_execution_uncertain'
    };
  }

  if (!params.predictiveHealingEnabled) {
    const passiveDisabledStatus =
      params.execution.mode === 'recommend_only' &&
      params.execution.status !== 'dry_run';
    return passiveDisabledStatus
      ? {
          allowLegacyReactiveEffects: true,
          source: 'predictive_disabled'
        }
      : {
          allowLegacyReactiveEffects: false,
          source: 'predictive_state_invalid'
        };
  }

  if (params.predictiveFallback) {
    return {
      allowLegacyReactiveEffects: false,
      source: 'deterministic_fallback'
    };
  }

  return {
    allowLegacyReactiveEffects: false,
    source: 'authoritative_predictive_result'
  };
}

export function resolveSelfHealingEffectAuthorization(params: {
  approval: PredictiveReactiveApproval;
  debugApprovalApplied: boolean;
  hasActionPlan: boolean;
}): SelfHealingEffectAuthorization {
  return {
    allowReactiveAction:
      params.hasActionPlan &&
      (params.approval.allowLegacyReactiveEffects || params.debugApprovalApplied),
    allowAutomaticController: params.approval.allowLegacyReactiveEffects
  };
}

export function isSelfHealingDebugOverrideEligible(params: {
  debugOverrideConsumed: boolean;
  debugOverrideRequested: boolean;
  hasActionPlan: boolean;
  nodeEnvironment: string | undefined;
}): boolean {
  const nodeEnvironment = params.nodeEnvironment?.trim().toLowerCase();
  return (
    (nodeEnvironment === 'development' || nodeEnvironment === 'test') &&
    params.debugOverrideRequested &&
    !params.debugOverrideConsumed &&
    params.hasActionPlan
  );
}

export function shouldRunSelfHealingController(params: {
  actionPresent: boolean;
  allowAutomaticController: boolean;
  automaticControllerConfigured: boolean;
  hasControllerInput: boolean;
  trigger: 'startup' | 'interval' | 'manual';
}): boolean {
  return (
    params.hasControllerInput &&
    (
      params.trigger === 'manual' ||
      (params.automaticControllerConfigured && params.allowAutomaticController)
    ) &&
    !params.actionPresent
  );
}

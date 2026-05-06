import {
  INTENT_CLARIFICATION_REQUIRED,
  type CapabilityRegistry,
  type DispatchRiskLevel,
  type DispatchPlan,
  type DispatchPolicyDecision,
  type DispatchRegistryAction
} from './types.js';
import { dispatchActionRequiresConfirmation } from './safety.js';

const PROHIBITED_ACTION_PATTERNS = [
  /\b(?:shell|terminal|exec|execute_command|raw[-_.]?sql|filesystem)\b/iu,
  /\b(?:deploy|restart|rollback|delete)\b/iu,
  /(?:^|[._:-])(?:sql[-_.]?(?:exec|execute|run|write|delete|mutate)|(?:exec|execute|run|write|delete|mutate)[-_.]?sql)(?:$|[._:-])/iu,
  /(?:^|[._:-])(?:proxy[-_.]?url|url[-_.]?proxy|file[-_.]?(?:access|system|write|delete)|(?:read|write|delete)[-_.]?file)(?:$|[._:-])/iu,
  /(?:^|[._:-])self[-_.]?heal(?:$|[._:-](?:run|execute|exec|apply|repair|restart|rollback|delete|mutate|write|fix)(?:$|[._:-]))/iu
];

function isProhibitedActionName(action: string): boolean {
  return PROHIBITED_ACTION_PATTERNS.some((pattern) => pattern.test(action));
}

function buildDecision(input: {
  status: DispatchPolicyDecision['status'];
  allowed: boolean;
  requiresConfirmation: boolean;
  shouldExecute: boolean;
  action: string;
  reason: string;
  code?: string;
  requiredScope?: string;
  registryAction?: DispatchRegistryAction;
}): DispatchPolicyDecision {
  return input;
}

export function getDispatchConfidenceThreshold(risk: DispatchRiskLevel): number {
  switch (risk) {
    case 'readonly':
      return 0.65;
    case 'privileged':
      return 0.78;
    case 'destructive':
      return 0.9;
  }
}

export function getDispatchClarificationBand(risk: DispatchRiskLevel): { min: number; max: number } | null {
  switch (risk) {
    case 'readonly':
      return { min: 0.55, max: 0.65 };
    case 'privileged':
      return { min: 0.7, max: 0.78 };
    case 'destructive':
      return null;
  }
}

export function evaluateDispatchPolicy(input: {
  plan: DispatchPlan;
  registry: CapabilityRegistry;
  confidenceThreshold?: number;
  isScopeAllowed?: (scope: string) => boolean;
  isModuleActionAllowed?: (moduleName: string, action: string) => boolean;
}): DispatchPolicyDecision {
  if (input.plan.action === INTENT_CLARIFICATION_REQUIRED) {
    return buildDecision({
      status: 'clarification_required',
      allowed: false,
      requiresConfirmation: false,
      shouldExecute: false,
      action: input.plan.action,
      reason: input.plan.reason ?? 'intent_clarification_required',
      code: INTENT_CLARIFICATION_REQUIRED
    });
  }

  const registryAction = input.registry.getAction(input.plan.action);
  if (!registryAction) {
    return buildDecision({
      status: 'blocked',
      allowed: false,
      requiresConfirmation: false,
      shouldExecute: false,
      action: input.plan.action,
      reason: 'dispatch_action_not_registered',
      code: 'DISPATCH_ACTION_NOT_REGISTERED'
    });
  }

  const threshold = input.confidenceThreshold ?? getDispatchConfidenceThreshold(registryAction.risk);
  if (input.plan.confidence < threshold) {
    const band = getDispatchClarificationBand(registryAction.risk);
    return buildDecision({
      status: 'clarification_required',
      allowed: false,
      requiresConfirmation: false,
      shouldExecute: false,
      action: input.plan.action,
      reason: band && input.plan.confidence >= band.min && input.plan.confidence < band.max
        ? 'dispatch_confidence_in_clarification_band'
        : 'dispatch_confidence_below_threshold',
      code: INTENT_CLARIFICATION_REQUIRED,
      registryAction
    });
  }

  if (registryAction.risk === 'destructive' || isProhibitedActionName(registryAction.action)) {
    return buildDecision({
      status: 'blocked',
      allowed: false,
      requiresConfirmation: false,
      shouldExecute: false,
      action: input.plan.action,
      reason: 'dispatch_action_prohibited',
      code: 'DISPATCH_ACTION_PROHIBITED',
      registryAction
    });
  }

  if (registryAction.requiredScope && input.isScopeAllowed && !input.isScopeAllowed(registryAction.requiredScope)) {
    return buildDecision({
      status: 'blocked',
      allowed: false,
      requiresConfirmation: false,
      shouldExecute: false,
      action: input.plan.action,
      reason: 'gpt_access_scope_denied',
      code: 'GPT_ACCESS_SCOPE_DENIED',
      requiredScope: registryAction.requiredScope,
      registryAction
    });
  }

  if (registryAction.runner.kind === 'gpt-access-capability' && input.isModuleActionAllowed) {
    const allowed = input.isModuleActionAllowed(
      registryAction.runner.capabilityId,
      registryAction.runner.capabilityAction
    );
    if (!allowed) {
      return buildDecision({
        status: 'blocked',
        allowed: false,
        requiresConfirmation: false,
        shouldExecute: false,
        action: input.plan.action,
        reason: 'module_action_not_allowlisted',
        code: 'GPT_ACCESS_CAPABILITY_ACTION_DENIED',
        requiredScope: registryAction.requiredScope,
        registryAction
      });
    }
  }

  const requiresConfirmation = dispatchActionRequiresConfirmation(
    registryAction,
    input.plan.requiresConfirmation
  );

  return buildDecision({
    status: requiresConfirmation ? 'confirmation_required' : 'allowed',
    allowed: true,
    requiresConfirmation,
    shouldExecute: !requiresConfirmation,
    action: input.plan.action,
    reason: requiresConfirmation ? 'confirmation_required' : 'policy_allowed',
    requiredScope: registryAction.requiredScope,
    registryAction
  });
}

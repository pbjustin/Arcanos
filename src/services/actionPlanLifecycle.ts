export const ACTION_PLAN_LIFECYCLE_STATUSES = [
  'planned',
  'awaiting_confirmation',
  'approved',
  'in_progress',
  'completed',
  'failed',
  'expired',
  'blocked',
] as const;

export type ActionPlanLifecycleStatus = typeof ACTION_PLAN_LIFECYCLE_STATUSES[number];
export type ActionPlanLifecycleOperation = 'approve' | 'execute' | 'block' | 'expire' | 'read';
export type ActionPlanPolicyKind = 'allow' | 'confirm' | 'block' | 'not_evaluated';
export type ActionPlanPolicyProvenance = 'stored_creation' | 'current_recheck' | 'daemon_wire' | 'operator';
export type ActionPlanExpiry = 'active' | 'elapsed' | 'invalid';
export type ActionPlanLifecycleClassification =
  | 'allowed'
  | 'recheck_required'
  | 'policy_blocked'
  | 'confirmation_required'
  | 'forbidden'
  | 'terminal'
  | 'invalid'
  | 'unavailable';

export interface ActionPlanLifecycleInput {
  statusPresent: boolean;
  status: unknown;
  operation: unknown;
  policyKind: unknown;
  policyProvenance: unknown;
  expiry: unknown;
}

export interface ActionPlanLifecycleResult {
  classification: ActionPlanLifecycleClassification;
  reasonCode: string;
  operationAllowed: boolean;
  policyRecheckAllowed: boolean;
  statusTransitionAllowed: boolean;
  targetStatus: ActionPlanLifecycleStatus | null;
}

export type ActionPlanLifecyclePublicCategory =
  | 'ACTION_PLAN_STATE_INVALID'
  | 'ACTION_PLAN_STATE_UNAVAILABLE'
  | 'ACTION_PLAN_TRANSITION_FORBIDDEN'
  | 'ACTION_PLAN_TERMINAL'
  | 'ACTION_PLAN_CONFIRMATION_REQUIRED'
  | 'ACTION_PLAN_POLICY_BLOCKED';

const RECOGNIZED_STATUSES = new Set<string>(ACTION_PLAN_LIFECYCLE_STATUSES);
const RECOGNIZED_OPERATIONS = new Set<string>(['approve', 'execute', 'block', 'expire', 'read']);
const RECOGNIZED_POLICY_KINDS = new Set<string>(['allow', 'confirm', 'block', 'not_evaluated']);
const RECOGNIZED_POLICY_PROVENANCE = new Set<string>([
  'stored_creation',
  'current_recheck',
  'daemon_wire',
  'operator',
]);
const HARD_TERMINAL_STATUSES = new Set<ActionPlanLifecycleStatus>(['completed', 'failed', 'expired']);

export function isActionPlanLifecycleStatus(value: unknown): value is ActionPlanLifecycleStatus {
  return typeof value === 'string' && RECOGNIZED_STATUSES.has(value);
}

function result(
  classification: ActionPlanLifecycleClassification,
  reasonCode: string,
  options: Partial<Pick<
    ActionPlanLifecycleResult,
    'operationAllowed' | 'policyRecheckAllowed' | 'statusTransitionAllowed' | 'targetStatus'
  >> = {},
): ActionPlanLifecycleResult {
  return {
    classification,
    reasonCode,
    operationAllowed: options.operationAllowed ?? false,
    policyRecheckAllowed: options.policyRecheckAllowed ?? false,
    statusTransitionAllowed: options.statusTransitionAllowed ?? false,
    targetStatus: options.targetStatus ?? null,
  };
}

function policyIsRecognized(kind: unknown, provenance: unknown): kind is ActionPlanPolicyKind {
  return typeof kind === 'string'
    && RECOGNIZED_POLICY_KINDS.has(kind)
    && typeof provenance === 'string'
    && RECOGNIZED_POLICY_PROVENANCE.has(provenance);
}

export function classifyActionPlanExpiry(expiresAt: unknown, nowEpochMs: number): ActionPlanExpiry {
  if (expiresAt === null || expiresAt === undefined) return 'active';
  if (!(expiresAt instanceof Date)) return 'invalid';

  const expiresAtEpochMs = expiresAt.getTime();
  if (!Number.isFinite(expiresAtEpochMs) || !Number.isFinite(nowEpochMs)) return 'invalid';
  return expiresAtEpochMs <= nowEpochMs ? 'elapsed' : 'active';
}

export function actionPlanLifecyclePublicCategory(
  lifecycle: ActionPlanLifecycleResult,
): ActionPlanLifecyclePublicCategory {
  if (lifecycle.reasonCode === 'lifecycle_blocked') {
    return 'ACTION_PLAN_POLICY_BLOCKED';
  }
  switch (lifecycle.classification) {
    case 'unavailable':
      return 'ACTION_PLAN_STATE_UNAVAILABLE';
    case 'invalid':
      return 'ACTION_PLAN_STATE_INVALID';
    case 'terminal':
      return 'ACTION_PLAN_TERMINAL';
    case 'confirmation_required':
      return 'ACTION_PLAN_CONFIRMATION_REQUIRED';
    case 'policy_blocked':
      return 'ACTION_PLAN_POLICY_BLOCKED';
    case 'allowed':
    case 'recheck_required':
    case 'forbidden':
      return 'ACTION_PLAN_TRANSITION_FORBIDDEN';
  }
}

export function evaluateActionPlanLifecycle(
  input: ActionPlanLifecycleInput,
): ActionPlanLifecycleResult {
  if (!input.statusPresent) {
    return result('unavailable', 'state_missing');
  }
  if (typeof input.status !== 'string') {
    return result('invalid', 'state_invalid');
  }
  if (!RECOGNIZED_STATUSES.has(input.status)) {
    return result('invalid', 'state_unknown');
  }
  if (typeof input.operation !== 'string' || !RECOGNIZED_OPERATIONS.has(input.operation)) {
    return result('invalid', 'operation_unknown');
  }

  const status = input.status as ActionPlanLifecycleStatus;
  const operation = input.operation as ActionPlanLifecycleOperation;

  if (operation === 'read') {
    return result('allowed', 'read_allowed', { operationAllowed: true });
  }

  if (!policyIsRecognized(input.policyKind, input.policyProvenance)) {
    return result('invalid', 'policy_invalid');
  }
  if (input.expiry !== 'active' && input.expiry !== 'elapsed' && input.expiry !== 'invalid') {
    return result('invalid', 'expiry_invalid');
  }

  if (status === 'expired' && operation === 'expire') {
    if (input.policyKind !== 'not_evaluated' || input.policyProvenance !== 'operator') {
      return result('invalid', 'policy_operation_conflict');
    }
    return result('allowed', 'already_expired', {
      operationAllowed: true,
      targetStatus: 'expired',
    });
  }

  if (status === 'blocked' && operation === 'block') {
    if (input.policyKind === 'block'
      && (input.policyProvenance === 'stored_creation'
        || input.policyProvenance === 'current_recheck'
        || input.policyProvenance === 'daemon_wire')) {
      return result('policy_blocked', 'already_blocked', {
        operationAllowed: true,
        targetStatus: 'blocked',
      });
    }
    if (input.policyKind === 'not_evaluated' && input.policyProvenance === 'operator') {
      return result('allowed', 'already_blocked', {
        operationAllowed: true,
        targetStatus: 'blocked',
      });
    }
    return result('invalid', 'policy_operation_conflict');
  }

  if (HARD_TERMINAL_STATUSES.has(status)) {
    return result('terminal', 'terminal_state');
  }

  if (input.expiry === 'invalid') {
    return result('invalid', 'expiry_invalid');
  }
  if ((operation === 'execute' || operation === 'approve') && input.expiry === 'elapsed') {
    return result('terminal', 'expiry_elapsed');
  }

  const policyKind = input.policyKind;
  const policyProvenance = input.policyProvenance as ActionPlanPolicyProvenance;

  if (status === 'blocked') {
    if (operation === 'execute') {
      if (policyProvenance === 'stored_creation') {
        return result('forbidden', 'lifecycle_blocked');
      }
      if ((policyProvenance === 'current_recheck' || policyProvenance === 'daemon_wire')
        && (policyKind === 'allow' || policyKind === 'confirm')) {
        return result('invalid', 'blocked_current_policy_conflict');
      }
    }
    return result(
      'forbidden',
      operation === 'execute' ? 'lifecycle_blocked' : 'blocked_transition_forbidden',
    );
  }

  if (operation === 'approve') {
    if (policyProvenance !== 'stored_creation') {
      return result('invalid', 'policy_provenance_invalid');
    }
    if (policyKind === 'block') {
      return result('policy_blocked', 'creation_policy_block');
    }
    if (status !== 'planned' && status !== 'awaiting_confirmation') {
      return result('forbidden', 'approval_forbidden');
    }
    return result('allowed', 'approval_allowed', {
      operationAllowed: true,
      statusTransitionAllowed: true,
      targetStatus: 'approved',
    });
  }

  if (operation === 'expire') {
    if (policyKind !== 'not_evaluated' || policyProvenance !== 'operator') {
      return result('invalid', 'policy_invalid');
    }
    if (status !== 'planned' && status !== 'awaiting_confirmation' && status !== 'approved') {
      return result('forbidden', 'expiry_forbidden');
    }
    return result('allowed', 'expiry_allowed', {
      operationAllowed: true,
      statusTransitionAllowed: true,
      targetStatus: 'expired',
    });
  }

  if (operation === 'block') {
    if (policyKind === 'not_evaluated' && policyProvenance === 'operator') {
      return result('allowed', 'operator_block_allowed', {
        operationAllowed: true,
        statusTransitionAllowed: true,
        targetStatus: 'blocked',
      });
    }
    if (policyKind === 'block'
      && (policyProvenance === 'current_recheck'
        || policyProvenance === 'daemon_wire')) {
      return result('policy_blocked', 'current_policy_block', {
        operationAllowed: true,
        statusTransitionAllowed: true,
        targetStatus: 'blocked',
      });
    }
    return result('invalid', 'policy_operation_conflict');
  }

  if (status === 'planned') {
    return result('forbidden', 'approval_required');
  }
  if (status === 'awaiting_confirmation') {
    return result('confirmation_required', 'durable_approval_required');
  }
  if (status === 'in_progress') {
    return result('forbidden', 'execution_in_progress');
  }

  if (policyProvenance === 'stored_creation') {
    if (policyKind === 'block') {
      return result('invalid', 'stored_policy_conflict');
    }
    return result('recheck_required', 'fresh_recheck_required', {
      policyRecheckAllowed: true,
    });
  }

  if ((policyProvenance === 'current_recheck' || policyProvenance === 'daemon_wire')
    && (policyKind === 'allow' || policyKind === 'confirm')) {
    return result('allowed', 'execution_allowed', { operationAllowed: true });
  }

  if ((policyProvenance === 'current_recheck' || policyProvenance === 'daemon_wire')
    && policyKind === 'block') {
    return result('invalid', 'policy_operation_conflict');
  }

  return result('invalid', 'policy_operation_conflict');
}

export interface SelfHealOperatorApproval {
  approved?: boolean;
  approvedBy?: string | null;
  reason?: string | null;
}

export interface SelfHealOperatorApprovalDecision {
  required: boolean;
  satisfied: boolean;
  gate: 'none' | 'self-heal-operator-approval';
  reason: string | null;
  approvedBy: string | null;
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|approved)$/i.test(value?.trim() ?? '');
}

export function readSelfHealOperatorApprovalFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SelfHealOperatorApproval | undefined {
  const approved = env.SELF_HEAL_OPERATOR_ACTION_APPROVED;
  const approvedBy = env.SELF_HEAL_OPERATOR_ACTION_APPROVED_BY;
  const reason = env.SELF_HEAL_OPERATOR_ACTION_REASON;

  if (approved === undefined && approvedBy === undefined && reason === undefined) {
    return undefined;
  }

  return {
    approved: readBoolean(approved),
    approvedBy,
    reason
  };
}

export function evaluateSelfHealOperatorApproval(params: {
  action: string;
  required: boolean;
  approval?: SelfHealOperatorApproval;
  env?: NodeJS.ProcessEnv;
}): SelfHealOperatorApprovalDecision {
  if (!params.required) {
    return {
      required: false,
      satisfied: true,
      gate: 'none',
      reason: null,
      approvedBy: null
    };
  }

  const approval = params.approval ?? readSelfHealOperatorApprovalFromEnv(params.env);
  const approvedBy = normalizeText(approval?.approvedBy);
  const reason = normalizeText(approval?.reason);
  const satisfied = approval?.approved === true && approvedBy.length > 0 && reason.length > 0;

  return {
    required: true,
    satisfied,
    gate: 'self-heal-operator-approval',
    reason: satisfied
      ? reason
      : `${params.action} requires explicit operator approval with approved=true, approvedBy, and reason.`,
    approvedBy: approvedBy || null
  };
}

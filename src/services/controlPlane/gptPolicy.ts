import type {
  ControlPlaneApprovalTrigger,
  ControlPlaneDeniedCapability,
  ControlPlaneGptPolicy,
  ControlPlaneGptPolicyDecision,
  ControlPlaneWorkflow,
} from './types.js';

export const ARCANOS_CORE_GPT_ID = 'arcanos-core';

const ARCANOS_CORE_ALLOWED_WORKFLOWS: ControlPlaneWorkflow[] = [
  'control_plane.inspect',
  'control_plane.route.trinity.request',
  'control_plane.route.verify',
  'railway.cli.readonly',
  'railway.cli.approved_mutation',
  'arcanos.cli.readonly',
  'arcanos.cli.approved_mutation',
  'arcanos.mcp.documented_tools',
];

const ARCANOS_CORE_DENIED_CAPABILITIES: ControlPlaneDeniedCapability[] = [
  'auth.bypass',
  'credential.escalation',
  'secrets.read.raw',
  'audit.disable',
  'production.mutate.unapproved',
  'destructive.unapproved',
  'mcp.undocumented_tools',
];

const ARCANOS_CORE_APPROVAL_TRIGGERS: ControlPlaneApprovalTrigger[] = [
  'deploy',
  'rollback',
  'delete',
  'secret_change',
  'production_mutation',
  'service_restart',
  'agent_reset',
  'permission_change',
];

export const ARCANOS_CORE_CONTROL_PLANE_POLICY: ControlPlaneGptPolicy = Object.freeze({
  gptId: ARCANOS_CORE_GPT_ID,
  label: 'ARCANOS Core Custom GPT',
  enabled: true,
  allowedWorkflows: ARCANOS_CORE_ALLOWED_WORKFLOWS,
  deniedCapabilities: ARCANOS_CORE_DENIED_CAPABILITIES,
  requiresApprovalFor: ARCANOS_CORE_APPROVAL_TRIGGERS,
  requiresAuditLog: true,
  requiresSecretRedaction: true,
  requiresRouteVerification: true,
});

export const DEFAULT_CONTROL_PLANE_GPT_POLICIES: readonly ControlPlaneGptPolicy[] = Object.freeze([
  ARCANOS_CORE_CONTROL_PLANE_POLICY,
]);

function normalizeGptId(gptId: string): string {
  return gptId.trim().toLowerCase();
}

function workflowRequiresGptIdentity(workflow: ControlPlaneWorkflow): boolean {
  return workflow === 'control_plane.route.trinity.request' || workflow === 'control_plane.route.verify';
}

function buildDeniedDecision(params: {
  gptId: string | null;
  reason: string;
  workflow?: ControlPlaneWorkflow;
  policy?: ControlPlaneGptPolicy;
}): ControlPlaneGptPolicyDecision {
  return {
    ok: false,
    gptId: params.gptId,
    whitelisted: false,
    ...(params.workflow ? { workflow: params.workflow } : {}),
    ...(params.policy?.label ? { label: params.policy.label } : {}),
    reason: params.reason,
    deniedCapabilities: params.policy?.deniedCapabilities ?? [],
    requiresApprovalFor: params.policy?.requiresApprovalFor ?? [],
    requiresAuditLog: params.policy?.requiresAuditLog ?? true,
    requiresSecretRedaction: params.policy?.requiresSecretRedaction ?? true,
    requiresRouteVerification: params.policy?.requiresRouteVerification ?? true,
  };
}

export function findControlPlaneGptPolicy(
  gptId: string,
  policies: readonly ControlPlaneGptPolicy[] = DEFAULT_CONTROL_PLANE_GPT_POLICIES
): ControlPlaneGptPolicy | undefined {
  const normalized = normalizeGptId(gptId);
  return policies.find((policy) => normalizeGptId(policy.gptId) === normalized);
}

export function evaluateControlPlaneGptPolicy(params: {
  gptId?: string;
  workflow: ControlPlaneWorkflow;
  requestedCapability?: ControlPlaneDeniedCapability;
  policies?: readonly ControlPlaneGptPolicy[];
}): ControlPlaneGptPolicyDecision {
  const normalizedGptId = typeof params.gptId === 'string' && params.gptId.trim().length > 0
    ? params.gptId.trim()
    : null;

  if (!normalizedGptId) {
    if (workflowRequiresGptIdentity(params.workflow)) {
      return buildDeniedDecision({
        gptId: null,
        workflow: params.workflow,
        reason: 'gpt_identity_required_for_workflow',
      });
    }

    return {
      ok: true,
      gptId: null,
      whitelisted: false,
      workflow: params.workflow,
      reason: 'no_gpt_context',
      deniedCapabilities: [],
      requiresApprovalFor: [],
      requiresAuditLog: true,
      requiresSecretRedaction: true,
      requiresRouteVerification: true,
    };
  }

  const policy = findControlPlaneGptPolicy(normalizedGptId, params.policies);
  if (!policy) {
    return buildDeniedDecision({
      gptId: normalizedGptId,
      workflow: params.workflow,
      reason: 'gpt_not_control_plane_whitelisted',
    });
  }

  if (!policy.enabled) {
    return buildDeniedDecision({
      gptId: normalizedGptId,
      workflow: params.workflow,
      reason: 'gpt_control_plane_policy_disabled',
      policy,
    });
  }

  if (params.requestedCapability && policy.deniedCapabilities.includes(params.requestedCapability)) {
    return buildDeniedDecision({
      gptId: normalizedGptId,
      workflow: params.workflow,
      reason: `capability_denied:${params.requestedCapability}`,
      policy,
    });
  }

  if (!policy.allowedWorkflows.includes(params.workflow)) {
    return buildDeniedDecision({
      gptId: normalizedGptId,
      workflow: params.workflow,
      reason: 'workflow_not_allowed_for_gpt',
      policy,
    });
  }

  return {
    ok: true,
    gptId: normalizedGptId,
    whitelisted: true,
    workflow: params.workflow,
    label: policy.label,
    reason: 'gpt_control_plane_whitelisted',
    deniedCapabilities: [...policy.deniedCapabilities],
    requiresApprovalFor: [...policy.requiresApprovalFor],
    requiresAuditLog: policy.requiresAuditLog,
    requiresSecretRedaction: policy.requiresSecretRedaction,
    requiresRouteVerification: policy.requiresRouteVerification,
  };
}

import type { Request } from 'express';
import type {
  ControlPlaneInvokeRequestPayload,
  ControlPlaneInvokeResponseData,
  ControlPlaneProvider,
} from '@arcanos/protocol';

export type { ControlPlaneProvider };

export type ControlPlaneRequest = ControlPlaneInvokeRequestPayload & {
  dryRun: boolean;
};

export type ControlPlaneApprovalStatus =
  | 'not_required'
  | 'approved'
  | 'missing'
  | 'invalid'
  | 'unconfigured';

export interface ControlPlaneCommandPlan {
  executable: string;
  args: string[];
  displayCommand: string;
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ControlPlaneCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string | null;
  durationMs: number;
}

export interface ControlPlaneCommandRunner {
  run(plan: ControlPlaneCommandPlan): Promise<ControlPlaneCommandResult>;
}

export interface ControlPlaneMcpService {
  invokeTool(options: {
    toolName: string;
    toolArguments?: Record<string, unknown>;
    request?: Request;
    sessionId?: string;
  }): Promise<Record<string, unknown>>;
  listTools(options?: {
    request?: Request;
    sessionId?: string;
  }): Promise<Record<string, unknown>>;
}

export type ControlPlaneOperationKind =
  | 'command'
  | 'mcp-list-tools'
  | 'mcp-invoke'
  | 'backend-health'
  | 'route-trinity-request'
  | 'route-verify';

export interface ControlPlaneOperationSpecBase {
  operation: string;
  provider: ControlPlaneProvider;
  description: string;
  kind: ControlPlaneOperationKind;
  workflow: ControlPlaneWorkflow;
  requiredScopes: string[];
  readOnly: boolean;
  approvalRequired?: boolean;
}

export interface ControlPlaneCommandOperationSpec extends ControlPlaneOperationSpecBase {
  kind: 'command';
  buildCommand(request: ControlPlaneRequest): ControlPlaneCommandPlan;
}

export interface ControlPlaneMcpListToolsOperationSpec extends ControlPlaneOperationSpecBase {
  kind: 'mcp-list-tools';
}

export interface ControlPlaneMcpInvokeOperationSpec extends ControlPlaneOperationSpecBase {
  kind: 'mcp-invoke';
  resolveToolName(request: ControlPlaneRequest): string;
  buildToolArguments(request: ControlPlaneRequest): Record<string, unknown>;
}

export interface ControlPlaneBackendHealthOperationSpec extends ControlPlaneOperationSpecBase {
  kind: 'backend-health';
}

export interface ControlPlaneRouteTrinityRequestOperationSpec extends ControlPlaneOperationSpecBase {
  kind: 'route-trinity-request';
}

export interface ControlPlaneRouteVerifyOperationSpec extends ControlPlaneOperationSpecBase {
  kind: 'route-verify';
}

export type ControlPlaneOperationSpec =
  | ControlPlaneCommandOperationSpec
  | ControlPlaneMcpListToolsOperationSpec
  | ControlPlaneMcpInvokeOperationSpec
  | ControlPlaneBackendHealthOperationSpec
  | ControlPlaneRouteTrinityRequestOperationSpec
  | ControlPlaneRouteVerifyOperationSpec;

export interface ControlPlaneAllowlistView {
  operation: string;
  provider: ControlPlaneProvider;
  description: string;
  kind: ControlPlaneOperationKind;
  workflow: ControlPlaneWorkflow;
  requiredScopes: string[];
  readOnly: boolean;
  approvalRequired: boolean;
}

export type ControlPlaneWorkflow =
  | 'control_plane.inspect'
  | 'control_plane.route.trinity.request'
  | 'control_plane.route.verify'
  | 'railway.cli.readonly'
  | 'railway.cli.approved_mutation'
  | 'arcanos.cli.readonly'
  | 'arcanos.cli.approved_mutation'
  | 'arcanos.mcp.documented_tools'
  | 'codex.ide.readonly'
  | 'codex.ide.verify';

export type ControlPlaneDeniedCapability =
  | 'auth.bypass'
  | 'credential.escalation'
  | 'secrets.read.raw'
  | 'audit.disable'
  | 'production.mutate.unapproved'
  | 'destructive.unapproved'
  | 'mcp.undocumented_tools';

export type ControlPlaneApprovalTrigger =
  | 'deploy'
  | 'rollback'
  | 'delete'
  | 'secret_change'
  | 'production_mutation'
  | 'service_restart'
  | 'agent_reset'
  | 'permission_change';

export interface ControlPlaneGptPolicy {
  gptId: string;
  label: string;
  enabled: boolean;
  allowedWorkflows: ControlPlaneWorkflow[];
  deniedCapabilities: ControlPlaneDeniedCapability[];
  requiresApprovalFor: ControlPlaneApprovalTrigger[];
  requiresAuditLog: boolean;
  requiresSecretRedaction: boolean;
  requiresRouteVerification: boolean;
}

export interface ControlPlaneGptPolicyDecision {
  ok: boolean;
  gptId: string | null;
  whitelisted: boolean;
  workflow?: ControlPlaneWorkflow;
  label?: string;
  reason: string;
  deniedCapabilities: ControlPlaneDeniedCapability[];
  requiresApprovalFor: ControlPlaneApprovalTrigger[];
  requiresAuditLog: boolean;
  requiresSecretRedaction: boolean;
  requiresRouteVerification: boolean;
}

export interface ExecuteControlPlaneOperationOptions {
  request?: Request;
  commandRunner?: ControlPlaneCommandRunner;
  mcpService?: ControlPlaneMcpService;
  healthCheck?: () => unknown;
  approvalTokenReader?: () => string | undefined;
  auditEmitter?: (event: ControlPlaneAuditEvent) => void;
  gptPolicies?: readonly ControlPlaneGptPolicy[];
}

export interface ControlPlaneAuditEvent {
  auditId: string;
  status: 'accepted' | 'denied' | 'failed';
  operation: string;
  provider: string;
  environment: string;
  traceId: string;
  requestedBy: string;
  approvalStatus: ControlPlaneApprovalStatus;
  dryRun: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export type ControlPlaneResponse = ControlPlaneInvokeResponseData;

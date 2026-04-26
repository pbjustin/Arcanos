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
  | 'backend-health';

export interface ControlPlaneOperationSpecBase {
  operation: string;
  provider: ControlPlaneProvider;
  description: string;
  kind: ControlPlaneOperationKind;
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

export type ControlPlaneOperationSpec =
  | ControlPlaneCommandOperationSpec
  | ControlPlaneMcpListToolsOperationSpec
  | ControlPlaneMcpInvokeOperationSpec
  | ControlPlaneBackendHealthOperationSpec;

export interface ControlPlaneAllowlistView {
  operation: string;
  provider: ControlPlaneProvider;
  description: string;
  kind: ControlPlaneOperationKind;
  requiredScopes: string[];
  readOnly: boolean;
  approvalRequired: boolean;
}

export interface ExecuteControlPlaneOperationOptions {
  request?: Request;
  commandRunner?: ControlPlaneCommandRunner;
  mcpService?: ControlPlaneMcpService;
  healthCheck?: () => unknown;
  approvalTokenReader?: () => string | undefined;
  auditEmitter?: (event: ControlPlaneAuditEvent) => void;
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

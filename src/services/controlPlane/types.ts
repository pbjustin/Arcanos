export type ControlPlaneAdapter = 'railway-cli' | 'arcanos-cli' | 'arcanos-mcp';
export type ControlPlanePhase = 'plan' | 'execute' | 'mutate';
export type ControlPlaneRoutePreference = 'prefer_trinity' | 'direct';
export type ControlPlaneRequestedRoute = 'trinity' | 'direct';

export type ControlPlaneRouteStatus =
  | 'TRINITY_CONFIRMED'
  | 'TRINITY_UNAVAILABLE'
  | 'TRINITY_REQUESTED_BUT_NOT_CONFIRMED'
  | 'DIRECT_FAST_PATH'
  | 'UNKNOWN_ROUTE';

export interface ControlPlaneApproval {
  approved: boolean;
  approvedBy?: string;
  reason?: string;
  confirmationId?: string;
}

export interface ControlPlaneContext {
  sessionId?: string;
  cwd?: string;
  environment?: 'workspace' | 'remote';
  caller?: {
    id: string;
    type: string;
    scopes?: string[];
  };
}

export interface ControlPlaneRequestPayload {
  requestId?: string;
  phase: ControlPlanePhase;
  adapter: ControlPlaneAdapter;
  operation: string;
  input?: Record<string, unknown>;
  context?: ControlPlaneContext;
  routePreference?: ControlPlaneRoutePreference;
  approval?: ControlPlaneApproval;
}

export interface ControlPlaneRouteEvidence {
  sourceEndpoint?: string;
  routingStages?: string[];
  pipelineDebugPresent?: boolean;
  gpt5Used?: boolean;
  activeModel?: string;
  responseKeys?: string[];
}

export interface ControlPlaneRouteMetadata {
  requested: ControlPlaneRequestedRoute;
  status: ControlPlaneRouteStatus;
  eligibleForTrinity: boolean;
  reason: string;
  evidence: ControlPlaneRouteEvidence;
  requestedAt: string;
  verifiedAt: string;
}

export interface ControlPlaneApprovalMetadata {
  required: boolean;
  satisfied: boolean;
  gate: 'none' | 'control-plane-approval';
  reason?: string;
}

export interface ControlPlaneAuditMetadata {
  auditId: string;
  logged: boolean;
}

export interface ControlPlaneCommandPreview {
  executable: string;
  args: string[];
  cwd: string;
}

export interface ControlPlaneResult {
  status: 'planned' | 'completed';
  adapter: ControlPlaneAdapter;
  operation: string;
  command?: ControlPlaneCommandPreview;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  data?: unknown;
}

export interface ControlPlaneError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ControlPlaneResponse {
  ok: boolean;
  requestId: string;
  phase: ControlPlanePhase;
  adapter: ControlPlaneAdapter;
  operation: string;
  route: ControlPlaneRouteMetadata;
  approval: ControlPlaneApprovalMetadata;
  audit: ControlPlaneAuditMetadata;
  result?: ControlPlaneResult;
  error?: ControlPlaneError;
}

export interface ControlPlaneProcessResult {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
}

export interface ControlPlaneProcessRunner {
  run: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
    }
  ) => Promise<ControlPlaneProcessResult>;
}

export interface ControlPlaneMcpClient {
  listTools: (options?: { sessionId?: string }) => Promise<unknown>;
  invokeTool: (options: {
    toolName: string;
    toolArguments?: Record<string, unknown>;
    sessionId?: string;
  }) => Promise<unknown>;
}

export interface ControlPlaneTrinityPlanner {
  plan: (request: ControlPlaneRequestPayload & { requestId: string }) => Promise<unknown>;
}

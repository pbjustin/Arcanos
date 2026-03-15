import type { ARCANOS_PROTOCOL_COMMAND_IDS, ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS } from "./commands.js";
import type { ARCANOS_PROTOCOL_VERSION } from "./constants.js";

export type ArcanosProtocolVersion = typeof ARCANOS_PROTOCOL_VERSION;
export type EnvironmentType = "workspace" | "sandbox" | "host" | "remote";
export type ProtocolCommandId = (typeof ARCANOS_PROTOCOL_COMMAND_IDS)[number];
export type ImplementedProtocolCommandId = (typeof ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS)[number];

export interface ProtocolAuth {
  strategy: string;
  token: string;
}

export interface ProtocolContext {
  sessionId?: string;
  projectId?: string;
  environment?: string;
  cwd?: string;
  shell?: string;
}

export interface ProtocolError {
  code?: string;
  message: string;
  traceId?: string;
  retryable?: boolean;
}

export interface ProtocolMeta {
  version?: string;
  executedBy?: string;
  timingMs?: number;
}

export interface ProtocolRequest<TPayload = unknown> {
  protocol: ArcanosProtocolVersion;
  requestId: string;
  command: ProtocolCommandId;
  auth?: ProtocolAuth;
  context?: ProtocolContext;
  payload?: TPayload;
}

export interface ProtocolResponse<TData = unknown> {
  protocol: ArcanosProtocolVersion;
  requestId: string;
  ok: boolean;
  data?: TData;
  error?: ProtocolError;
  meta?: ProtocolMeta;
}

export interface EnvironmentDescriptor {
  type: EnvironmentType;
  id?: string;
  label?: string;
  cwd?: string;
  shell?: string;
  capabilities?: string[];
}

export interface ProjectDescriptor {
  id: string;
  name: string;
  rootPath?: string;
}

export interface TaskDescriptor {
  id: string;
  command: ProtocolCommandId;
  payload?: unknown;
  context?: ProtocolContext;
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface PlanDescriptor {
  id: string;
  status: "draft" | "approved" | "executing" | "completed";
  steps: PlanStep[];
}

export interface PatchDescriptor {
  id: string;
  targetPath: string;
  format: string;
  content: string;
  summary?: string;
}

export interface RunResultDescriptor {
  status: "queued" | "running" | "completed" | "failed";
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ApprovalDescriptor {
  id: string;
  status: "pending" | "approved" | "rejected";
  requestedBy?: string;
  scopes?: string[];
}

export interface ArtifactDescriptor {
  id: string;
  kind: string;
  path?: string;
  contentType?: string;
  checksum?: string;
  bytes?: number;
  createdAt: string;
}

export interface ExecutionStateDescriptor {
  executionId: string;
  command: ProtocolCommandId;
  status: "queued" | "running" | "completed" | "failed";
  environment?: EnvironmentDescriptor;
  artifacts?: ArtifactDescriptor[];
  runResult?: RunResultDescriptor;
  createdAt: string;
  updatedAt: string;
}

export interface ToolDefinition {
  id: string;
  description: string;
  inputSchemaId: string;
  outputSchemaId: string;
  approvalRequired: boolean;
  allowedClients: string[];
  scopes: string[];
  requiredCapabilities: string[];
  preferredEnvironmentType: EnvironmentType;
}

export interface ContextInspectRequestPayload {
  includeProject?: boolean;
  includeAvailableEnvironments?: boolean;
}

export interface ContextInspectResponseData {
  context: ProtocolContext;
  project?: ProjectDescriptor;
  environment: EnvironmentDescriptor;
  availableEnvironments?: EnvironmentDescriptor[];
}

export interface ToolRegistryRequestPayload {
  preferredEnvironmentType?: EnvironmentType;
  scopes?: string[];
}

export interface ToolRegistryResponseData {
  tools: ToolDefinition[];
}

export interface ExecStartRequestPayload {
  task: TaskDescriptor;
  approval?: ApprovalDescriptor;
}

export interface ExecStartResponseData {
  state: ExecutionStateDescriptor;
}

export interface ExecStatusRequestPayload {
  executionId: string;
}

export interface ExecStatusResponseData {
  state: ExecutionStateDescriptor;
}

export interface DaemonCapabilitiesResponseData {
  protocolVersion: string;
  runtimeVersion: string;
  supportedCommands: ProtocolCommandId[];
  supportedEnvironmentTypes: EnvironmentType[];
  schemaRoot: string;
  toolCount?: number;
}

export interface StateSnapshotRequestPayload {
  executionId: string;
}

export interface StateSnapshotResponseData {
  snapshotId: string;
  state: ExecutionStateDescriptor;
}

export interface ArtifactStoreRequestPayload {
  artifact: ArtifactDescriptor;
}

export interface ArtifactStoreResponseData {
  artifact: ArtifactDescriptor;
  stored: boolean;
}

export interface ValidationIssue {
  instancePath: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

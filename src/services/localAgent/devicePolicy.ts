import {
  resolveLocalAgentExecutorServerBinding,
  type LocalAgentExecutorPrincipal
} from '@services/actionPlanExecution/auth.js';
import { getAuthoritativeAgent } from '@stores/agentRegistry.js';
import type { AgentRecord } from '@shared/types/actionPlan.js';
import { LOCAL_AGENT_ACTIONS } from './contracts.js';

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DEFAULT_HEARTBEAT_TTL_MS = 90_000;
const MIN_HEARTBEAT_TTL_MS = 10_000;
const MAX_HEARTBEAT_TTL_MS = 15 * 60 * 1_000;

export interface AuthorizedLocalAgentDevice {
  deviceId: string;
  agentId: string;
  instanceId: string;
  principalId: string;
  capabilities: readonly string[];
  record: AgentRecord;
}

export class LocalAgentDevicePolicyError extends Error {
  constructor(
    public readonly code:
      | 'LOCAL_AGENT_DEVICE_NOT_CONFIGURED'
      | 'LOCAL_AGENT_DEVICE_NOT_REGISTERED'
      | 'LOCAL_AGENT_DEVICE_IDENTITY_MISMATCH'
      | 'LOCAL_AGENT_DEVICE_SCOPE_DENIED'
      | 'LOCAL_AGENT_DEVICE_OFFLINE'
      | 'LOCAL_AGENT_WORKSPACE_DENIED'
      | 'LOCAL_AGENT_CONFIRMATION_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'LocalAgentDevicePolicyError';
  }
}

export function resolveLocalAgentHeartbeatTtlMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const configured = Number(env.ARCANOS_LOCAL_AGENT_HEARTBEAT_TTL_MS);
  if (!Number.isFinite(configured)) {
    return DEFAULT_HEARTBEAT_TTL_MS;
  }
  return Math.min(
    MAX_HEARTBEAT_TTL_MS,
    Math.max(MIN_HEARTBEAT_TTL_MS, Math.trunc(configured))
  );
}

export function resolveAllowedLocalAgentWorkspaces(
  env: NodeJS.ProcessEnv = process.env
): ReadonlySet<string> {
  const configured = env.ARCANOS_LOCAL_AGENT_WORKSPACES;
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    return new Set();
  }

  const values = configured
    .split(',')
    .map((value) => value.trim())
    .filter((value) => WORKSPACE_ID_PATTERN.test(value));
  return new Set(values);
}

export function assertLocalAgentWorkspaceAllowed(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!resolveAllowedLocalAgentWorkspaces(env).has(workspaceId)) {
    throw new LocalAgentDevicePolicyError(
      'LOCAL_AGENT_WORKSPACE_DENIED',
      'The authenticated GPT Access workspace is not registered for local-agent execution.'
    );
  }
}

export async function resolveAuthorizedLocalAgentDevice(
  requiredScopes: readonly string[],
  options: {
    principal?: LocalAgentExecutorPrincipal | null;
    env?: NodeJS.ProcessEnv;
    requireFreshHeartbeat?: boolean;
    now?: Date;
  } = {}
): Promise<AuthorizedLocalAgentDevice> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const binding = resolveLocalAgentExecutorServerBinding(env, now.getTime());
  if (!binding) {
    throw new LocalAgentDevicePolicyError(
      'LOCAL_AGENT_DEVICE_NOT_CONFIGURED',
      'The purpose-bound Python executor identity is not configured.'
    );
  }

  const principal = options.principal;
  if (
    principal
    && (
      principal.role !== 'local-agent-executor'
      || principal.audience !== 'local-agent-protocol'
      || principal.principalId !== binding.principalId
      || principal.executorInstanceId !== binding.instanceId
      || principal.executorDeviceId !== binding.deviceId
    )
  ) {
    throw new LocalAgentDevicePolicyError(
      'LOCAL_AGENT_DEVICE_IDENTITY_MISMATCH',
      'The authenticated executor is not the registered local-agent device.'
    );
  }

  const agent = await getAuthoritativeAgent(binding.deviceId);
  if (!agent || agent.role !== 'executor') {
    throw new LocalAgentDevicePolicyError(
      'LOCAL_AGENT_DEVICE_NOT_REGISTERED',
      'The configured Python executor is not registered as an authoritative executor agent.'
    );
  }

  const allowedScopeSet = new Set<string>(LOCAL_AGENT_ACTIONS);
  const capabilitySet = new Set(agent.capabilities);
  if (
    agent.capabilities.length === 0
    || capabilitySet.size !== agent.capabilities.length
    || agent.capabilities.some((scope) => !allowedScopeSet.has(scope))
  ) {
    throw new LocalAgentDevicePolicyError(
      'LOCAL_AGENT_DEVICE_SCOPE_DENIED',
      'The registered local-agent device capability membership is invalid or revoked.'
    );
  }
  const missingScopes = requiredScopes.filter((scope) => !capabilitySet.has(scope));
  if (missingScopes.length > 0) {
    throw new LocalAgentDevicePolicyError(
      'LOCAL_AGENT_DEVICE_SCOPE_DENIED',
      'The registered local-agent device does not have the required capability scopes.'
    );
  }

  if (options.requireFreshHeartbeat !== false) {
    const lastHeartbeatAt = agent.lastHeartbeat instanceof Date
      ? agent.lastHeartbeat.getTime()
      : Number.NaN;
    const heartbeatAgeMs = now.getTime() - lastHeartbeatAt;
    if (
      !Number.isFinite(lastHeartbeatAt)
      || heartbeatAgeMs < 0
      || heartbeatAgeMs > resolveLocalAgentHeartbeatTtlMs(env)
    ) {
      throw new LocalAgentDevicePolicyError(
        'LOCAL_AGENT_DEVICE_OFFLINE',
        'The registered local-agent device heartbeat is stale or unavailable.'
      );
    }
  }

  return {
    deviceId: binding.deviceId,
    agentId: binding.deviceId,
    instanceId: binding.instanceId,
    principalId: binding.principalId,
    capabilities: [...agent.capabilities],
    record: agent
  };
}

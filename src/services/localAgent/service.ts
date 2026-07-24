import {
  findOrCreateLocalAgentJob,
  LocalAgentJobRepositoryError,
  LOCAL_AGENT_JOB_PROTOCOL_VERSION,
  type LocalAgentAuthorizationDecision,
  type LocalAgentJobEnvelope
} from '@core/db/repositories/localAgentJobRepository.js';
import {
  fingerprintCanonicalValue,
  hashScopedOpaqueValue,
  type CanonicalJsonValue
} from '@services/actionPlanExecution/canonical.js';
import {
  assertLocalAgentWorkspaceAllowed,
  LocalAgentDevicePolicyError,
  resolveAuthorizedLocalAgentDevice
} from './devicePolicy.js';
import {
  LOCAL_AGENT_CAPABILITY_CATALOG,
  type LocalAgentAction,
  type LocalAgentActionInputMap
} from './contracts.js';
import type { LocalAgentExecutionRequest } from './executor.js';

const LOCAL_AGENT_CAPABILITY_PATH =
  '/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run' as const;
const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const OPAQUE_IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,240}$/u;
const DEFAULT_LOCAL_AGENT_JOB_TTL_MS = 20 * 60 * 1_000;
const MAX_LOCAL_AGENT_JOB_TTL_MS = 24 * 60 * 60 * 1_000;
const LOCAL_AGENT_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

function normalizeProtocolId(value: string | null | undefined, prefix: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (PROTOCOL_ID_PATTERN.test(normalized)) {
    return normalized;
  }
  return `${prefix}:${hashScopedOpaqueValue(
    `local-agent-${prefix}-id-v1`,
    normalized || 'missing'
  ).slice(0, 32)}`;
}

function resolveJobTtlMs(
  actionTimeoutMs: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const configured = Number(env.ARCANOS_LOCAL_AGENT_JOB_TTL_MS);
  const requested = Number.isFinite(configured)
    ? Math.trunc(configured)
    : DEFAULT_LOCAL_AGENT_JOB_TTL_MS;
  return Math.min(
    MAX_LOCAL_AGENT_JOB_TTL_MS,
    Math.max(actionTimeoutMs + 60_000, requested)
  );
}

function buildErrorEnvelope(
  action: LocalAgentAction,
  code: string,
  message: string,
  recommendedAction: string
) {
  return {
    ok: false,
    accepted: false,
    action,
    persisted: false,
    error: {
      code,
      message,
      recoverable: true,
      recommendedAction
    }
  };
}

function requireConfirmationEvidence(
  request: LocalAgentExecutionRequest,
  action: LocalAgentAction
): LocalAgentAuthorizationDecision {
  const contract = LOCAL_AGENT_CAPABILITY_CATALOG[action];
  if (!contract.requiresConfirmation) {
    return 'allow';
  }
  if (!request.context.confirmation) {
    throw new LocalAgentDevicePolicyError(
      'LOCAL_AGENT_CONFIRMATION_REQUIRED',
      'The privileged local-agent action did not carry server confirmation evidence.'
    );
  }
  if (
    action === 'patch.apply'
    && request.context.confirmation.usedChallengeToken !== true
  ) {
    throw new LocalAgentDevicePolicyError(
      'LOCAL_AGENT_CONFIRMATION_REQUIRED',
      'patch.apply requires an exact, consumed GPT Access confirmation challenge.'
    );
  }
  return 'confirmed';
}

function resolveIdempotencyKey(
  request: LocalAgentExecutionRequest,
  requestId: string
): { key: string; origin: 'explicit' | 'derived' } {
  if (
    request.context.idempotencyKey
    && OPAQUE_IDEMPOTENCY_KEY_PATTERN.test(request.context.idempotencyKey)
  ) {
    return { key: request.context.idempotencyKey, origin: 'explicit' };
  }
  return {
    key: `derived:${requestId}:${request.action}`,
    origin: 'derived'
  };
}

function toCanonicalPayload<TAction extends LocalAgentAction>(
  payload: LocalAgentActionInputMap[TAction]
): CanonicalJsonValue {
  return payload as unknown as CanonicalJsonValue;
}

export async function executeLocalAgentActionAsJob(
  request: LocalAgentExecutionRequest
): Promise<unknown> {
  const action = request.action;
  const contract = LOCAL_AGENT_CAPABILITY_CATALOG[action];

  try {
    assertLocalAgentWorkspaceAllowed(request.context.workspaceId);
    const device = await resolveAuthorizedLocalAgentDevice(
      contract.requiredDeviceScopes
    );
    const authorizationDecision = requireConfirmationEvidence(request, action);
    const requestId = normalizeProtocolId(request.context.requestId, 'request');
    const traceId = normalizeProtocolId(
      request.context.traceId ?? request.context.requestId,
      'trace'
    );
    const idempotency = resolveIdempotencyKey(request, requestId);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + resolveJobTtlMs(contract.timeoutMs)
    ).toISOString();
    const idempotencyUntil = new Date(
      now.getTime() + LOCAL_AGENT_IDEMPOTENCY_RETENTION_MS
    ).toISOString();
    const retentionUntil = idempotencyUntil;
    const canonicalPayload = toCanonicalPayload(request.payload);
    const requestFingerprintHash = fingerprintCanonicalValue(
      'local-agent-request-v1',
      {
        action,
        payload: canonicalPayload,
        principal: request.context.principalId,
        workspace: request.context.workspaceId,
        deviceId: device.deviceId
      }
    );
    const idempotencyScopeHash = fingerprintCanonicalValue(
      'local-agent-idempotency-scope-v1',
      {
        principal: request.context.principalId,
        workspace: request.context.workspaceId,
        deviceId: device.deviceId,
        action
      }
    );
    const idempotencyKeyHash = hashScopedOpaqueValue(
      'local-agent-idempotency-key-v1',
      idempotency.key
    );
    const evidenceId = fingerprintCanonicalValue(
      'local-agent-authorization-evidence-v1',
      {
        action,
        requestFingerprintHash,
        requestId,
        traceId,
        decision: authorizationDecision,
        confirmationStatus: request.context.confirmation?.status ?? 'not-required'
      }
    );
    const envelope: LocalAgentJobEnvelope = {
      protocolVersion: LOCAL_AGENT_JOB_PROTOCOL_VERSION,
      requestPath: LOCAL_AGENT_CAPABILITY_PATH,
      executionModeReason: 'gpt_access_local_agent_capability',
      job: {
        action,
        payload: request.payload,
        principal: request.context.principalId,
        workspace: request.context.workspaceId,
        deviceId: device.deviceId,
        traceId,
        requestId,
        idempotencyKey: idempotency.key,
        authorization: {
          decision: authorizationDecision,
          evidenceId,
          evaluatedAt: now.toISOString()
        },
        expiresAt,
        timeoutMs: contract.timeoutMs,
        requiredDeviceScopes: [...contract.requiredDeviceScopes],
        readOnly: contract.readOnly,
        mayModifyFiles: contract.mayModifyFiles
      }
    };

    const persisted = await findOrCreateLocalAgentJob({
      deviceId: device.deviceId,
      envelope,
      requestFingerprintHash,
      idempotencyKeyHash,
      idempotencyScopeHash,
      idempotencyOrigin: idempotency.origin,
      expiresAt,
      idempotencyUntil,
      retentionUntil
    });
    return {
      ok: true,
      accepted: true,
      persisted: true,
      action,
      jobId: persisted.job.id,
      status: persisted.job.status,
      deduped: persisted.deduped,
      dedupeReason: persisted.dedupeReason,
      expiresAt: persisted.job.expires_at instanceof Date
        ? persisted.job.expires_at.toISOString()
        : persisted.job.expires_at ?? expiresAt,
      traceId,
      requestId,
      poll: '/gpt-access/jobs/result'
    };
  } catch (error) {
    if (error instanceof LocalAgentDevicePolicyError) {
      return buildErrorEnvelope(
        action,
        error.code,
        error.message,
        error.code === 'LOCAL_AGENT_WORKSPACE_DENIED'
          ? 'REGISTER_WORKSPACE'
          : 'CHECK_DEVICE_CONFIGURATION'
      );
    }
    if (error instanceof LocalAgentJobRepositoryError) {
      return buildErrorEnvelope(
        action,
        error.code,
        error.message,
        error.code === 'LOCAL_AGENT_IDEMPOTENCY_CONFLICT'
          ? 'CHANGE_IDEMPOTENCY_KEY'
          : 'RETRY_LATER'
      );
    }
    return buildErrorEnvelope(
      action,
      'LOCAL_AGENT_ENQUEUE_FAILED',
      'The authorized local-agent job could not be persisted.',
      'RETRY_LATER'
    );
  }
}

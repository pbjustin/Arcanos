import { z } from 'zod';

import type { JobData } from '@core/db/schema.js';
import {
  LOCAL_AGENT_JOB_PROTOCOL_VERSION,
  readLocalAgentJobEnvelope,
  type ClaimLocalAgentJobResult
} from '@core/db/repositories/localAgentJobRepository.js';
import {
  fingerprintCanonicalValue,
  hashScopedOpaqueValue,
  type CanonicalJsonValue
} from '@services/actionPlanExecution/canonical.js';

const OPAQUE_KEY_PATTERN = /^[\x21-\x7E]+$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const FAILURE_CLASSIFICATION_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_LOCAL_AGENT_RESULT_BYTES = 128 * 1024;

export const localAgentClaimInputSchema = z.object({
  claimKey: z.string().min(1).max(240).regex(OPAQUE_KEY_PATTERN)
}).strict();

export const localAgentJobParamsSchema = z.object({
  jobId: z.string().uuid()
}).strict();

const localAgentResultErrorSchema = z.object({
  code: z.string().min(1).max(64).regex(ERROR_CODE_PATTERN),
  message: z.string().min(1).max(2_000),
  classification: z.string().min(1).max(64).regex(FAILURE_CLASSIFICATION_PATTERN),
  retryable: z.boolean()
}).strict();

export const localAgentResultInputSchema = z.object({
  protocolVersion: z.literal(LOCAL_AGENT_JOB_PROTOCOL_VERSION),
  resultKey: z.string().min(1).max(240).regex(OPAQUE_KEY_PATTERN),
  outcome: z.enum(['succeeded', 'failed']),
  output: z.unknown().optional(),
  error: localAgentResultErrorSchema.optional(),
  metrics: z.object({
    durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1_000),
    outputTruncated: z.boolean()
  }).strict(),
  correlation: z.object({
    traceId: z.string().min(1).max(256).regex(CORRELATION_ID_PATTERN),
    requestId: z.string().min(1).max(256).regex(CORRELATION_ID_PATTERN),
    deviceId: z.string().min(1).max(256).regex(CORRELATION_ID_PATTERN)
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.outcome === 'succeeded' && value.error !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['error'],
      message: 'Successful local-agent results must not include an error.'
    });
  }
  if (value.outcome === 'failed' && value.error === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['error'],
      message: 'Failed local-agent results must include a structured error.'
    });
  }
  if (value.outcome === 'failed' && value.output !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['output'],
      message: 'Failed local-agent results must not include output.'
    });
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Local-agent result must be JSON serializable.'
    });
    return;
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_LOCAL_AGENT_RESULT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Local-agent result must not exceed ${MAX_LOCAL_AGENT_RESULT_BYTES} bytes.`
    });
  }
});

export type LocalAgentResultInput = z.infer<typeof localAgentResultInputSchema>;

export function hashLocalAgentClaimKey(value: string): string {
  return hashScopedOpaqueValue('local-agent-claim-key-v1', value);
}

export function hashLocalAgentResultKey(value: string): string {
  return hashScopedOpaqueValue('local-agent-result-key-v1', value);
}

export function fingerprintLocalAgentResult(value: LocalAgentResultInput): string {
  const fingerprintValue = {
    protocolVersion: value.protocolVersion,
    outcome: value.outcome,
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.error === undefined ? {} : { error: value.error }),
    metrics: value.metrics,
    correlation: value.correlation
  } as CanonicalJsonValue;
  return fingerprintCanonicalValue('local-agent-result-v1', fingerprintValue);
}

function toProtocolState(status: string): string {
  return status.trim().toUpperCase();
}

export function buildLocalAgentClaimPayload(result: ClaimLocalAgentJobResult) {
  const state = toProtocolState(result.job.status);
  if (result.disposition === 'TERMINAL_REPLAY') {
    return {
      ok: true,
      code: 'LOCAL_AGENT_JOB_CLAIMED',
      protocolVersion: LOCAL_AGENT_JOB_PROTOCOL_VERSION,
      disposition: result.disposition,
      state,
      jobId: result.job.id
    };
  }

  const envelope = readLocalAgentJobEnvelope(result.job);
  if (!envelope) {
    throw new Error('Persisted local-agent assignment does not match the server protocol.');
  }
  return {
    ok: true,
    code: 'LOCAL_AGENT_JOB_CLAIMED',
    protocolVersion: LOCAL_AGENT_JOB_PROTOCOL_VERSION,
    disposition: result.disposition,
    state,
    jobId: result.job.id,
    ...envelope.job
  };
}

export function buildLocalAgentResultReceipt(job: JobData, replayed: boolean) {
  const acceptanceReceipt = hashScopedOpaqueValue(
    'local-agent-result-receipt-v1',
    `${job.id}:${job.status}:${job.updated_at instanceof Date
      ? job.updated_at.toISOString()
      : String(job.updated_at)}`
  );
  return {
    ok: true,
    code: 'LOCAL_AGENT_JOB_RESULT_ACCEPTED',
    protocolVersion: LOCAL_AGENT_JOB_PROTOCOL_VERSION,
    result: {
      jobId: job.id,
      state: toProtocolState(job.status),
      disposition: replayed ? 'RESULT_REPLAY' : 'RESULT_ACCEPTED',
      acceptanceReceipt
    }
  };
}

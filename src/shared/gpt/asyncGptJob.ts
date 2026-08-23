import crypto from 'node:crypto';
import { z } from 'zod';
import type { GptAsyncWriteAction } from './gptJobResult.js';
import { mapGptJobStatusToClientStatus } from './priorityGpt.js';
import { buildJobReadCapabilityResponseFields } from '@shared/jobs/jobReadCapability.js';
import { resolveRequestedGptAction } from '@shared/gpt/gptRequestAction.js';
import {
  GPT_ECHO_ACTION,
  GPT_HEALTH_ECHO_ACTION,
  isGptBridgeSmokeAction,
  type QueuedBridgeSmokeInput
} from './bridgeSmoke.js';
import {
  BACKSTAGE_MODULE_NAME,
  BACKSTAGE_MUTATION_SCOPE,
} from '@shared/backstage/backstageActionPolicy.js';
import {
  BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
  BackstageJobPayloadProtectionError,
  sealBackstageJobPayload,
  unsealBackstageJobPayload,
  type BackstageJobPayloadEnvelope,
} from '@shared/backstage/backstageJobPayloadProtection.js';

export const PROTECTED_BACKSTAGE_JOB_VERSION = 1;
export const PROTECTED_BACKSTAGE_JOB_SOURCE = 'backstage-booker-http';
export const PROTECTED_BACKSTAGE_JOB_FINGERPRINT_DOMAIN =
  'protected-backstage-job:v1';

export const QUEUED_GPT_BACKSTAGE_MUTATION_ADMISSION_VERSION = 1;
export const QUEUED_GPT_BACKSTAGE_MUTATION_ADMISSION_SOURCE = 'control-plane-http';

const BACKSTAGE_UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const protectedBackstageUniverseIdSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(BACKSTAGE_UNIVERSE_ID_PATTERN);

const queuedGptBackstageMutationAdmissionSchema = z.object({
  version: z.literal(QUEUED_GPT_BACKSTAGE_MUTATION_ADMISSION_VERSION),
  source: z.literal(QUEUED_GPT_BACKSTAGE_MUTATION_ADMISSION_SOURCE),
  module: z.literal(BACKSTAGE_MODULE_NAME),
  action: z.string().trim().min(1).max(128),
  scope: z.literal(BACKSTAGE_MUTATION_SCOPE),
  principalId: z.string().trim().min(1).max(128),
}).strict();

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
);

const queuedGptJobInputSchema = z.object({
  gptId: z.string().trim().min(1).max(128),
  body: z.record(jsonValueSchema),
  prompt: z.string().trim().min(1).optional(),
  bypassIntentRouting: z.boolean().optional(),
  requestId: z.string().trim().min(1).max(128).optional(),
  traceId: z.string().trim().min(1).max(128).optional(),
  correlationId: z.string().trim().min(1).max(128).optional(),
  routeHint: z.string().trim().min(1).max(64).optional(),
  requestPath: z.string().trim().min(1).max(256).optional(),
  executionModeReason: z.string().trim().min(1).max(128).optional(),
  backstageMutationAdmission: queuedGptBackstageMutationAdmissionSchema.optional(),
  bridgeSmoke: z.literal(true).optional(),
  bridgeAction: z.enum([GPT_HEALTH_ECHO_ACTION, GPT_ECHO_ACTION]).optional()
}).passthrough();

const protectedBackstageDescriptorSchema = z.object({
  version: z.literal(PROTECTED_BACKSTAGE_JOB_VERSION),
  source: z.literal(PROTECTED_BACKSTAGE_JOB_SOURCE),
  envelopeId: z.string().uuid(),
  action: z.enum(['generateBooking', 'generateBookingWithHRC']),
  universeId: protectedBackstageUniverseIdSchema,
  sealedPayload: z.unknown(),
}).strict();

const protectedBackstageQueuedGptJobInputSchema = z.object({
  gptId: z.literal('backstage-booker'),
  protectedBackstage: protectedBackstageDescriptorSchema,
  requestId: z.string().trim().min(1).max(128).optional(),
  traceId: z.string().trim().min(1).max(128).optional(),
  correlationId: z.string().trim().min(1).max(128).optional(),
  routeHint: z.enum(['generateBooking', 'generateBookingWithHRC']).optional(),
  requestPath: z.literal('/gpt/backstage-booker').optional(),
  executionModeReason: z.string().trim().min(1).max(128).optional(),
}).strict();

const protectedBackstageAuthorizationSchema = z.object({
  version: z.literal(PROTECTED_BACKSTAGE_JOB_VERSION),
  source: z.literal(PROTECTED_BACKSTAGE_JOB_SOURCE),
  authorized: z.boolean(),
  action: z.enum(['generateBooking', 'generateBookingWithHRC']),
  universeId: protectedBackstageUniverseIdSchema,
}).strict();

const protectedBackstagePlaintextSchema = z.object({
  body: z.record(jsonValueSchema),
  prompt: z.string().trim().min(1).optional(),
  bypassIntentRouting: z.boolean().optional(),
  notionEnrichmentAuthorization: protectedBackstageAuthorizationSchema,
}).strict();


export interface QueuedGptBackstageMutationAdmission {
  version: typeof QUEUED_GPT_BACKSTAGE_MUTATION_ADMISSION_VERSION;
  source: typeof QUEUED_GPT_BACKSTAGE_MUTATION_ADMISSION_SOURCE;
  module: typeof BACKSTAGE_MODULE_NAME;
  action: string;
  scope: typeof BACKSTAGE_MUTATION_SCOPE;
  principalId: string;
}

export interface QueuedGptJobInput extends QueuedBridgeSmokeInput {
  gptId: string;
  body: Record<string, unknown>;
  prompt?: string;
  bypassIntentRouting?: boolean;
  requestId?: string;
  traceId?: string;
  correlationId?: string;
  routeHint?: string;
  requestPath?: string;
  executionModeReason?: string;
  backstageMutationAdmission?: QueuedGptBackstageMutationAdmission;
  protectedBackstage?: {
    version: typeof PROTECTED_BACKSTAGE_JOB_VERSION;
    source: typeof PROTECTED_BACKSTAGE_JOB_SOURCE;
    envelopeId: string;
    action: 'generateBooking' | 'generateBookingWithHRC';
    universeId: string;
    notionEnrichmentAuthorized: boolean;
  };
}

export interface ProtectedBackstageQueuedGptJobInput {
  gptId: 'backstage-booker';
  protectedBackstage: {
    version: typeof PROTECTED_BACKSTAGE_JOB_VERSION;
    source: typeof PROTECTED_BACKSTAGE_JOB_SOURCE;
    envelopeId: string;
    action: 'generateBooking' | 'generateBookingWithHRC';
    universeId: string;
    sealedPayload: BackstageJobPayloadEnvelope;
  };
  requestId?: string;
  traceId?: string;
  correlationId?: string;
  routeHint?: 'generateBooking' | 'generateBookingWithHRC';
  requestPath?: '/gpt/backstage-booker';
  executionModeReason?: string;
}

export interface QueuedGptPendingResponse {
  ok: true;
  action: GptAsyncWriteAction;
  status: 'queued' | 'running' | 'timeout';
  jobId: string;
  result: Record<string, never>;
  poll: string;
  stream: string;
  jobReadToken: string;
  jobReadTokenHeader: string;
  timedOut: boolean;
  jobStatus?: string;
  lifecycleStatus?: string;
  deduped?: boolean;
  idempotencyKey?: string;
  idempotencySource?: 'explicit' | 'derived';
  _route: {
    requestId?: string;
    gptId: string;
    route: 'async';
    timestamp: string;
  };
}

export type ParsedQueuedGptJobInput =
  | { ok: true; value: QueuedGptJobInput }
  | { ok: false; error: string };

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBoundedOptionalString(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

/** Build server-owned proof that one queued Backstage mutation passed HTTP admission. */
export function buildQueuedGptBackstageMutationAdmission(input: {
  action: string;
  principalId: string;
}): QueuedGptBackstageMutationAdmission {
  return queuedGptBackstageMutationAdmissionSchema.parse({
    version: QUEUED_GPT_BACKSTAGE_MUTATION_ADMISSION_VERSION,
    source: QUEUED_GPT_BACKSTAGE_MUTATION_ADMISSION_SOURCE,
    module: BACKSTAGE_MODULE_NAME,
    action: input.action,
    scope: BACKSTAGE_MUTATION_SCOPE,
    principalId: input.principalId,
  });
}

/**
 * Build the persisted payload for an async `/gpt/:gptId` job.
 * Purpose: keep the queue contract centralized and schema-backed for worker execution.
 * Inputs/outputs: accepts normalized route metadata and returns a queue-safe payload.
 * Edge case behavior: blank optional strings are omitted so queue rows stay compact.
 */
export function buildQueuedGptJobInput(input: {
  gptId: string;
  body: Record<string, unknown>;
  prompt?: string | null;
  bypassIntentRouting?: boolean;
  requestId?: string | null;
  traceId?: string | null;
  correlationId?: string | null;
  routeHint?: string | null;
  requestPath?: string | null;
  executionModeReason?: string | null;
  backstageMutationAdmission?: QueuedGptBackstageMutationAdmission | null;
  bridgeSmoke?: boolean | null;
  bridgeAction?: string | null;
}): QueuedGptJobInput {
  const normalizedJobInput: QueuedGptJobInput = {
    gptId: input.gptId.trim(),
    body: input.body
  };

  const normalizedPrompt = normalizeOptionalString(input.prompt ?? undefined);
  if (normalizedPrompt) {
    normalizedJobInput.prompt = normalizedPrompt;
  }

  if (input.bypassIntentRouting === true) {
    normalizedJobInput.bypassIntentRouting = true;
  }

  const normalizedRequestId = normalizeBoundedOptionalString(input.requestId ?? undefined, 128);
  if (normalizedRequestId) {
    normalizedJobInput.requestId = normalizedRequestId;
  }

  const normalizedTraceId = normalizeBoundedOptionalString(input.traceId ?? undefined, 128);
  if (normalizedTraceId) {
    normalizedJobInput.traceId = normalizedTraceId;
  }

  const normalizedCorrelationId = normalizeBoundedOptionalString(input.correlationId ?? undefined, 128);
  if (normalizedCorrelationId) {
    normalizedJobInput.correlationId = normalizedCorrelationId;
  }

  const normalizedRouteHint = normalizeBoundedOptionalString(input.routeHint ?? undefined, 64);
  if (normalizedRouteHint) {
    normalizedJobInput.routeHint = normalizedRouteHint;
  }

  const normalizedRequestPath = normalizeBoundedOptionalString(input.requestPath ?? undefined, 256);
  if (normalizedRequestPath) {
    normalizedJobInput.requestPath = normalizedRequestPath;
  }

  const normalizedExecutionModeReason = normalizeBoundedOptionalString(
    input.executionModeReason ?? undefined,
    128
  );
  if (normalizedExecutionModeReason) {
    normalizedJobInput.executionModeReason = normalizedExecutionModeReason;
  }

  if (input.backstageMutationAdmission) {
    normalizedJobInput.backstageMutationAdmission =
      queuedGptBackstageMutationAdmissionSchema.parse(input.backstageMutationAdmission);
  }

  if (input.bridgeSmoke === true && isGptBridgeSmokeAction(input.bridgeAction)) {
    normalizedJobInput.bridgeSmoke = true;
    normalizedJobInput.bridgeAction = input.bridgeAction;
  }

  return normalizedJobInput;
}

function bindProtectedBackstageBody(params: {
  body: Record<string, unknown>;
  action: 'generateBooking' | 'generateBookingWithHRC';
  universeId: string;
}): Record<string, unknown> {
  const directBody = { ...params.body };
  delete directBody.payload;
  const submittedAction = resolveRequestedGptAction({ body: directBody });
  if (
    submittedAction !== null
    && submittedAction !== params.action.toLowerCase()
  ) {
    throw new BackstageJobPayloadProtectionError(
      'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID'
    );
  }

  const rawPayload = params.body.payload;
  if (
    rawPayload !== undefined
    && (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload))
  ) {
    throw new BackstageJobPayloadProtectionError(
      'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID'
    );
  }
  const payload = (rawPayload ?? {}) as Record<string, unknown>;
  const submittedPayloadAction = resolveRequestedGptAction({ body: payload });
  if (
    submittedPayloadAction !== null
    && submittedPayloadAction !== params.action.toLowerCase()
  ) {
    throw new BackstageJobPayloadProtectionError(
      'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID'
    );
  }
  const payloadUniverseId = payload.universeId;
  const bodyUniverseId = params.body.universeId;
  if (
    (payloadUniverseId !== undefined && payloadUniverseId !== params.universeId)
    || (bodyUniverseId !== undefined && bodyUniverseId !== params.universeId)
  ) {
    throw new BackstageJobPayloadProtectionError(
      'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID'
    );
  }

  return {
    ...params.body,
    action: params.action,
    payload: {
      ...payload,
      universeId: params.universeId,
    },
  };
}

function protectedBackstageBodyMatchesDescriptor(params: {
  body: Record<string, unknown>;
  action: 'generateBooking' | 'generateBookingWithHRC';
  universeId: string;
}): boolean {
  const payload = params.body.payload;
  return params.body.action === params.action
    && typeof payload === 'object'
    && payload !== null
    && !Array.isArray(payload)
    && (payload as Record<string, unknown>).universeId === params.universeId
    && (
      params.body.universeId === undefined
      || params.body.universeId === params.universeId
    );
}

/** Build the only persisted form allowed for queued private Booker generation. */
export function buildProtectedBackstageQueuedGptJobInput(input: {
  body: Record<string, unknown>;
  prompt?: string | null;
  action: 'generateBooking' | 'generateBookingWithHRC';
  universeId: string;
  notionEnrichmentAuthorized: boolean;
  bypassIntentRouting?: boolean;
  requestId?: string | null;
  traceId?: string | null;
  correlationId?: string | null;
  executionModeReason?: string | null;
  envelopeId?: string;
}): ProtectedBackstageQueuedGptJobInput {
  const envelopeId = input.envelopeId ?? crypto.randomUUID();
  const parsedUniverseId = protectedBackstageUniverseIdSchema.safeParse(input.universeId);
  if (!parsedUniverseId.success) {
    throw new BackstageJobPayloadProtectionError(
      'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID'
    );
  }
  const universeId = parsedUniverseId.data;
  const body = bindProtectedBackstageBody({
    body: input.body,
    action: input.action,
    universeId,
  });
  const plaintext = protectedBackstagePlaintextSchema.parse({
    body,
    ...(normalizeOptionalString(input.prompt ?? undefined)
      ? { prompt: normalizeOptionalString(input.prompt ?? undefined) }
      : {}),
    ...(input.bypassIntentRouting === true ? { bypassIntentRouting: true } : {}),
    notionEnrichmentAuthorization: {
      version: PROTECTED_BACKSTAGE_JOB_VERSION,
      source: PROTECTED_BACKSTAGE_JOB_SOURCE,
      authorized: input.notionEnrichmentAuthorized,
      action: input.action,
      universeId,
    },
  });
  const sealedPayload = sealBackstageJobPayload({
    purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
    identity: {
      envelopeId,
      gptId: 'backstage-booker',
      action: input.action,
      universeId,
    },
    payload: plaintext,
  });

  return protectedBackstageQueuedGptJobInputSchema.parse({
    gptId: 'backstage-booker',
    protectedBackstage: {
      version: PROTECTED_BACKSTAGE_JOB_VERSION,
      source: PROTECTED_BACKSTAGE_JOB_SOURCE,
      envelopeId,
      action: input.action,
      universeId,
      sealedPayload,
    },
    ...(normalizeBoundedOptionalString(input.requestId ?? undefined, 128)
      ? { requestId: normalizeBoundedOptionalString(input.requestId ?? undefined, 128) }
      : {}),
    ...(normalizeBoundedOptionalString(input.traceId ?? undefined, 128)
      ? { traceId: normalizeBoundedOptionalString(input.traceId ?? undefined, 128) }
      : {}),
    ...(normalizeBoundedOptionalString(input.correlationId ?? undefined, 128)
      ? { correlationId: normalizeBoundedOptionalString(input.correlationId ?? undefined, 128) }
      : {}),
    routeHint: input.action,
    requestPath: '/gpt/backstage-booker',
    ...(normalizeBoundedOptionalString(input.executionModeReason ?? undefined, 128)
      ? { executionModeReason: normalizeBoundedOptionalString(input.executionModeReason ?? undefined, 128) }
      : {}),
  }) as ProtectedBackstageQueuedGptJobInput;
}

export function isProtectedBackstageQueuedGptJobInput(
  rawInput: unknown
): rawInput is ProtectedBackstageQueuedGptJobInput {
  return protectedBackstageQueuedGptJobInputSchema.safeParse(rawInput).success;
}

/** Fail closed when idempotency returns a row outside the expected protected identity. */
export function protectedBackstageQueuedGptJobMatchesIdentity(
  rawInput: unknown,
  expected: {
    action: 'generateBooking' | 'generateBookingWithHRC';
    universeId: string;
  }
): rawInput is ProtectedBackstageQueuedGptJobInput {
  const parsed = protectedBackstageQueuedGptJobInputSchema.safeParse(rawInput);
  return parsed.success
    && parsed.data.protectedBackstage.action === expected.action
    && parsed.data.protectedBackstage.universeId === expected.universeId;
}

/** Read only the non-sensitive protected descriptor needed for worker planning. */
export function resolveProtectedBackstageQueuedGptJobAction(
  rawInput: unknown
): 'generateBooking' | 'generateBookingWithHRC' | null {
  const parsed = protectedBackstageQueuedGptJobInputSchema.safeParse(rawInput);
  return parsed.success ? parsed.data.protectedBackstage.action : null;
}

/**
 * Parse queued async GPT payloads read from `job_data.input`.
 * Purpose: fail malformed queue payloads deterministically before worker execution starts.
 * Inputs/outputs: accepts unknown persisted JSON and returns a structured validation result.
 * Edge case behavior: schema issues are aggregated into one explicit failure string.
 */
export function parseQueuedGptJobInput(rawInput: unknown): ParsedQueuedGptJobInput {
  const protectedInput = protectedBackstageQueuedGptJobInputSchema.safeParse(rawInput);
  if (protectedInput.success) {
    const descriptor = protectedInput.data.protectedBackstage;
    let plaintext: unknown;
    try {
      plaintext = unsealBackstageJobPayload({
        purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
        identity: {
          envelopeId: descriptor.envelopeId,
          gptId: protectedInput.data.gptId,
          action: descriptor.action,
          universeId: descriptor.universeId,
        },
        envelope: descriptor.sealedPayload,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        error: error instanceof Error
          ? error.message
          : 'Backstage job payload protection failed.',
      };
    }
    const parsedPlaintext = protectedBackstagePlaintextSchema.safeParse(plaintext);
    if (
      !parsedPlaintext.success
      || parsedPlaintext.data.notionEnrichmentAuthorization.action !== descriptor.action
      || parsedPlaintext.data.notionEnrichmentAuthorization.universeId !== descriptor.universeId
      || !protectedBackstageBodyMatchesDescriptor({
        body: parsedPlaintext.success
          ? parsedPlaintext.data.body as Record<string, unknown>
          : {},
        action: descriptor.action,
        universeId: descriptor.universeId,
      })
    ) {
      return {
        ok: false,
        error: 'Backstage job payload authorization is invalid.',
      };
    }

    return {
      ok: true,
      value: {
        gptId: protectedInput.data.gptId,
        body: parsedPlaintext.data.body as Record<string, unknown>,
        ...(parsedPlaintext.data.prompt ? { prompt: parsedPlaintext.data.prompt } : {}),
        ...(parsedPlaintext.data.bypassIntentRouting ? { bypassIntentRouting: true } : {}),
        ...(protectedInput.data.requestId ? { requestId: protectedInput.data.requestId } : {}),
        ...(protectedInput.data.traceId ? { traceId: protectedInput.data.traceId } : {}),
        ...(protectedInput.data.correlationId
          ? { correlationId: protectedInput.data.correlationId }
          : {}),
        ...(protectedInput.data.routeHint ? { routeHint: protectedInput.data.routeHint } : {}),
        ...(protectedInput.data.requestPath
          ? { requestPath: protectedInput.data.requestPath }
          : {}),
        ...(protectedInput.data.executionModeReason
          ? { executionModeReason: protectedInput.data.executionModeReason }
          : {}),
        protectedBackstage: {
          version: PROTECTED_BACKSTAGE_JOB_VERSION,
          source: PROTECTED_BACKSTAGE_JOB_SOURCE,
          envelopeId: descriptor.envelopeId,
          action: descriptor.action,
          universeId: descriptor.universeId,
          notionEnrichmentAuthorized:
            parsedPlaintext.data.notionEnrichmentAuthorization.authorized,
        },
      },
    };
  }

  if (
    typeof rawInput === 'object'
    && rawInput !== null
    && !Array.isArray(rawInput)
    && Object.prototype.hasOwnProperty.call(rawInput, 'protectedBackstage')
  ) {
    return {
      ok: false,
      error: 'Protected Backstage job payload is invalid.',
    };
  }

  const parsedJobInput = queuedGptJobInputSchema.safeParse(rawInput);

  if (!parsedJobInput.success) {
    return {
      ok: false,
      error: parsedJobInput.error.issues
        .map(issue => `${issue.path.join('.') || 'job.input'}: ${issue.message}`)
        .join('; ')
    };
  }

  return {
    ok: true,
    value: buildQueuedGptJobInput(parsedJobInput.data)
  };
}


/**
 * Build the immediate HTTP 202 payload for queued GPT work.
 * Purpose: keep async polling and stream links consistent across callers.
 * Inputs/outputs: accepts the created job id plus route metadata and returns the pending body.
 * Edge case behavior: route metadata remains sparse when no request id was available.
 */
export function buildQueuedGptPendingResponse(input: {
  action?: GptAsyncWriteAction;
  jobId: string;
  gptId: string;
  requestId?: string | null;
  timestamp?: string;
  jobStatus?: string | null;
  lifecycleStatus?: string | null;
  deduped?: boolean;
  idempotencyKey?: string | null;
  idempotencySource?: 'explicit' | 'derived' | null;
}): QueuedGptPendingResponse {
  const timestamp = input.timestamp ?? new Date().toISOString();

  return {
    ok: true,
    action: input.action ?? 'query',
    status: mapGptJobStatusToClientStatus(input.jobStatus) === 'running'
      ? 'running'
      : 'queued',
    jobId: input.jobId,
    result: {},
    poll: `/jobs/${input.jobId}/result`,
    stream: `/jobs/${input.jobId}/stream`,
    ...buildJobReadCapabilityResponseFields(input.jobId),
    timedOut: false,
    ...(normalizeOptionalString(input.jobStatus ?? undefined)
      ? { jobStatus: normalizeOptionalString(input.jobStatus ?? undefined)! }
      : {}),
    ...(normalizeOptionalString(input.lifecycleStatus ?? undefined)
      ? { lifecycleStatus: normalizeOptionalString(input.lifecycleStatus ?? undefined)! }
      : {}),
    ...(input.deduped ? { deduped: true } : {}),
    ...(normalizeOptionalString(input.idempotencyKey ?? undefined)
      ? { idempotencyKey: normalizeOptionalString(input.idempotencyKey ?? undefined)! }
      : {}),
    ...(input.idempotencySource ? { idempotencySource: input.idempotencySource } : {}),
    _route: {
      ...(normalizeOptionalString(input.requestId ?? undefined)
        ? { requestId: normalizeOptionalString(input.requestId ?? undefined) }
        : {}),
      gptId: input.gptId,
      route: 'async',
      timestamp
    }
  };
}

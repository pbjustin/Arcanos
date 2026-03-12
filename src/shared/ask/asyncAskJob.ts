import { z } from 'zod';
import type {
  TrinityAnswerMode,
  TrinityRequestedVerbosity,
  TrinityResult
} from '@core/logic/trinity.js';
import { clientContextSchema, type ClientContextDTO } from '@shared/types/dto.js';
import type { CognitiveDomain } from '@shared/types/cognitiveDomain.js';
import {
  buildTrinityUserVisibleResponse,
  type TrinityUserVisibleResponse
} from './trinityResponseSerializer.js';

const ASYNC_ASK_ENDPOINT_FALLBACK = 'ask';

const cognitiveDomainSchema = z.enum(['diagnostic', 'code', 'creative', 'natural', 'execution']);

const asyncAskAuditFlagSchema = z.object({
  auditFlag: z.literal('SCHEMA_VALIDATION_BYPASS'),
  reason: z.string().min(1),
  timestamp: z.string().min(1)
});

const queuedAskJobInputSchema = z.object({
  prompt: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(100).optional(),
  overrideAuditSafe: z.string().trim().min(1).max(50).optional(),
  cognitiveDomain: cognitiveDomainSchema.optional(),
  requestedVerbosity: z.enum(['minimal', 'normal', 'detailed']).optional(),
  maxWords: z.number().int().positive().max(2000).nullable().optional(),
  answerMode: z.enum(['direct', 'explained', 'audit', 'debug']).optional(),
  debugPipeline: z.boolean().optional(),
  strictUserVisibleOutput: z.boolean().optional(),
  clientContext: clientContextSchema.nullable().optional(),
  endpointName: z.string().trim().max(64).optional(),
  auditFlag: asyncAskAuditFlagSchema.optional()
}).passthrough();

/**
 * Async audit flag shape preserved across queue boundaries.
 *
 * Purpose:
 * - Keep lenient-schema audit metadata attached to async `/ask` responses.
 *
 * Inputs/outputs:
 * - Input: queue payload metadata.
 * - Output: structured audit flag for response consumers.
 *
 * Edge case behavior:
 * - Omitted when no lenient-schema bypass occurred.
 */
export interface AsyncAskAuditFlag {
  auditFlag: 'SCHEMA_VALIDATION_BYPASS';
  reason: string;
  timestamp: string;
}

/**
 * Normalized async `/ask` job payload persisted in `job_data.input`.
 *
 * Purpose:
 * - Provide one canonical queue contract shared by route and worker.
 *
 * Inputs/outputs:
 * - Input: serialized route metadata for an async `/ask` request.
 * - Output: validated payload the worker can execute deterministically.
 *
 * Edge case behavior:
 * - `endpointName` defaults to `ask` when absent or blank.
 */
export interface QueuedAskJobInput {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  requestedVerbosity?: TrinityRequestedVerbosity;
  maxWords?: number | null;
  answerMode?: TrinityAnswerMode;
  debugPipeline?: boolean;
  strictUserVisibleOutput?: boolean;
  clientContext?: ClientContextDTO;
  endpointName: string;
  auditFlag?: AsyncAskAuditFlag;
}

/**
 * Pending response returned immediately after enqueueing an async `/ask` job.
 *
 * Purpose:
 * - Keep the route response shape stable and centralized.
 *
 * Inputs/outputs:
 * - Input: created job identifier.
 * - Output: polling payload returned with HTTP 202.
 *
 * Edge case behavior:
 * - Assumes job identifiers are already non-empty UUID-like strings.
 */
export interface QueuedAskPendingResponse {
  ok: true;
  status: 'pending';
  jobId: string;
  poll: string;
}

/**
 * Result type returned when raw queue payload validation succeeds or fails.
 *
 * Purpose:
 * - Prevent ambiguous worker fallback behavior on malformed `job_data.input`.
 *
 * Inputs/outputs:
 * - Input: unknown JSON payload from the database.
 * - Output: either normalized job input or a structured validation error.
 *
 * Edge case behavior:
 * - Validation failures aggregate schema issue messages for explicit job failure reporting.
 */
export type ParsedQueuedAskJobInput =
  | { ok: true; value: QueuedAskJobInput }
  | { ok: false; error: string };

/**
 * Completed async `/ask` output returned through `/jobs/:id`.
 *
 * Purpose:
 * - Mirror sync `/ask` response fields after background execution completes.
 *
 * Inputs/outputs:
 * - Input: Trinity result plus queue metadata.
 * - Output: enriched response payload suitable for API clients.
 *
 * Edge case behavior:
 * - Optional context fields are omitted when not present in the queued job.
 */
export type CompletedQueuedAskJobOutput = TrinityUserVisibleResponse;

function normalizeEndpointName(endpointName?: string): string {
  const trimmedEndpointName = endpointName?.trim();

  //audit Assumption: blank or missing endpoint metadata should not break async result attribution; failure risk: undefined endpoint in telemetry and client payloads; expected invariant: every queued ask job resolves to a non-empty endpoint name; handling strategy: fall back to the primary `ask` endpoint.
  if (!trimmedEndpointName) {
    return ASYNC_ASK_ENDPOINT_FALLBACK;
  }

  return trimmedEndpointName;
}

/**
 * Build the persisted payload for an async `/ask` job.
 *
 * Purpose:
 * - Centralize serialization of async route metadata before queue insertion.
 *
 * Inputs/outputs:
 * - Input: normalized prompt, request context, and route metadata.
 * - Output: queue-safe payload stored in `job_data.input`.
 *
 * Edge case behavior:
 * - `clientContext: null` is normalized away so downstream response merging stays sparse.
 */
export function buildQueuedAskJobInput(input: {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  requestedVerbosity?: TrinityRequestedVerbosity;
  maxWords?: number | null;
  answerMode?: TrinityAnswerMode;
  debugPipeline?: boolean;
  strictUserVisibleOutput?: boolean;
  clientContext?: ClientContextDTO | null;
  endpointName?: string;
  auditFlag?: AsyncAskAuditFlag;
}): QueuedAskJobInput {
  const normalizedJobInput: QueuedAskJobInput = {
    prompt: input.prompt,
    endpointName: normalizeEndpointName(input.endpointName)
  };

  //audit Assumption: optional queue metadata should only be persisted when provided; failure risk: noisy null fields complicate worker parsing; expected invariant: absent metadata remains omitted; handling strategy: conditionally copy populated fields.
  if (input.sessionId) {
    normalizedJobInput.sessionId = input.sessionId;
  }
  if (input.overrideAuditSafe) {
    normalizedJobInput.overrideAuditSafe = input.overrideAuditSafe;
  }
  if (input.cognitiveDomain) {
    normalizedJobInput.cognitiveDomain = input.cognitiveDomain;
  }
  if (input.requestedVerbosity) {
    normalizedJobInput.requestedVerbosity = input.requestedVerbosity;
  }
  if (input.maxWords !== undefined) {
    normalizedJobInput.maxWords = input.maxWords;
  }
  if (input.answerMode) {
    normalizedJobInput.answerMode = input.answerMode;
  }
  if (typeof input.debugPipeline === 'boolean') {
    normalizedJobInput.debugPipeline = input.debugPipeline;
  }
  if (typeof input.strictUserVisibleOutput === 'boolean') {
    normalizedJobInput.strictUserVisibleOutput = input.strictUserVisibleOutput;
  }
  if (input.clientContext) {
    normalizedJobInput.clientContext = input.clientContext;
  }
  if (input.auditFlag) {
    normalizedJobInput.auditFlag = input.auditFlag;
  }

  return normalizedJobInput;
}

/**
 * Parse queued async `/ask` payloads read from the database.
 *
 * Purpose:
 * - Validate `job_data.input` before worker execution starts.
 *
 * Inputs/outputs:
 * - Input: raw JSON payload from `job_data.input`.
 * - Output: structured success/failure result for worker control flow.
 *
 * Edge case behavior:
 * - Invalid payloads return an explicit error string instead of throwing.
 */
export function parseQueuedAskJobInput(rawInput: unknown): ParsedQueuedAskJobInput {
  const parsedJobInput = queuedAskJobInputSchema.safeParse(rawInput);

  //audit Assumption: malformed queued payloads should fail the job explicitly rather than crashing the worker loop; failure risk: poison jobs repeatedly destabilize worker execution; expected invariant: invalid payloads surface as deterministic job failures; handling strategy: convert schema issues into one failure string.
  if (!parsedJobInput.success) {
    return {
      ok: false,
      error: parsedJobInput.error.issues
        .map(issue => `${issue.path.join('.') || 'job.input'}: ${issue.message}`)
        .join('; ')
    };
  }

  const normalizedJobInput = buildQueuedAskJobInput(parsedJobInput.data);
  return {
    ok: true,
    value: normalizedJobInput
  };
}

/**
 * Build the immediate HTTP 202 payload for queued `/ask` work.
 *
 * Purpose:
 * - Keep pending-response construction consistent across async ask callers.
 *
 * Inputs/outputs:
 * - Input: persisted job identifier.
 * - Output: polling response body returned by the route.
 *
 * Edge case behavior:
 * - Poll path is always derived directly from the same job identifier.
 */
export function buildQueuedAskPendingResponse(jobId: string): QueuedAskPendingResponse {
  return {
    ok: true,
    status: 'pending',
    jobId,
    poll: `/jobs/${jobId}`
  };
}

/**
 * Merge Trinity output with queued request metadata for `/jobs/:id`.
 *
 * Purpose:
 * - Preserve sync `/ask` response affordances after background execution.
 *
 * Inputs/outputs:
 * - Input: completed Trinity result and normalized queued metadata.
 * - Output: enriched async response payload stored in `job_data.output`.
 *
 * Edge case behavior:
 * - Optional `clientContext` and `auditFlag` are omitted when absent to keep payloads compact.
 */
export function buildCompletedQueuedAskOutput(
  trinityResult: TrinityResult,
  jobInput: QueuedAskJobInput
): CompletedQueuedAskJobOutput {
  return buildTrinityUserVisibleResponse({
    trinityResult,
    endpoint: jobInput.endpointName,
    clientContext: jobInput.clientContext,
    auditFlag: jobInput.auditFlag
  });
}

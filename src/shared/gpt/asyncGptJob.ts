import { z } from 'zod';
import type { GptAsyncWriteAction } from './gptJobResult.js';

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
  routeHint: z.string().trim().min(1).max(64).optional(),
  requestPath: z.string().trim().min(1).max(256).optional(),
  executionModeReason: z.string().trim().min(1).max(128).optional()
}).passthrough();

export interface QueuedGptJobInput {
  gptId: string;
  body: Record<string, unknown>;
  prompt?: string;
  bypassIntentRouting?: boolean;
  requestId?: string;
  routeHint?: string;
  requestPath?: string;
  executionModeReason?: string;
}

export interface QueuedGptPendingResponse {
  ok: true;
  action: GptAsyncWriteAction;
  status: 'pending';
  jobId: string;
  poll: string;
  stream: string;
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
  routeHint?: string | null;
  requestPath?: string | null;
  executionModeReason?: string | null;
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

  const normalizedRequestId = normalizeOptionalString(input.requestId ?? undefined);
  if (normalizedRequestId) {
    normalizedJobInput.requestId = normalizedRequestId;
  }

  const normalizedRouteHint = normalizeOptionalString(input.routeHint ?? undefined);
  if (normalizedRouteHint) {
    normalizedJobInput.routeHint = normalizedRouteHint;
  }

  const normalizedRequestPath = normalizeOptionalString(input.requestPath ?? undefined);
  if (normalizedRequestPath) {
    normalizedJobInput.requestPath = normalizedRequestPath;
  }

  const normalizedExecutionModeReason = normalizeOptionalString(
    input.executionModeReason ?? undefined
  );
  if (normalizedExecutionModeReason) {
    normalizedJobInput.executionModeReason = normalizedExecutionModeReason;
  }

  return normalizedJobInput;
}

/**
 * Parse queued async GPT payloads read from `job_data.input`.
 * Purpose: fail malformed queue payloads deterministically before worker execution starts.
 * Inputs/outputs: accepts unknown persisted JSON and returns a structured validation result.
 * Edge case behavior: schema issues are aggregated into one explicit failure string.
 */
export function parseQueuedGptJobInput(rawInput: unknown): ParsedQueuedGptJobInput {
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
    status: 'pending',
    jobId: input.jobId,
    poll: `/jobs/${input.jobId}`,
    stream: `/jobs/${input.jobId}/stream`,
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

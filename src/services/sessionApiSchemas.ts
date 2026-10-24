/**
 * Zod schemas for the canonical ARCANOS session API.
 *
 * Purpose:
 * - Keep public API payloads deterministic and machine-verifiable at runtime.
 */

import { z } from 'zod';
import { legacyInteger } from '@shared/validation/zodNumberChecks.js';
import { legacyDatetime, legacyUuid } from '@shared/validation/zodStringChecks.js';

export const SessionApiErrorResponseSchema = z.object({
  error: z.string().min(1),
  code: z.number().check(...legacyInteger()).positive(),
  details: z.array(z.string()).optional()
});

export const SessionApiHealthResponseSchema = z.object({
  status: z.enum(['live', 'degraded', 'offline']),
  service: z.literal('ARCANOS'),
  buildId: z.string().min(1),
  routeCount: z.number().check(...legacyInteger()).nonnegative(),
  timestamp: z.string().check(legacyDatetime())
});

export const SessionApiRouteTableResponseSchema = z.object({
  routes: z.array(z.string().min(1)),
  timestamp: z.string().check(legacyDatetime())
});

export const SessionApiSessionSystemDiagnosticsSchema = z.object({
  status: z.enum(['live', 'degraded', 'offline']),
  storage: z.enum(['postgres']),
  routes: z.array(z.string().min(1)),
  queueConnected: z.boolean(),
  buildId: z.string().min(1),
  timestamp: z.string().check(legacyDatetime())
});

export const SessionApiQueueDiagnosticsSchema = z.object({
  status: z.enum(['live', 'degraded', 'offline']),
  workerRunning: z.boolean(),
  queueDepth: z.number().check(...legacyInteger()).nonnegative(),
  failureRate: z.number().min(0).max(1),
  historicalFailureRate: z.number().min(0).max(1),
  failureRateWindowMs: z.number().check(...legacyInteger()).nonnegative(),
  windowCompletedJobs: z.number().check(...legacyInteger()).nonnegative(),
  windowFailedJobs: z.number().check(...legacyInteger()).nonnegative(),
  windowTerminalJobs: z.number().check(...legacyInteger()).nonnegative(),
  failureBreakdown: z.object({
    retryable: z.number().check(...legacyInteger()).nonnegative(),
    permanent: z.number().check(...legacyInteger()).nonnegative(),
    retryScheduled: z.number().check(...legacyInteger()).nonnegative(),
    retryExhausted: z.number().check(...legacyInteger()).nonnegative(),
    deadLetter: z.number().check(...legacyInteger()).nonnegative(),
    authentication: z.number().check(...legacyInteger()).nonnegative(),
    network: z.number().check(...legacyInteger()).nonnegative(),
    provider: z.number().check(...legacyInteger()).nonnegative(),
    rateLimited: z.number().check(...legacyInteger()).nonnegative(),
    timeout: z.number().check(...legacyInteger()).nonnegative(),
    validation: z.number().check(...legacyInteger()).nonnegative(),
    unknown: z.number().check(...legacyInteger()).nonnegative()
  }),
  recentFailureReasons: z.array(z.object({
    reason: z.enum([
      'Authentication failure.',
      'Network failure.',
      'Provider failure.',
      'Rate limit failure.',
      'Timeout failure.',
      'Validation failure.',
      'Worker job failure.'
    ]),
    category: z.enum([
      'authentication',
      'network',
      'provider',
      'rate_limited',
      'timeout',
      'validation',
      'unknown'
    ]),
    retryable: z.boolean().nullable(),
    count: z.number().check(...legacyInteger()).nonnegative(),
    lastSeenAt: z.string().check(legacyDatetime())
  })),
  lastJobStatus: z.string().nullable(),
  lastJobFinishedAt: z.string().check(legacyDatetime()).nullable(),
  timestamp: z.string().check(legacyDatetime())
});

export const SessionApiStorageDiagnosticsSchema = z.object({
  status: z.enum(['live', 'degraded', 'offline']),
  storage: z.enum(['postgres']),
  databaseConnected: z.boolean(),
  sessionCount: z.number().check(...legacyInteger()).nonnegative(),
  sessionVersionCount: z.number().check(...legacyInteger()).nonnegative(),
  buildId: z.string().min(1),
  timestamp: z.string().check(legacyDatetime())
});

export const SessionApiCreateResponseSchema = z.object({
  id: z.string().check(legacyUuid()),
  saved: z.literal(true),
  storage: z.enum(['postgres']),
  createdAt: z.string().check(legacyDatetime())
});

export const SessionApiSessionDetailSchema = z.object({
  id: z.string().check(legacyUuid()),
  label: z.string().min(1),
  tag: z.string().nullable(),
  memoryType: z.string().min(1),
  payload: z.unknown().optional(),
  transcriptSummary: z.string().nullable(),
  auditTraceId: z.string().nullable(),
  createdAt: z.string().check(legacyDatetime()),
  updatedAt: z.string().check(legacyDatetime())
});

export const SessionApiSessionListItemSchema = z.object({
  id: z.string().check(legacyUuid()),
  label: z.string().min(1),
  tag: z.string().nullable(),
  memoryType: z.string().min(1),
  createdAt: z.string().check(legacyDatetime()),
  updatedAt: z.string().check(legacyDatetime())
});

export const SessionApiSessionListResponseSchema = z.object({
  items: z.array(SessionApiSessionListItemSchema),
  total: z.number().check(...legacyInteger()).nonnegative()
});

export const SessionApiReplayResponseSchema = z.object({
  sessionId: z.string().check(legacyUuid()),
  replayedVersion: z.number().check(...legacyInteger()).positive(),
  mode: z.literal('readonly'),
  payload: z.unknown().optional(),
  auditTraceId: z.string().nullable(),
  replayedAt: z.string().check(legacyDatetime())
});

/**
 * Validate one public session API payload before it is returned.
 *
 * Purpose:
 * - Guarantee runtime responses match the declared public API schemas.
 *
 * Inputs/outputs:
 * - Input: zod schema, unknown payload, and a schema label for debugging.
 * - Output: validated payload with the target type.
 *
 * Edge case behavior:
 * - Throws a descriptive error when the payload does not match the schema.
 */
export function validateSessionApiPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  schemaLabel: string
): T {
  const parsedPayload = schema.safeParse(payload);

  //audit Assumption: public API responses must fail closed when the runtime payload drifts from the contract; failure risk: clients receive ambiguous or partial JSON that looks valid; expected invariant: every response conforms to the declared schema; handling strategy: throw with a stable schema label so the route can return a structured 500.
  if (!parsedPayload.success) {
    throw new Error(`Invalid session API payload for ${schemaLabel}`);
  }

  return parsedPayload.data;
}

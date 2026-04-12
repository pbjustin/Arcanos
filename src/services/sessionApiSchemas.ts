/**
 * Zod schemas for the canonical ARCANOS session API.
 *
 * Purpose:
 * - Keep public API payloads deterministic and machine-verifiable at runtime.
 */

import { z } from 'zod';

export const SessionApiErrorResponseSchema = z.object({
  error: z.string().min(1),
  code: z.number().int().positive(),
  details: z.array(z.string()).optional()
});

export const SessionApiHealthResponseSchema = z.object({
  status: z.enum(['live', 'degraded', 'offline']),
  service: z.literal('ARCANOS'),
  buildId: z.string().min(1),
  routeCount: z.number().int().nonnegative(),
  timestamp: z.string().datetime()
});

export const SessionApiRouteTableResponseSchema = z.object({
  routes: z.array(z.string().min(1)),
  timestamp: z.string().datetime()
});

export const SessionApiSessionSystemDiagnosticsSchema = z.object({
  status: z.enum(['live', 'degraded', 'offline']),
  storage: z.enum(['postgres']),
  routes: z.array(z.string().min(1)),
  queueConnected: z.boolean(),
  buildId: z.string().min(1),
  timestamp: z.string().datetime()
});

export const SessionApiQueueDiagnosticsSchema = z.object({
  status: z.enum(['live', 'degraded', 'offline']),
  workerRunning: z.boolean(),
  queueDepth: z.number().int().nonnegative(),
  failureRate: z.number().min(0).max(1),
  historicalFailureRate: z.number().min(0).max(1),
  failureRateWindowMs: z.number().int().nonnegative(),
  windowCompletedJobs: z.number().int().nonnegative(),
  windowFailedJobs: z.number().int().nonnegative(),
  windowTerminalJobs: z.number().int().nonnegative(),
  failureBreakdown: z.object({
    retryable: z.number().int().nonnegative(),
    permanent: z.number().int().nonnegative(),
    retryScheduled: z.number().int().nonnegative(),
    retryExhausted: z.number().int().nonnegative(),
    deadLetter: z.number().int().nonnegative(),
    authentication: z.number().int().nonnegative(),
    network: z.number().int().nonnegative(),
    provider: z.number().int().nonnegative(),
    rateLimited: z.number().int().nonnegative(),
    timeout: z.number().int().nonnegative(),
    validation: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative()
  }),
  recentFailureReasons: z.array(z.object({
    reason: z.string().min(1),
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
    count: z.number().int().nonnegative(),
    lastSeenAt: z.string().datetime()
  })),
  lastJobId: z.string().nullable(),
  lastJobStatus: z.string().nullable(),
  lastJobFinishedAt: z.string().datetime().nullable(),
  timestamp: z.string().datetime()
});

export const SessionApiStorageDiagnosticsSchema = z.object({
  status: z.enum(['live', 'degraded', 'offline']),
  storage: z.enum(['postgres']),
  databaseConnected: z.boolean(),
  sessionCount: z.number().int().nonnegative(),
  sessionVersionCount: z.number().int().nonnegative(),
  buildId: z.string().min(1),
  timestamp: z.string().datetime()
});

export const SessionApiCreateResponseSchema = z.object({
  id: z.string().uuid(),
  saved: z.literal(true),
  storage: z.enum(['postgres']),
  createdAt: z.string().datetime()
});

export const SessionApiSessionDetailSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
  tag: z.string().nullable(),
  memoryType: z.string().min(1),
  payload: z.unknown(),
  transcriptSummary: z.string().nullable(),
  auditTraceId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const SessionApiSessionListItemSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
  tag: z.string().nullable(),
  memoryType: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const SessionApiSessionListResponseSchema = z.object({
  items: z.array(SessionApiSessionListItemSchema),
  total: z.number().int().nonnegative()
});

export const SessionApiReplayResponseSchema = z.object({
  sessionId: z.string().uuid(),
  replayedVersion: z.number().int().positive(),
  mode: z.literal('readonly'),
  payload: z.unknown(),
  auditTraceId: z.string().nullable(),
  replayedAt: z.string().datetime()
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

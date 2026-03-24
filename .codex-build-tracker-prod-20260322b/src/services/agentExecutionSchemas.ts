/**
 * Runtime schemas for the capability-planner execution API.
 */

import { z } from 'zod';

export const AgentExecutionTraceEventSchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string().min(1),
  metadata: z.record(z.unknown())
});

export const AgentExecutionPlannedStepSchema = z.object({
  stepId: z.string().min(1),
  capabilityId: z.string().min(1),
  reason: z.string().min(1),
  dependsOnStepIds: z.array(z.string().min(1)),
  capabilityPayload: z.record(z.unknown())
});

export const AgentCommandStepExecutionResultSchema = z.object({
  stepId: z.string().min(1),
  capabilityId: z.string().min(1),
  commandName: z.string().min(1),
  status: z.enum(['completed', 'failed', 'skipped']),
  success: z.boolean(),
  message: z.string().min(1),
  output: z.unknown().nullable(),
  commandMetadata: z.record(z.unknown()).nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  error: z.string().nullable()
});

export const AgentDagExecutionSummarySchema = z.object({
  dagId: z.string().min(1),
  status: z.enum(['success', 'failed', 'cancelled']),
  failedNodeIds: z.array(z.string().min(1)),
  skippedNodeIds: z.array(z.string().min(1)),
  cancelledNodeIds: z.array(z.string().min(1)),
  tokenBudgetUsed: z.number().int().nonnegative(),
  totalAiCalls: z.number().int().nonnegative(),
  totalRetries: z.number().int().nonnegative(),
  maxParallelNodesObserved: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime()
});

export const AgentExecutionResponseSchema = z.object({
  executionId: z.string().min(1),
  traceId: z.string().min(1),
  goal: z.string().min(1),
  planner: z.object({
    planId: z.string().min(1),
    executionMode: z.enum(['serial', 'dag']),
    selectedCapabilityIds: z.array(z.string().min(1)),
    steps: z.array(AgentExecutionPlannedStepSchema)
  }),
  execution: z.object({
    status: z.enum(['completed', 'failed']),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    steps: z.array(AgentCommandStepExecutionResultSchema),
    dagSummary: AgentDagExecutionSummarySchema.nullable(),
    finalOutput: z.unknown().nullable()
  }),
  logs: z.array(AgentExecutionTraceEventSchema)
});

/**
 * Validate one agent-execution payload before returning it publicly.
 *
 * Purpose:
 * - Guarantee `/api/agent/execute` responses remain deterministic and schema-stable.
 *
 * Inputs/outputs:
 * - Input: zod schema, unknown payload, and a schema label.
 * - Output: validated payload of the target type.
 *
 * Edge case behavior:
 * - Throws when the payload drifts from the declared public schema.
 */
export function validateAgentExecutionPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  schemaLabel: string
): T {
  const parsedPayload = schema.safeParse(payload);

  //audit Assumption: the agent execution API must fail closed on response drift; failure risk: callers receive partially structured payloads that break orchestration clients; expected invariant: every public response matches its declared schema; handling strategy: throw with the schema label to force a structured 500 response.
  if (!parsedPayload.success) {
    throw new Error(`Invalid agent execution payload for ${schemaLabel}`);
  }

  return parsedPayload.data;
}

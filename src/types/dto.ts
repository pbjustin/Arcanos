import { z } from 'zod';

const stringField = z
  .string()
  .trim()
  .min(1, 'Input text must include at least one character')
  .max(6000, 'Input text exceeds maximum length of 6000 characters');

export const aiRequestSchema = z
  .object({
    prompt: stringField.optional(),
    userInput: stringField.optional(),
    content: stringField.optional(),
    text: stringField.optional(),
    query: stringField.optional(),
    sessionId: z
      .string()
      .trim()
      .max(100, 'Session identifier cannot exceed 100 characters')
      .optional(),
    overrideAuditSafe: z
      .string()
      .trim()
      .max(50, 'Override token cannot exceed 50 characters')
      .optional()
  })
  .refine(
    data =>
      Boolean(
        data.prompt ||
          data.userInput ||
          data.content ||
          data.text ||
          data.query
      ),
    {
      message: 'Request must include one of prompt, userInput, content, text, or query fields',
      path: ['prompt']
    }
  );

export type AIRequestDTO = z.infer<typeof aiRequestSchema>;

export const tokenUsageSchema = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative()
});

export const aiResponseSchema = z.object({
  result: z.string(),
  module: z.string().optional(),
  endpoint: z.string().optional(),
  meta: z.object({
    tokens: tokenUsageSchema.optional(),
    id: z.string(),
    created: z.number().nonnegative()
  }),
  activeModel: z.string().optional(),
  fallbackFlag: z.boolean().optional(),
  error: z.string().optional()
});

export type AIResponseDTO = z.infer<typeof aiResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string(),
  details: z.union([z.string(), z.array(z.string())]).optional()
});

export type ErrorResponseDTO = z.infer<typeof errorResponseSchema>;

export const workerInfoSchema = z.object({
  id: z.string(),
  description: z.string(),
  file: z.string(),
  available: z.boolean(),
  error: z.string().optional()
});

export type WorkerInfoDTO = z.infer<typeof workerInfoSchema>;

const arcanosRuntimeSchema = z.object({
  enabled: z.boolean(),
  model: z.string(),
  configuredCount: z.number(),
  started: z.boolean(),
  startedAt: z.string().optional(),
  activeListeners: z.number(),
  workerIds: z.array(z.string()),
  totalDispatched: z.number(),
  lastDispatchAt: z.string().optional(),
  lastInputPreview: z.string().optional(),
  lastResult: z.unknown().optional(),
  lastError: z.string().optional()
});

export const workerStatusResponseSchema = z.object({
  timestamp: z.string(),
  workersDirectory: z.string(),
  totalWorkers: z.number(),
  availableWorkers: z.number(),
  workers: z.array(workerInfoSchema),
  arcanosWorkers: z.object({
    enabled: z.boolean(),
    count: z.number(),
    model: z.string(),
    status: z.string(),
    runtime: arcanosRuntimeSchema
  }),
  system: z.object({
    model: z.string(),
    environment: z.string()
  })
});

export type WorkerStatusResponseDTO = z.infer<typeof workerStatusResponseSchema>;

export const workerRunResponseSchema = z.object({
  success: z.boolean(),
  workerId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  pattern: z.enum(['context-based', 'legacy', 'arcanos-core']).optional(),
  result: z.unknown().optional(),
  executionTime: z.string(),
  timestamp: z.string(),
  error: z.string().optional(),
  message: z.string().optional()
});

export type WorkerRunResponseDTO = z.infer<typeof workerRunResponseSchema>;

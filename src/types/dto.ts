/**
 * Data Transfer Object (DTO) Schemas and Types
 * 
 * This module defines Zod validation schemas and TypeScript types for API requests
 * and responses throughout the Arcanos backend. All schemas enforce runtime validation
 * to ensure type safety and data integrity at API boundaries.
 */

import { z } from 'zod';

/**
 * Client context captured from frontend hints.
 * Preserves normalized prompts and routing directives so callers can
 * render the exact context that was attached to a request.
 */
export const clientContextSchema = z.object({
  basePrompt: z.string().trim().max(6000, 'Base prompt exceeds maximum length of 6000 characters').optional(),
  normalizedPrompt: z
    .string()
    .trim()
    .max(8000, 'Normalized prompt exceeds maximum length of 8000 characters')
    .optional(),
  routingDirectives: z.array(z.string()).max(50, 'Too many routing directives provided').optional(),
  flags: z
    .object({
      domain: z.string().trim().max(120, 'Domain hint cannot exceed 120 characters').optional(),
      useRAG: z.boolean().optional(),
      useHRC: z.boolean().optional(),
      metadataKeys: z.array(z.string().trim()).max(50, 'Too many metadata keys provided').optional(),
      sourceField: z.string().trim().max(50, 'Source field hint cannot exceed 50 characters').optional(),
      httpMethodIntent: z
        .object({
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
          signals: z.array(z.string().trim()).max(20, 'Too many HTTP intent signals provided').optional(),
          confidence: z.enum(['high', 'medium', 'low']).optional()
        })
        .optional()
    })
    .optional()
});

export type ClientContextDTO = z.infer<typeof clientContextSchema>;

/**
 * Reusable string field validator for text inputs.
 * Enforces trimming, minimum length of 1 character, and maximum of 6000 characters.
 */
const stringField = z
  .string()
  .trim()
  .min(1, 'Input text must include at least one character')
  .max(6000, 'Input text exceeds maximum length of 6000 characters');

/**
 * Schema for AI request payloads.
 * Accepts multiple field names (prompt, userInput, content, text, query) to accommodate
 * various API endpoints. At least one text field must be provided.
 */
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
      .optional(),
    clientContext: clientContextSchema.optional()
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

/**
 * AI request data transfer object type inferred from the validation schema.
 */
export type AIRequestDTO = z.infer<typeof aiRequestSchema>;

/**
 * Schema for OpenAI token usage metrics.
 * Tracks prompt, completion, and total token consumption for cost analysis and monitoring.
 */
export const tokenUsageSchema = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative()
});

/**
 * Schema for AI response payloads.
 * Includes the AI-generated result, metadata about the request, and optional
 * dataset harvest information for auditing and learning purposes.
 */
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
  error: z.string().optional(),
  clientContext: clientContextSchema.optional(),
  datasetHarvest: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string(),
        confidence: z.enum(['high', 'medium', 'low']),
        tags: z.array(z.string()),
        memoryKey: z.string(),
        stored: z.boolean(),
        persistedAt: z.string(),
        requestId: z.string().optional(),
        sessionId: z.string().optional()
      })
    )
    .optional()
});

/**
 * AI response data transfer object type inferred from the validation schema.
 */
export type AIResponseDTO = z.infer<typeof aiResponseSchema>;

/**
 * Schema for standardized error responses.
 * Provides consistent error messaging across all API endpoints.
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  details: z.union([z.string(), z.array(z.string())]).optional()
});

/**
 * Error response data transfer object type inferred from the validation schema.
 */
export type ErrorResponseDTO = z.infer<typeof errorResponseSchema>;

/**
 * Schema for individual worker module information.
 * Describes a single background worker's availability, location, and error state.
 */
export const workerInfoSchema = z.object({
  id: z.string(),
  description: z.string(),
  file: z.string(),
  available: z.boolean(),
  error: z.string().optional()
});

/**
 * Worker information data transfer object type inferred from the validation schema.
 */
export type WorkerInfoDTO = z.infer<typeof workerInfoSchema>;

/**
 * Internal schema for ARCANOS worker runtime state.
 * Tracks worker lifecycle, dispatch history, and recent execution results.
 */
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

/**
 * Schema for comprehensive worker status responses.
 * Aggregates information about all workers, ARCANOS-specific workers, and system configuration.
 */
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
  }),
  autoHeal: z
    .object({
      status: z.enum(['ok', 'warning', 'critical']),
      failingWorkers: z.array(z.string()).optional(),
      lastError: z.string().optional(),
      recommendedAction: z.string().optional()
    })
    .optional()
});

/**
 * Worker status response data transfer object type inferred from the validation schema.
 */
export type WorkerStatusResponseDTO = z.infer<typeof workerStatusResponseSchema>;

export type AutoHealStatusDTO = NonNullable<WorkerStatusResponseDTO['autoHeal']>;

/**
 * Schema for worker execution results.
 * Reports success/failure, execution time, and any output or errors from the worker run.
 */
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

/**
 * Worker run response data transfer object type inferred from the validation schema.
 */
export type WorkerRunResponseDTO = z.infer<typeof workerRunResponseSchema>;

// Worker Parameter Validation - Zod schemas for all worker dispatch parameters
import { z } from 'zod';

// Base worker task schema
export const workerTaskSchema = z.object({
  name: z.string().min(1, "Worker name is required"),
  type: z.enum(['background', 'scheduled', 'ondemand']).default('ondemand'),
  parameters: z.record(z.any()).optional(),
  priority: z.number().int().min(1).max(10).default(5),
  timeout: z.number().int().min(1000).max(300000).default(30000), // 1s to 5min
  retryAttempts: z.number().int().min(0).max(5).default(2),
  metadata: z.record(z.any()).optional()
}).strict();

// Worker dispatch request schema
export const workerDispatchSchema = z.object({
  worker: z.string().min(1, "Worker identifier is required"),
  action: z.string().min(1, "Action is required"),
  payload: z.record(z.any()).optional(),
  context: z.object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    source: z.enum(['api', 'internal', 'cron', 'worker', 'system']),
    metadata: z.record(z.any()).optional()
  }).optional(),
  options: z.object({
    timeout: z.number().int().min(1000).max(300000).default(30000),
    retryAttempts: z.number().int().min(0).max(5).default(2),
    priority: z.number().int().min(1).max(10).default(5)
  }).optional()
}).strict();

// OpenAI orchestration parameters schema
export const openaiOrchestrationSchema = z.object({
  model: z.string().min(1).default('gpt-4-turbo'),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1)
  })).min(1),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(4096).default(1000),
  timeout: z.number().int().min(1000).max(60000).default(30000)
}).strict();

// Worker registration schema
export const workerRegistrationSchema = z.object({
  name: z.string().min(1, "Worker name is required"),
  orchestrator: z.function().optional(),
  config: z.object({
    enabled: z.boolean().default(true),
    maxConcurrent: z.number().int().min(1).max(10).default(1),
    timeout: z.number().int().min(1000).max(300000).default(30000),
    retryAttempts: z.number().int().min(0).max(5).default(2)
  }).optional()
}).strict();

// Export type definitions
export type WorkerTask = z.infer<typeof workerTaskSchema>;
export type WorkerDispatch = z.infer<typeof workerDispatchSchema>;
export type OpenAIOrchestration = z.infer<typeof openaiOrchestrationSchema>;
export type WorkerRegistration = z.infer<typeof workerRegistrationSchema>;

// Validation functions
export function validateWorkerTask(input: unknown): WorkerTask {
  try {
    return workerTaskSchema.parse(input);
  } catch (error) {
    throw new Error(`Invalid worker task: ${error instanceof z.ZodError ? error.errors.map(e => e.message).join(', ') : error}`);
  }
}

export function validateWorkerDispatch(input: unknown): WorkerDispatch {
  try {
    return workerDispatchSchema.parse(input);
  } catch (error) {
    throw new Error(`Invalid worker dispatch: ${error instanceof z.ZodError ? error.errors.map(e => e.message).join(', ') : error}`);
  }
}

export function validateOpenAIOrchestration(input: unknown): OpenAIOrchestration {
  try {
    return openaiOrchestrationSchema.parse(input);
  } catch (error) {
    throw new Error(`Invalid OpenAI orchestration: ${error instanceof z.ZodError ? error.errors.map(e => e.message).join(', ') : error}`);
  }
}

export function validateWorkerRegistration(input: unknown): WorkerRegistration {
  try {
    return workerRegistrationSchema.parse(input);
  } catch (error) {
    throw new Error(`Invalid worker registration: ${error instanceof z.ZodError ? error.errors.map(e => e.message).join(', ') : error}`);
  }
}

// Known worker names validation
export const KNOWN_WORKERS = [
  'goalTracker',
  'maintenanceScheduler', 
  'emailDispatcher',
  'auditProcessor',
  'memorySync',
  'goalWatcher',
  'clearTemp'
] as const;

export function isKnownWorker(workerName: string): boolean {
  return KNOWN_WORKERS.includes(workerName as any);
}

export function validateKnownWorker(workerName: string): void {
  if (!isKnownWorker(workerName)) {
    throw new Error(`Unknown worker: ${workerName}. Known workers: ${KNOWN_WORKERS.join(', ')}`);
  }
}
// Worker Parameter Validation - Clear Zod schemas with unambiguous validation
import { z } from 'zod';

// Explicit worker types to prevent ambiguity
export const WORKER_TYPES = ['background', 'scheduled', 'ondemand', 'system'] as const;
export const SOURCE_TYPES = ['api', 'internal', 'cron', 'worker', 'system'] as const;

// Base worker task schema with clear validation rules
export const workerTaskSchema = z.object({
  name: z.string().min(1, "Worker name is required").max(50, "Worker name too long"),
  type: z.enum(WORKER_TYPES).default('ondemand'),
  parameters: z.record(z.any()).optional(),
  priority: z.number().int().min(1).max(10).default(5),
  timeout: z.number().int().min(1000).max(300000).default(30000), // 1s to 5min
  retryAttempts: z.number().int().min(0).max(5).default(2),
  metadata: z.record(z.any()).optional()
}).strict();

// Worker dispatch request schema with clear context requirements
export const workerDispatchSchema = z.object({
  worker: z.string().min(1, "Worker identifier is required").regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Worker name must start with letter and contain only alphanumeric and underscore"),
  action: z.string().min(1, "Action is required").regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "Action must start with letter and contain only alphanumeric, underscore, and dash"),
  payload: z.record(z.any()).optional(),
  context: z.object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    source: z.enum(SOURCE_TYPES),
    metadata: z.record(z.any()).optional()
  }).strict().optional(),
  options: z.object({
    timeout: z.number().int().min(1000).max(300000).default(30000),
    retryAttempts: z.number().int().min(0).max(5).default(2),
    priority: z.number().int().min(1).max(10).default(5)
  }).strict().optional()
}).strict();

// OpenAI orchestration parameters schema with explicit model validation
export const openaiOrchestrationSchema = z.object({
  model: z.string().min(1).refine(
    (model) => model.startsWith('gpt-') || model.startsWith('ft:'), 
    "Model must be valid GPT model or fine-tuned model"
  ).default('gpt-4-turbo'),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1, "Message content cannot be empty")
  })).min(1, "At least one message is required"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(4096).default(1000),
  timeout: z.number().int().min(1000).max(60000).default(30000)
}).strict();

// Worker registration schema with clear constraints
export const workerRegistrationSchema = z.object({
  name: z.string().min(1, "Worker name is required").regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Worker name must follow naming convention"),
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

// Validation functions with clear error handling
export function validateWorkerTask(input: unknown): WorkerTask {
  try {
    return workerTaskSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`);
      throw new Error(`Worker task validation failed: ${errorMessages.join(', ')}`);
    }
    throw new Error(`Invalid worker task: ${error}`);
  }
}

export function validateWorkerDispatch(input: unknown): WorkerDispatch {
  try {
    return workerDispatchSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`);
      throw new Error(`Worker dispatch validation failed: ${errorMessages.join(', ')}`);
    }
    throw new Error(`Invalid worker dispatch: ${error}`);
  }
}

export function validateOpenAIOrchestration(input: unknown): OpenAIOrchestration {
  try {
    return openaiOrchestrationSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`);
      throw new Error(`OpenAI orchestration validation failed: ${errorMessages.join(', ')}`);
    }
    throw new Error(`Invalid OpenAI orchestration: ${error}`);
  }
}

export function validateWorkerRegistration(input: unknown): WorkerRegistration {
  try {
    return workerRegistrationSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`);
      throw new Error(`Worker registration validation failed: ${errorMessages.join(', ')}`);
    }
    throw new Error(`Invalid worker registration: ${error}`);
  }
}

// Clear worker registry with explicit validation
export const KNOWN_WORKERS = [
  'goalTracker',
  'maintenanceScheduler', 
  'emailDispatcher',
  'auditProcessor',
  'memorySync',
  'goalWatcher',
  'clearTemp'
] as const;

export type KnownWorker = typeof KNOWN_WORKERS[number];

export function isKnownWorker(workerName: string): workerName is KnownWorker {
  return (KNOWN_WORKERS as readonly string[]).includes(workerName);
}

export function validateKnownWorker(workerName: string): asserts workerName is KnownWorker {
  if (!isKnownWorker(workerName)) {
    throw new Error(`Unknown worker: '${workerName}'. Known workers: [${KNOWN_WORKERS.join(', ')}]`);
  }
}

// Clear worker-action combination validation to prevent ambiguous routing
export const WORKER_ACTION_COMBINATIONS = new Map<KnownWorker, string[]>([
  ['goalTracker', ['start', 'stop', 'status', 'track']],
  ['maintenanceScheduler', ['schedule', 'run', 'status']],
  ['emailDispatcher', ['send', 'queue', 'status']],
  ['auditProcessor', ['audit', 'process', 'report']],
  ['memorySync', ['sync', 'backup', 'restore']],
  ['goalWatcher', ['watch', 'notify', 'status']],
  ['clearTemp', ['clean', 'purge', 'status']]
]);

export function validateWorkerAction(worker: string, action: string): void {
  validateKnownWorker(worker);
  
  const validActions = WORKER_ACTION_COMBINATIONS.get(worker);
  if (validActions && !validActions.includes(action)) {
    throw new Error(`Invalid action '${action}' for worker '${worker}'. Valid actions: [${validActions.join(', ')}]`);
  }
}

// Enhanced validation to prevent routing conflicts
export function validateRoutingPath(worker: string, action: string, subAction?: string): string {
  validateWorkerAction(worker, action);
  
  const pathParts = [worker, action];
  if (subAction) {
    // Validate subAction format
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(subAction)) {
      throw new Error(`Invalid subAction format: '${subAction}'. Must start with letter and contain only alphanumeric and underscore.`);
    }
    pathParts.push(subAction);
  }
  
  return pathParts.join('::');
}
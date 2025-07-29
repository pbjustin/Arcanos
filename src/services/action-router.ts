import { executionEngine } from './execution-engine';
import { DispatchInstruction } from './ai-dispatcher';
import { createServiceLogger } from '../utils/logger';
import { memoryOperations } from './memory-operations';
import { activeWorkers } from '../worker-init';
import * as cron from 'node-cron';

const logger = createServiceLogger('ActionRouter');

export interface ActionHandler {
  (instruction: DispatchInstruction): any;
}

export interface ActionContext {
  memory: {
    append: (key: string, value: any) => Promise<void>;
  };
  invokeWorker: (worker: string, task: any) => Promise<void>;
}

// Store for registered action handlers
const registeredActions = new Map<string, (payload: any, context: ActionContext) => any>();

// Streamlined action handlers - no fallback logic
const actions: Record<string, ActionHandler> = {
  respond: (instruction: DispatchInstruction) => executionEngine.handleResponse(instruction),
  execute: (instruction: DispatchInstruction) => executionEngine.handleExecution(instruction),
  schedule: (instruction: DispatchInstruction) => executionEngine.handleSchedule(instruction),
  delegate: (instruction: DispatchInstruction) => executionEngine.handleDelegation(instruction),
  write: (instruction: DispatchInstruction) => executionEngine.executeWriteOperation(instruction.parameters || {}),
};

export function routeAction(instruction: DispatchInstruction) {
  // Check for registered sub-actions first (e.g., "write::registerCronJob")
  if (instruction.action && instruction.service) {
    const actionKey = `${instruction.action}::${instruction.service}`;
    const registeredHandler = registeredActions.get(actionKey);
    if (registeredHandler) {
      const context = createActionContext();
      return registeredHandler(instruction.parameters || {}, context);
    }
  }

  const handler = actions[instruction.action];
  if (handler) {
    return handler(instruction);
  }
  
  // No fallback - fail fast for unknown actions
  logger.error(`Unknown action: ${instruction.action}`);
  return { success: false, error: `Unknown action: ${instruction.action}` };
}

/**
 * Create action context with memory and worker invocation capabilities
 */
function createActionContext(): ActionContext {
  return {
    memory: {
      append: async (key: string, value: any) => {
        await memoryOperations.storeMemory({
          userId: 'system',
          sessionId: 'cron-actions',
          content: JSON.stringify({ [key]: value }),
          metadata: {
            type: 'system',
            importance: 'medium',
            timestamp: new Date().toISOString(),
            tags: [key, 'cron', 'error-log']
          }
        });
      }
    },
    invokeWorker: async (worker: string, task: any) => {
      const workerContext = activeWorkers.get(worker);
      if (workerContext && workerContext.instance) {
        await workerContext.instance(task);
      } else {
        throw new Error(`Worker not found or not started: ${worker}`);
      }
    }
  };
}

/**
 * Router object with register method for action registration
 */
export const router = {
  register: (actionName: string, handler: (payload: any, context: ActionContext) => any) => {
    registeredActions.set(actionName, handler);
    logger.info(`Registered action handler: ${actionName}`);
  }
};

// Register the cron job action as specified in the problem statement
router.register("write::registerCronJob", async (payload, context) => {
  try {
    const { worker, schedule, task } = payload;

    // Schema validation
    if (!worker || !schedule || !task) {
      throw new Error("Missing required fields: worker, schedule, or task");
    }

    // Example cron job registration logic
    const cron = require("node-cron");
    cron.schedule(schedule, async () => {
      try {
        console.log(`[CRON] Triggering task for ${worker}: ${task}`);
        await context.invokeWorker(worker, task);
      } catch (cronErr) {
        console.error(`[CRON ERROR] Failed task for ${worker}:`, cronErr);
      }
    });

    return {
      status: "registered",
      worker,
      schedule,
      task
    };
  } catch (err: any) {
    // Fallback logging for OpenAI-triggered errors
    console.error("[ACTION ERROR] write::registerCronJob failed:", err);
    await context.memory.append("cronErrors", {
      error: err.message,
      payload,
      timestamp: new Date().toISOString()
    });

    return {
      status: "failed",
      reason: err.message
    };
  }
});

export { actions };
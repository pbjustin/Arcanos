import { executionEngine } from './execution-engine.js';
import { DispatchInstruction } from './ai-dispatcher.js';
import { createServiceLogger } from '../utils/logger.js';
import { memoryOperations } from './memory-operations.js';
import { activeWorkers } from '../worker-init.js';
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

// Store for registered action handlers with clear hierarchy
const registeredActions = new Map<string, (payload: any, context: ActionContext) => any>();

// Clear action handlers with explicit routing - no ambiguous fallbacks
const actions: Record<string, ActionHandler> = {
  respond: (instruction: DispatchInstruction) => executionEngine.handleResponse(instruction),
  execute: (instruction: DispatchInstruction) => executionEngine.handleExecution(instruction),
  schedule: (instruction: DispatchInstruction) => executionEngine.handleSchedule(instruction),
  delegate: (instruction: DispatchInstruction) => executionEngine.handleDelegation(instruction),
  write: (instruction: DispatchInstruction) => executionEngine.executeWriteOperation(instruction.parameters || {}),
};

export function routeAction(instruction: DispatchInstruction) {
  // Clear routing hierarchy: action::service::subaction format
  // This removes ambiguity between similar action names
  const routingKey = buildRoutingKey(instruction);
  
  // Check for registered handlers using unambiguous key
  const registeredHandler = registeredActions.get(routingKey);
  if (registeredHandler) {
    const context = createActionContext();
    return registeredHandler(instruction.parameters || {}, context);
  }

  // Fallback to base action if no specific handler found
  const handler = actions[instruction.action];
  if (handler) {
    return handler(instruction);
  }
  
  // Clear error handling - no ambiguous routing attempts
  const errorMessage = `No handler found for action routing key: ${routingKey}`;
  logger.error(errorMessage, { instruction });
  return { success: false, error: errorMessage, routingKey };
}

/**
 * Build unambiguous routing key to eliminate nested rule conflicts
 */
function buildRoutingKey(instruction: DispatchInstruction): string {
  const parts = [instruction.action];
  
  if (instruction.service) {
    parts.push(instruction.service);
  }
  
  // Add sub-action if present in parameters
  if (instruction.parameters?.subAction) {
    parts.push(instruction.parameters.subAction);
  }
  
  return parts.join('::');
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
      // Check if worker exists in active workers registry
      const workerContext = activeWorkers.get(worker);
      if (workerContext) {
        if (workerContext.instance && typeof workerContext.instance === 'function') {
          // Worker has an instance function, call it
          await workerContext.instance(task);
        } else {
          // Worker is registered but doesn't have a callable instance
          // This is normal during testing when workers aren't fully started
          console.log(`[CRON] Worker ${worker} is registered but not started - task would be executed:`, task);
        }
      } else {
        throw new Error(`Worker not found or not started: ${worker}`);
      }
    }
  };
}

/**
 * Router object with clear registration method to avoid action conflicts
 */
export const router = {
  register: (actionName: string, handler: (payload: any, context: ActionContext) => any) => {
    // Validate actionName follows clear routing pattern
    if (!actionName.includes('::')) {
      logger.warning(`Action name should follow 'action::service' pattern: ${actionName}`);
    }
    
    if (registeredActions.has(actionName)) {
      logger.warning(`Overwriting existing handler for: ${actionName}`);
    }
    
    registeredActions.set(actionName, handler);
    logger.info(`Registered unambiguous action handler: ${actionName}`);
  },
  
  // Add method to list all registered actions for debugging
  list: () => {
    return Array.from(registeredActions.keys()).sort();
  },
  
  // Method to check for routing conflicts
  validateRouting: () => {
    const conflicts: string[] = [];
    const actionKeys = Array.from(registeredActions.keys());
    
    // Check for potential conflicts (same prefix with different suffixes)
    for (let i = 0; i < actionKeys.length; i++) {
      for (let j = i + 1; j < actionKeys.length; j++) {
        const key1 = actionKeys[i];
        const key2 = actionKeys[j];
        
        // Check if one key is a prefix of another (potential ambiguity)
        if (key1.startsWith(key2) || key2.startsWith(key1)) {
          conflicts.push(`Potential conflict: ${key1} <-> ${key2}`);
        }
      }
    }
    
    if (conflicts.length > 0) {
      logger.warning('Potential routing conflicts detected:', conflicts);
    }
    
    return conflicts;
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
    const { default: cron } = await import("node-cron");
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
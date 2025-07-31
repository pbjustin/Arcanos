/**
 * AI-Enhanced Service Dispatcher
 * Refactored to use AI-defined logic for service routing with fallback prevention
 * 
 * Features:
 * - AI-controlled service routing
 * - Disabled fallback to defaultWorker unless manually triggered
 * - Memory and API services routed through AI-bound flows
 * - Manual override logic for emergency fallback access
 * - OpenAI SDK v5.10+ compatible
 */

import { createServiceLogger } from '../utils/logger';
import { aiDispatcher, type DispatchRequest, type DispatchResponse } from '../services/ai-dispatcher';

const logger = createServiceLogger('AIServiceDispatcher');

export interface ServiceTask {
  service: 'memory' | 'api' | string;
  worker?: string;
  action?: string;
  data?: any;
  context?: {
    userId?: string;
    sessionId?: string;
    manualOverride?: boolean;
    bypassAI?: boolean;
  };
}

export interface ServiceResponse {
  success: boolean;
  data?: any;
  error?: string;
  route?: {
    service: string;
    worker: string;
    aiDecision: boolean;
  };
  metadata?: {
    timestamp: string;
    processingTime: number;
    aiInstructions?: any[];
  };
}

/**
 * Main AI-enhanced service dispatcher
 * Routes services through AI decision making or direct worker assignment
 */
export async function dispatchService(task: ServiceTask): Promise<ServiceResponse> {
  const startTime = Date.now();
  logger.info('AI Service Dispatcher processing task', { 
    service: task.service, 
    worker: task.worker,
    manualOverride: task.context?.manualOverride 
  });

  try {
    // Disable fallback to defaultWorker unless manually triggered
    if (task.worker === 'defaultWorker' && !task.context?.manualOverride) {
      throw new Error('Fallback to defaultWorker is disabled. Define a specific worker.');
    }

    let routingResult: ServiceResponse;

    // Route memory and API services through AI-bound flows
    if ((task.service === 'memory' || task.service === 'api') && !task.context?.bypassAI) {
      routingResult = await routeViaAI(task);
    } else {
      routingResult = await routeDirectly(task);
    }

    // Add manual override logic if needed
    if (task.context?.manualOverride && task.worker === 'defaultWorker') {
      logger.warning('[OVERRIDE] Executing fallback defaultWorker...');
      routingResult = await executeDefaultWorkerOverride(task);
    }

    const processingTime = Date.now() - startTime;
    logger.success(`Service dispatch completed in ${processingTime}ms`, { 
      service: task.service,
      worker: routingResult.route?.worker
    });

    return {
      ...routingResult,
      metadata: {
        ...routingResult.metadata,
        timestamp: routingResult.metadata?.timestamp || new Date().toISOString(),
        processingTime
      }
    };

  } catch (error: any) {
    const processingTime = Date.now() - startTime;
    logger.error('Service dispatch failed', { 
      service: task.service, 
      error: error.message, 
      processingTime 
    });

    return {
      success: false,
      error: error.message,
      metadata: {
        timestamp: new Date().toISOString(),
        processingTime
      }
    };
  }
}

/**
 * Route service through AI decision making
 */
async function routeViaAI(task: ServiceTask): Promise<ServiceResponse> {
  logger.info('Routing via AI dispatcher', { service: task.service });

  // Create AI dispatch request
  const aiRequest: DispatchRequest = {
    type: task.service as any,
    payload: {
      action: task.action,
      data: task.data,
      worker: task.worker
    },
    context: {
      userId: task.context?.userId,
      sessionId: task.context?.sessionId
    }
  };

  // Get AI routing decision
  const aiResponse: DispatchResponse = await aiDispatcher.dispatch(aiRequest);

  if (!aiResponse.success) {
    throw new Error(`AI routing failed: ${aiResponse.error}`);
  }

  // Execute AI instructions
  const results = [];
  for (const instruction of aiResponse.instructions) {
    if (instruction.execute) {
      const result = await executeInstruction(instruction, task);
      results.push(result);
    }
  }

  return {
    success: true,
    data: results.length === 1 ? results[0] : results,
    route: {
      service: task.service,
      worker: aiResponse.instructions[0]?.worker || 'ai-determined',
      aiDecision: true
    },
    metadata: {
      timestamp: new Date().toISOString(),
      processingTime: 0, // Will be updated by caller
      aiInstructions: aiResponse.instructions
    }
  };
}

/**
 * Route service directly to specified worker
 */
async function routeDirectly(task: ServiceTask): Promise<ServiceResponse> {
  logger.info('Routing directly', { service: task.service, worker: task.worker });

  let result: any;

  // Route to service-specific workers
  switch (task.service) {
    case 'memory':
      result = await executeMemoryWorker(task);
      break;
    case 'api':
      result = await executeApiWorker(task);
      break;
    default:
      throw new Error(`Unrecognized service: ${task.service}`);
  }

  return {
    success: true,
    data: result,
    route: {
      service: task.service,
      worker: task.worker || `${task.service}Worker`,
      aiDecision: false
    },
    metadata: {
      timestamp: new Date().toISOString(),
      processingTime: 0
    }
  };
}

/**
 * Execute AI instruction by routing to appropriate worker
 */
async function executeInstruction(instruction: any, originalTask: ServiceTask): Promise<any> {
  logger.info('Executing AI instruction', { 
    action: instruction.action, 
    service: instruction.service,
    worker: instruction.worker 
  });

  switch (instruction.service) {
    case 'memory':
      return await executeMemoryWorker({
        ...originalTask,
        service: 'memory',
        worker: instruction.worker,
        action: instruction.action,
        data: instruction.parameters
      });

    case 'api':
      return await executeApiWorker({
        ...originalTask,
        service: 'api',
        worker: instruction.worker,
        action: instruction.action,
        data: instruction.parameters
      });

    case 'worker':
      if (instruction.worker) {
        return await executeWorkerByName(instruction.worker, {
          action: instruction.action,
          data: instruction.parameters
        });
      }
      break;

    default:
      return {
        executed: true,
        action: instruction.action,
        response: instruction.response || 'AI instruction processed'
      };
  }
}

/**
 * Execute memory worker
 */
async function executeMemoryWorker(task: ServiceTask): Promise<any> {
  const { handle } = await import('../workers/memoryWorker');
  
  const memoryTask = {
    action: (task.action as 'store' | 'retrieve' | 'delete' | 'sync' | 'snapshot') || 'retrieve',
    key: task.data?.key,
    data: task.data?.value || task.data,
    options: task.data?.options || {}
  };

  const result = await handle(memoryTask);
  logger.info('Memory worker executed', { success: result.success });
  
  return result;
}

/**
 * Execute API worker
 */
async function executeApiWorker(task: ServiceTask): Promise<any> {
  const { handle } = await import('../workers/apiWorker');
  
  const apiTask = {
    action: (task.action as 'request' | 'webhook' | 'proxy' | 'batch' | 'monitor') || 'request',
    method: task.data?.method,
    url: task.data?.url,
    data: task.data?.payload || task.data?.data,
    headers: task.data?.headers,
    options: task.data?.options || {}
  };

  const result = await handle(apiTask);
  logger.info('API worker executed', { success: result.success });
  
  return result;
}

/**
 * Execute default worker with manual override
 */
async function executeDefaultWorkerOverride(task: ServiceTask): Promise<ServiceResponse> {
  logger.warning('[OVERRIDE] Executing fallback defaultWorker...');
  
  const { handle, isAuthorized } = await import('../workers/defaultWorker');
  
  if (!isAuthorized(task.context?.manualOverride)) {
    throw new Error('DefaultWorker access denied: Manual override not properly authorized');
  }

  const defaultTask = {
    action: task.action || 'process',
    data: task.data,
    context: {
      manualOverride: true,
      reason: 'Manual override triggered',
      originalService: task.service
    }
  };

  const result = await handle(defaultTask);
  
  return {
    success: result.success,
    data: result.data,
    error: result.error,
    route: {
      service: task.service,
      worker: 'defaultWorker',
      aiDecision: false
    },
    metadata: {
      timestamp: new Date().toISOString(),
      processingTime: 0
    }
  };
}

/**
 * Execute worker by name (for AI-determined workers)
 */
async function executeWorkerByName(workerName: string, taskData: any): Promise<any> {
  logger.info('Executing worker by name', { worker: workerName });

  switch (workerName) {
    case 'memorySync':
      const { default: memorySync } = await import('../workers/memorySync');
      return await memorySync();

    case 'goalWatcher':
      const { default: goalWatcher } = await import('../workers/goalWatcher');
      return await goalWatcher();

    case 'clearTemp':
      const { default: clearTemp } = await import('../workers/clearTemp');
      return await clearTemp();

    default:
      logger.warning('Unknown worker requested by AI', { worker: workerName });
      return {
        executed: false,
        error: `Unknown worker: ${workerName}`,
        recommendation: 'Define worker or update AI routing logic'
      };
  }
}

/**
 * Utility function to create a manual override task
 */
export function createManualOverrideTask(
  service: string,
  data: any,
  userId?: string
): ServiceTask {
  return {
    service,
    worker: 'defaultWorker',
    data,
    context: {
      userId,
      manualOverride: true,
      bypassAI: true
    }
  };
}

/**
 * Utility function to check if a service requires AI routing
 */
export function requiresAIRouting(service: string): boolean {
  return service === 'memory' || service === 'api';
}

// Export the main dispatcher function as default
export default dispatchService;
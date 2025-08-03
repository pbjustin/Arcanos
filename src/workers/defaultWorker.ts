/**
 * Default Worker - Fallback worker for unhandled tasks
 * Only used when manual override is explicitly enabled
 * WARNING: This worker should not be used in normal operation
 */

import { createServiceLogger } from '../utils/logger.js';

const logger = createServiceLogger('DefaultWorker');

export interface DefaultTask {
  action: string;
  data?: any;
  context?: {
    reason?: string;
    originalService?: string;
    manualOverride?: boolean;
  };
}

export interface DefaultResponse {
  success: boolean;
  data?: any;
  error?: string;
  warning?: string;
  metadata?: {
    timestamp: string;
    processingTime?: number;
    fallbackReason?: string;
  };
}

/**
 * Main default worker handler function
 * Should only be called with explicit manual override
 */
export async function handle(task: DefaultTask): Promise<DefaultResponse> {
  const startTime = Date.now();
  
  // Log warning about fallback usage
  logger.warning('DefaultWorker invoked - this should only happen with manual override', {
    action: task.action,
    manualOverride: task.context?.manualOverride,
    originalService: task.context?.originalService
  });

  try {
    // Validate that manual override is enabled
    if (!task.context?.manualOverride) {
      throw new Error('DefaultWorker access denied: Manual override not enabled');
    }

    let result: any;

    switch (task.action) {
      case 'process':
        result = await processGenericTask(task);
        break;
      
      case 'log':
        result = await logTask(task);
        break;
      
      case 'notify':
        result = await notifyTask(task);
        break;
      
      case 'health':
        result = await healthCheck();
        break;
      
      default:
        result = await fallbackProcessor(task);
        break;
    }

    const processingTime = Date.now() - startTime;
    
    logger.warning(`DefaultWorker task completed in ${processingTime}ms`, { 
      action: task.action,
      warning: 'Consider routing this task to a specific worker'
    });

    return {
      success: true,
      data: result,
      warning: 'Task processed by fallback DefaultWorker - consider using specific worker',
      metadata: {
        timestamp: new Date().toISOString(),
        processingTime,
        fallbackReason: task.context?.reason || 'Manual override enabled'
      }
    };

  } catch (error: any) {
    const processingTime = Date.now() - startTime;
    
    logger.error('DefaultWorker task failed', { 
      action: task.action, 
      error: error.message, 
      processingTime 
    });

    return {
      success: false,
      error: error.message,
      warning: 'DefaultWorker should not be used for normal operations',
      metadata: {
        timestamp: new Date().toISOString(),
        processingTime,
        fallbackReason: task.context?.reason || 'Unknown'
      }
    };
  }
}

/**
 * Process generic task with basic handling
 */
async function processGenericTask(task: DefaultTask): Promise<any> {
  logger.info('Processing generic task in DefaultWorker', { 
    dataSize: task.data ? JSON.stringify(task.data).length : 0 
  });

  // Basic task processing - just return the data with processing metadata
  return {
    processed: true,
    originalData: task.data,
    processedAt: new Date().toISOString(),
    processor: 'DefaultWorker',
    warning: 'This is a fallback processor - task should be routed to specific worker'
  };
}

/**
 * Log task data for debugging
 */
async function logTask(task: DefaultTask): Promise<any> {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    source: 'DefaultWorker',
    data: task.data,
    context: task.context
  };

  logger.info('DefaultWorker log task', logEntry);

  return {
    logged: true,
    entry: logEntry,
    message: 'Task data logged via DefaultWorker fallback'
  };
}

/**
 * Send notification about task processing
 */
async function notifyTask(task: DefaultTask): Promise<any> {
  const notification = {
    timestamp: new Date().toISOString(),
    type: 'default_worker_notification',
    message: task.data?.message || 'DefaultWorker notification triggered',
    severity: 'warning',
    context: task.context
  };

  logger.warning('DefaultWorker notification sent', notification);

  return {
    notified: true,
    notification,
    message: 'Notification sent via DefaultWorker - consider using NotificationWorker'
  };
}

/**
 * Perform basic health check
 */
async function healthCheck(): Promise<any> {
  const health = {
    status: 'degraded', // Always degraded since this is a fallback
    timestamp: new Date().toISOString(),
    worker: 'DefaultWorker',
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    uptime: process.uptime(),
    warning: 'Health check performed by DefaultWorker fallback'
  };

  logger.info('DefaultWorker health check', health);
  return health;
}

/**
 * Fallback processor for unknown actions
 */
async function fallbackProcessor(task: DefaultTask): Promise<any> {
  logger.warning('Fallback processor handling unknown action', { 
    action: task.action,
    hasData: !!task.data
  });

  return {
    processed: true,
    action: task.action,
    data: task.data,
    message: `Unknown action "${task.action}" processed by DefaultWorker fallback`,
    recommendation: 'Define specific worker for this action type',
    timestamp: new Date().toISOString()
  };
}

/**
 * Utility function to check if DefaultWorker usage is authorized
 */
export function isAuthorized(manualOverride: boolean = false): boolean {
  if (!manualOverride) {
    logger.error('Unauthorized DefaultWorker access attempt');
    return false;
  }
  
  logger.warning('DefaultWorker access authorized via manual override');
  return true;
}

/**
 * Create a properly configured DefaultTask with manual override
 */
export function createManualOverrideTask(
  action: string, 
  data: any, 
  reason: string = 'Manual override triggered'
): DefaultTask {
  return {
    action,
    data,
    context: {
      manualOverride: true,
      reason,
      originalService: 'unknown'
    }
  };
}
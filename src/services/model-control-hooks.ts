// ARCANOS Model Control Hooks - Unified control interface for AI model to manage system operations
// Provides hooks for memory management, audits, cron triggers, and worker orchestration

import { aiDispatcher, DispatchRequest } from './ai-dispatcher';
import { executionEngine, ExecutionResult } from './execution-engine';

export interface ModelControlContext {
  userId?: string;
  sessionId?: string;
  source: 'api' | 'internal' | 'cron' | 'worker' | 'system';
  metadata?: Record<string, any>;
}

export interface ModelControlResult {
  success: boolean;
  response?: string;
  results?: ExecutionResult[];
  error?: string;
}

export class ModelControlHooks {
  
  /**
   * Main entry point - all system operations flow through this hook
   */
  async processRequest(
    type: string,
    payload: any,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    console.log('🎛️ Model control hook processing:', {
      type,
      source: context.source,
      userId: context.userId
    });

    try {
      // Create dispatch request for the AI model
      const dispatchRequest: DispatchRequest = {
        type: this.mapTypeToDispatchType(type),
        endpoint: this.extractEndpoint(type, payload),
        method: payload.method || 'POST',
        payload,
        context: {
          userId: context.userId,
          sessionId: context.sessionId,
          headers: context.metadata?.headers || {}
        }
      };

      // Send to AI dispatcher for decision making
      const dispatchResponse = await aiDispatcher.dispatch(dispatchRequest);

      if (!dispatchResponse.success) {
        return {
          success: false,
          error: dispatchResponse.error
        };
      }

      // Execute the AI's instructions
      const results = await executionEngine.executeInstructions(dispatchResponse.instructions);

      // Extract primary response
      const primaryResponse = dispatchResponse.directResponse || 
                             results.find(r => r.response)?.response ||
                             'Operation completed';

      return {
        success: true,
        response: primaryResponse,
        results
      };

    } catch (error: any) {
      console.error('❌ Model control hook error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Memory management hook - AI controls all memory operations
   */
  async manageMemory(
    operation: 'store' | 'load' | 'list' | 'clear',
    data: any,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    return await this.processRequest('memory', {
      operation,
      ...data
    }, {
      ...context,
      source: 'internal'
    });
  }

  /**
   * Audit control hook - AI controls when and how audits are performed
   */
  async performAudit(
    target: any,
    auditType: string,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    return await this.processRequest('audit', {
      target,
      auditType,
      timestamp: new Date().toISOString()
    }, {
      ...context,
      source: 'internal'
    });
  }

  /**
   * Cron trigger hook - AI controls scheduling and execution of recurring tasks
   */
  async handleCronTrigger(
    triggerName: string,
    scheduleExpression: string,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    return await this.processRequest('cron', {
      trigger: triggerName,
      schedule: scheduleExpression,
      timestamp: new Date().toISOString()
    }, {
      ...context,
      source: 'cron'
    });
  }

  /**
   * Worker orchestration hook - AI controls which workers run and when
   */
  async orchestrateWorker(
    workerName: string,
    workerType: 'background' | 'scheduled' | 'ondemand',
    parameters: any,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    return await this.processRequest('worker', {
      worker: workerName,
      type: workerType,
      parameters,
      timestamp: new Date().toISOString()
    }, {
      ...context,
      source: 'worker'
    });
  }

  /**
   * API request hook - AI controls all incoming API requests
   */
  async handleApiRequest(
    endpoint: string,
    method: string,
    payload: any,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    return await this.processRequest('api', {
      endpoint,
      method,
      ...payload
    }, {
      ...context,
      source: 'api'
    });
  }

  /**
   * System maintenance hook - AI controls system maintenance operations
   */
  async performMaintenance(
    maintenanceType: string,
    parameters: any,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    return await this.processRequest('maintenance', {
      type: maintenanceType,
      parameters,
      timestamp: new Date().toISOString()
    }, {
      ...context,
      source: 'system'
    });
  }

  /**
   * Emergency override hook - Direct AI control for critical situations
   */
  async emergencyOverride(
    situation: string,
    urgencyLevel: number,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    console.log('🚨 Emergency override triggered:', situation);
    
    return await this.processRequest('emergency', {
      situation,
      urgency: urgencyLevel,
      timestamp: new Date().toISOString(),
      requiresImmediate: urgencyLevel >= 8
    }, {
      ...context,
      source: 'system'
    });
  }

  /**
   * Batch operation hook - AI controls multiple operations as a group
   */
  async processBatch(
    operations: Array<{type: string, payload: any}>,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    const results: ModelControlResult[] = [];
    
    for (const operation of operations) {
      const result = await this.processRequest(operation.type, operation.payload, context);
      results.push(result);
      
      // Stop batch if any operation fails and it's marked as critical
      if (!result.success && operation.payload.critical) {
        break;
      }
    }
    
    const allSuccessful = results.every(r => r.success);
    const responses = results.map(r => r.response).filter(Boolean);
    
    return {
      success: allSuccessful,
      response: responses.join('\n'),
      results: results.flatMap(r => r.results || [])
    };
  }

  /**
   * Health check hook - AI monitors and controls system health
   */
  async checkSystemHealth(context: ModelControlContext): Promise<ModelControlResult> {
    return await this.processRequest('health', {
      timestamp: new Date().toISOString(),
      requestedBy: context.userId || 'system'
    }, {
      ...context,
      source: 'system'
    });
  }

  /**
   * Configuration update hook - AI controls configuration changes
   */
  async updateConfiguration(
    configPath: string,
    newValue: any,
    context: ModelControlContext
  ): Promise<ModelControlResult> {
    return await this.processRequest('config', {
      path: configPath,
      value: newValue,
      timestamp: new Date().toISOString()
    }, {
      ...context,
      source: 'system'
    });
  }

  /**
   * Map request types to dispatch types
   */
  private mapTypeToDispatchType(type: string): 'api' | 'internal' | 'worker' | 'cron' | 'memory' | 'audit' {
    const typeMap: Record<string, any> = {
      'memory': 'memory',
      'audit': 'audit',
      'cron': 'cron',
      'worker': 'worker',
      'api': 'api',
      'maintenance': 'internal',
      'emergency': 'internal',
      'health': 'internal',
      'config': 'internal'
    };
    
    return typeMap[type] || 'internal';
  }

  /**
   * Extract endpoint from request
   */
  private extractEndpoint(type: string, payload: any): string | undefined {
    if (payload.endpoint) return payload.endpoint;
    if (type === 'api') return payload.path || payload.url;
    return undefined;
  }
}

// Export singleton instance
export const modelControlHooks = new ModelControlHooks();

// Export convenience functions for easy access
export const memoryControl = (operation: string, data: any, context: ModelControlContext) =>
  modelControlHooks.manageMemory(operation as any, data, context);

export const auditControl = (target: any, type: string, context: ModelControlContext) =>
  modelControlHooks.performAudit(target, type, context);

export const cronControl = (name: string, schedule: string, context: ModelControlContext) =>
  modelControlHooks.handleCronTrigger(name, schedule, context);

export const workerControl = (name: string, type: string, params: any, context: ModelControlContext) =>
  modelControlHooks.orchestrateWorker(name, type as any, params, context);

export const apiControl = (endpoint: string, method: string, payload: any, context: ModelControlContext) =>
  modelControlHooks.handleApiRequest(endpoint, method, payload, context);
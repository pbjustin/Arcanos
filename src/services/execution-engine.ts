// ARCANOS Execution Engine - Streamlined for OpenAI SDK patterns
// Provides efficient execution for AI-controlled operations

import { DispatchInstruction } from './ai-dispatcher';
import { OpenAIService } from './openai';
import { aiConfig } from '../config';
import { memoryOperations } from './memory-operations';
import { diagnosticsService } from './diagnostics';
import { workerStatusService } from './worker-status';
import * as cron from 'node-cron';
import { databaseService } from './database';
import { isValidWorker } from './worker-manager';
import { activeWorkers } from '../worker-init';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('ExecutionEngine');

// Streamlined worker validation - uses active worker registry
function validateWorkerRegistration(name: string): boolean {
  return activeWorkers.has(name);
}

export interface ExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  response?: string;
}

export class ExecutionEngine {
  private openaiService: OpenAIService | null;
  private scheduledTasks: Map<string, cron.ScheduledTask> = new Map();

  constructor() {
    try {
      this.openaiService = new OpenAIService({
        identityOverride: aiConfig.identityOverride,
        identityTriggerPhrase: aiConfig.identityTriggerPhrase,
      });
    } catch (error) {
      console.warn('⚠️ Execution Engine initialized without OpenAI (testing mode)');
      this.openaiService = null;
    }
    console.log('⚙️ Execution Engine initialized with streamlined memory operations');
  }

  /**
   * Normalize worker identifiers that may be provided as objects
   */
  private normalizeWorker(input: any): string | undefined {
    if (!input) return undefined;
    if (typeof input === 'string') return input;
    return input.workerName || input.name || input.work;
  }

  /**
   * Execute a single instruction from the AI model
   */
  async executeInstruction(instruction: DispatchInstruction): Promise<ExecutionResult> {
    console.log('🔧 Executing instruction:', {
      action: instruction.action,
      service: instruction.service,
      worker: instruction.worker
    });

    try {
      if (!instruction.execute) {
        return {
          success: true,
          response: instruction.response
        };
      }

      // Route action using centralized action router
      const { routeAction } = await import('./action-router');
      return await routeAction(instruction);

    } catch (error: any) {
      console.error('❌ Execution error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute multiple instructions in sequence
   */
  async executeInstructions(instructions: DispatchInstruction[]): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    const cleaned = this.cleanScheduleQueue(instructions);

    // Sort by priority (higher numbers first)
    const sortedInstructions = cleaned.sort((a, b) => (b.priority || 5) - (a.priority || 5));
    
    for (const instruction of sortedInstructions) {
      instruction.worker = this.normalizeWorker(instruction.worker);

      if (instruction.action === 'schedule') {
        if (!instruction.worker) {
          results.push({ success: false, error: 'no_worker_specified' });
          continue;
        }
        if (!isValidWorker(instruction.worker)) {
          results.push({ success: false, error: `invalid_worker_format_${instruction.worker}` });
          continue;
        }
        if (!validateWorkerRegistration(instruction.worker)) {
          results.push({ success: false, error: `unregistered_worker_${instruction.worker}` });
          continue;
        }
      }

      const result = await this.executeInstruction(instruction);
      results.push(result);
      
      // If a high-priority instruction fails, consider stopping
      if (!result.success && (instruction.priority || 5) >= 8) {
        console.warn('⚠️ High-priority instruction failed, stopping execution');
        break;
      }
    }
    
    return results;
  }

  /**
   * Handle response action - return direct response to user
   */
  public handleResponse(instruction: DispatchInstruction): ExecutionResult {
    return {
      success: true,
      response: instruction.response || 'No response provided'
    };
  }

  /**
   * Handle execution action - execute service operations
   */
  public async handleExecution(instruction: DispatchInstruction): Promise<ExecutionResult> {
    const { service, parameters = {} } = instruction;

    switch (service) {
      case 'memory':
        return await this.executeMemoryOperation(parameters);
      
      case 'audit':
        return await this.executeAuditOperation(parameters);
      
      case 'write':
        return await this.executeWriteOperation(parameters);
      
      case 'diagnostic':
        return await this.executeDiagnosticOperation(parameters);
      
      case 'api':
        return await this.executeApiOperation(parameters);
      
      default:
        return {
          success: false,
          error: `Unknown service: ${service}`
        };
    }
  }

  /**
   * Handle schedule action - schedule recurring tasks
   */
  public handleSchedule(instruction: DispatchInstruction): ExecutionResult {
    const { schedule, parameters = {} } = instruction;
    let workerName = this.normalizeWorker(instruction.worker);

    if (!schedule) {
      return {
        success: false,
        error: 'Schedule expression required'
      };
    }

    if (!workerName) {
      return {
        success: false,
        error: 'Worker name required for scheduling'
      };
    }

    if (!isValidWorker(workerName)) {
      return {
        success: false,
        error: `Invalid worker format: ${workerName}`
      };
    }

    if (!validateWorkerRegistration(workerName)) {
      return {
        success: false,
        error: `Unregistered worker: ${workerName}`
      };
    }

    // Check if worker is registered in the active workers registry
    const workerContext = activeWorkers.get(workerName);
    if (!workerContext) {
      return {
        success: false,
        error: `Worker not found: ${workerName}`,
      };
    }

    try {
      const taskId = `${workerName || 'task'}_${Date.now()}`;
      
      const task = cron.schedule(schedule, async () => {
        console.log(`⏰ Executing scheduled task: ${taskId}`);
        
        if (workerName) {
          await this.executeWorker(workerName, parameters);
        } else {
          // Execute the instruction directly
          await this.executeInstruction({
            ...instruction,
            action: 'execute'
          });
        }
      }, {
        timezone: 'UTC'
      });

      this.scheduledTasks.set(taskId, task);
      // Task starts immediately with the schedule

      console.log(`✅ Scheduled task ${taskId} with expression: ${schedule}`);
      this.logScheduleDiagnostics(taskId, workerName, schedule);
      
      return {
        success: true,
        result: { taskId, schedule },
        response: `Task scheduled successfully: ${taskId}`
      };

    } catch (error: any) {
      return {
        success: false,
        error: `Failed to schedule task: ${error.message}`
      };
    }
  }

  /**
   * Handle delegation action - delegate to workers
   */
  public async handleDelegation(instruction: DispatchInstruction): Promise<ExecutionResult> {
    const workerName = this.normalizeWorker(instruction.worker);
    const { parameters = {} } = instruction;

    if (!workerName) {
      return {
        success: false,
        error: 'Worker name required for delegation'
      };
    }

    if (!validateWorkerRegistration(workerName)) {
      return {
        success: false,
        error: `Unregistered worker: ${workerName}`
      };
    }

    return await this.executeWorker(workerName, parameters);
  }

  /**
   * Execute memory operations using OpenAI SDK-compatible patterns
   */
  private async executeMemoryOperation(parameters: any): Promise<ExecutionResult> {
    const { operation, key, value, userId = 'system', sessionId = 'default' } = parameters;

    try {
      switch (operation) {
        case 'store':
        case 'save':
          const stored = await memoryOperations.storeMemory({
            userId,
            sessionId,
            content: typeof value === 'string' ? value : JSON.stringify(value),
            metadata: {
              type: parameters.type || 'context',
              importance: parameters.importance || 'medium',
              timestamp: new Date().toISOString(),
              tags: parameters.tags || [key]
            }
          });
          return {
            success: true,
            result: stored,
            response: `Memory stored: ${stored.id}`
          };

        case 'load':
        case 'get':
          // Search for memory by content or tags containing the key
          const searchResults = await memoryOperations.searchMemories({
            userId,
            sessionId,
            tags: [key],
            limit: 1
          });
          const loaded = searchResults[0] || null;
          return {
            success: true,
            result: loaded,
            response: loaded ? `Memory loaded: ${loaded.id}` : `Memory not found: ${key}`
          };

        case 'list':
        case 'all':
          const memories = await memoryOperations.searchMemories({
            userId,
            sessionId,
            limit: parameters.limit || 50
          });
          return {
            success: true,
            result: memories,
            response: `Found ${memories.length} memory entries`
          };

        case 'analyze':
          const analysis = await memoryOperations.analyzeMemoryContext(userId, sessionId);
          return {
            success: true,
            result: { analysis },
            response: analysis
          };

        case 'clear':
        case 'delete':
          const cleaned = await memoryOperations.cleanupMemories(userId, {
            olderThanDays: parameters.olderThanDays || 0,
            keepHighImportance: parameters.keepHighImportance || false
          });
          return {
            success: true,
            result: { cleaned },
            response: `Memory cleared: ${cleaned} entries`
          };

        default:
          return {
            success: false,
            error: `Unknown memory operation: ${operation}`
          };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute audit operations (code review, analysis)
   */
  private async executeAuditOperation(parameters: any): Promise<ExecutionResult> {
    const { code, message, type = 'general' } = parameters;

    if (!this.openaiService) {
      return {
        success: true,
        result: { audit: `Mock audit: ${type} analysis of provided content would be performed here.` },
        response: `Mock audit: ${type} analysis of provided content would be performed here.`
      };
    }

    try {
      const auditPrompt = `Please audit the following ${type}:

${code || message}

Provide a detailed analysis including:
1. Quality assessment
2. Security considerations
3. Performance implications
4. Best practices recommendations`;

      const response = await this.openaiService.chat([
        { role: 'user', content: auditPrompt }
      ]);

      return {
        success: !response.error,
        result: { audit: response.message },
        response: response.message,
        error: response.error
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute write operations (content generation)
   */
  public async executeWriteOperation(parameters: any): Promise<ExecutionResult> {
    const { prompt, type = 'general', style, length } = parameters;

    if (!this.openaiService) {
      return {
        success: true,
        result: { content: `Mock write: Generated ${type} content for "${prompt}" would appear here.` },
        response: `Mock write: Generated ${type} content for "${prompt}" would appear here.`
      };
    }

    try {
      let writePrompt = prompt;
      
      if (type !== 'general') {
        writePrompt = `Write ${type} content: ${prompt}`;
      }
      
      if (style) {
        writePrompt += ` (Style: ${style})`;
      }
      
      if (length) {
        writePrompt += ` (Length: ${length})`;
      }

      const response = await this.openaiService.chat([
        { role: 'user', content: writePrompt }
      ]);

      return {
        success: !response.error,
        result: { content: response.message },
        response: response.message,
        error: response.error
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute diagnostic operations
   */
  private async executeDiagnosticOperation(parameters: any): Promise<ExecutionResult> {
    const { command, type = 'system' } = parameters;

    try {
      const result = await diagnosticsService.executeDiagnosticCommand(command || type);
      
      return {
        success: result.success,
        result: result.data,
        response: JSON.stringify(result.data, null, 2),
        error: result.error
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute API operations
   */
  private async executeApiOperation(parameters: any): Promise<ExecutionResult> {
    const { response, status = 200 } = parameters;
    
    return {
      success: true,
      result: { status, response },
      response: response || 'API operation completed'
    };
  }

  /**
   * Execute worker operations
   */
  private async executeWorker(workerName: string, parameters: any = {}): Promise<ExecutionResult> {
    console.log(`👷 Executing worker: ${workerName}`);

    try {
      // Use the streamlined worker registry
      const workerContext = activeWorkers.get(workerName);
      if (workerContext && workerContext.instance) {
        await workerContext.instance(parameters);
        return { success: true, response: `${workerName} executed` };
      }
      
      // Direct worker execution for built-in workers
      switch (workerName) {
        case 'goalTracker':
          return await this.executeGoalTrackerWorker(parameters);
        
        case 'maintenanceScheduler':
          return await this.executeMaintenanceSchedulerWorker(parameters);
        
        case 'emailDispatcher':
          return await this.executeEmailDispatcherWorker(parameters);
          
        case 'auditProcessor':
          return await this.executeAuditProcessorWorker(parameters);
        
        default:
          return {
            success: false,
            error: `Unregistered worker: ${workerName}`
          };
      }

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute goal tracker worker
   */
  private async executeGoalTrackerWorker(parameters: any): Promise<ExecutionResult> {
    console.log('🎯 Running goal tracker worker');
    
    try {
      // Get goal-related memories and analyze them
      const goalMemories = await memoryOperations.searchMemories({
        userId: parameters.userId || 'system',
        tags: ['goal', 'objective', 'target'],
        limit: 20
      });
      
      console.log(`📊 Found ${goalMemories.length} goal-related entries`);
      
      return {
        success: true,
        result: { analyzed: goalMemories.length },
        response: `Goal tracking completed: ${goalMemories.length} entries analyzed`
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute maintenance scheduler worker
   */
  private async executeMaintenanceSchedulerWorker(parameters: any): Promise<ExecutionResult> {
    console.log('🔧 Running maintenance scheduler worker');
    
    try {
      // Perform maintenance tasks
      const cleaned = await memoryOperations.cleanupMemories('system', {
        olderThanDays: 7,
        keepHighImportance: true,
        maxRecords: 1000
      });
      
      console.log(`🧹 Cleaned ${cleaned} old memory entries`);
      
      return {
        success: true,
        result: { cleaned },
        response: `Maintenance completed: ${cleaned} entries cleaned`
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute email dispatcher worker
   */
  private async executeEmailDispatcherWorker(parameters: any): Promise<ExecutionResult> {
    console.log('📧 Running email dispatcher worker');
    
    try {
      // Email dispatch functionality would go here
      return {
        success: true,
        result: { dispatched: 0 },
        response: `Email dispatch completed`
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute audit processor worker
   */
  private async executeAuditProcessorWorker(parameters: any): Promise<ExecutionResult> {
    console.log('📊 Running audit processor worker');
    
    try {
      // Audit processing functionality would go here
      return {
        success: true,
        result: { processed: 0 },
        response: `Audit processing completed`
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Remove malformed or duplicate schedule instructions
   */
  private cleanScheduleQueue(queue: DispatchInstruction[]): DispatchInstruction[] {
    const seen = new Set<string>();
    return queue.filter(task => {
      if (task.action !== 'schedule') return true;
      const worker = this.normalizeWorker(task.worker);
      const hash = `${task.service || ''}-${worker}-${task.schedule}`;
      if (seen.has(hash)) return false;
      seen.add(hash);
      return !!worker && !!task.schedule;
    });
  }

  private logScheduleDiagnostics(taskId: string, worker: string, schedule: string): void {
    logger.info(`[SCHEDULE] Task "${taskId}" scheduled for "${worker}" at ${schedule}`);
  }

  /**
   * Stop a scheduled task
   */
  stopScheduledTask(taskId: string): boolean {
    const task = this.scheduledTasks.get(taskId);
    if (task) {
      task.stop();
      this.scheduledTasks.delete(taskId);
      console.log(`⏹️ Stopped scheduled task: ${taskId}`);
      return true;
    }
    return false;
  }

  /**
   * Get all scheduled tasks
   */
  getScheduledTasks(): string[] {
    return Array.from(this.scheduledTasks.keys());
  }
}

// Export singleton instance
export const executionEngine = new ExecutionEngine();
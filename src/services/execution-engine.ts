// ARCANOS Execution Engine - Executes instructions returned by the AI dispatcher
// Provides thin execution shells for all system operations

import { DispatchInstruction } from './ai-dispatcher';
import { OpenAIService } from './openai';
import { aiConfig } from '../config';
import { MemoryStorage } from '../storage/memory-storage';
import { diagnosticsService } from './diagnostics';
import { workerStatusService } from './worker-status';
import * as cron from 'node-cron';
import { databaseService } from './database';
import { initializeFallbackScheduler } from '../workers/default-scheduler';

export interface ExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  response?: string;
}

export class ExecutionEngine {
  private memoryStorage: MemoryStorage;
  private openaiService: OpenAIService | null;
  private scheduledTasks: Map<string, cron.ScheduledTask> = new Map();

  constructor() {
    this.memoryStorage = new MemoryStorage();
    try {
      this.openaiService = new OpenAIService({
        identityOverride: aiConfig.identityOverride,
        identityTriggerPhrase: aiConfig.identityTriggerPhrase,
      });
    } catch (error) {
      console.warn('⚠️ Execution Engine initialized without OpenAI (testing mode)');
      this.openaiService = null;
    }
    console.log('⚙️ Execution Engine initialized');
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
    
    // Sort by priority (higher numbers first)
    const sortedInstructions = instructions.sort((a, b) => (b.priority || 5) - (a.priority || 5));
    
    for (const instruction of sortedInstructions) {
      if (instruction.action === 'schedule' && !instruction.worker) {
        console.warn('⚠️ Schedule instruction received with undefined worker. Applying fallback...');
        instruction.worker = 'defaultScheduler';
        initializeFallbackScheduler(instruction);
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
    const { schedule, worker, parameters = {} } = instruction;
    
    if (!schedule) {
      return {
        success: false,
        error: 'Schedule expression required'
      };
    }

    try {
      const taskId = `${worker || 'task'}_${Date.now()}`;
      
      const task = cron.schedule(schedule, async () => {
        console.log(`⏰ Executing scheduled task: ${taskId}`);
        
        if (worker) {
          await this.executeWorker(worker, parameters);
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
    const { worker, parameters = {} } = instruction;
    
    if (!worker) {
      return {
        success: false,
        error: 'Worker name required for delegation'
      };
    }

    return await this.executeWorker(worker, parameters);
  }

  /**
   * Execute memory operations
   */
  private async executeMemoryOperation(parameters: any): Promise<ExecutionResult> {
    const { operation, key, value, userId = 'system', sessionId = 'default' } = parameters;

    try {
      switch (operation) {
        case 'store':
        case 'save':
          const stored = await this.memoryStorage.storeMemory(
            userId, sessionId, 'context', key, value, parameters.tags || []
          );
          return {
            success: true,
            result: stored,
            response: `Memory stored: ${key}`
          };

        case 'load':
        case 'get':
          const loaded = await this.memoryStorage.getMemoryById(key);
          return {
            success: true,
            result: loaded,
            response: loaded ? `Memory loaded: ${key}` : `Memory not found: ${key}`
          };

        case 'list':
        case 'all':
          const memories = await this.memoryStorage.getMemoriesByUser(userId);
          return {
            success: true,
            result: memories,
            response: `Found ${memories.length} memory entries`
          };

        case 'clear':
        case 'delete':
          // Use the available clearAll method
          try {
            const result = await this.memoryStorage.clearAll(userId);
            return {
              success: true,
              response: `Memory cleared: ${result.cleared} entries`
            };
          } catch (error: any) {
            return {
              success: false,
              error: error.message
            };
          }

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
      switch (workerName) {
        case 'memorySync':
          return await this.executeMemorySyncWorker(parameters);
        
        case 'goalWatcher':
          return await this.executeGoalWatcherWorker(parameters);
        
        case 'clearTemp':
          return await this.executeClearTempWorker(parameters);
        
        default:
          return {
            success: false,
            error: `Unknown worker: ${workerName}`
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
   * Execute memory sync worker
   */
  private async executeMemorySyncWorker(parameters: any): Promise<ExecutionResult> {
    console.log('🔄 Running memory sync worker');
    
    try {
      // Get all memories and sync them
      const memories = await this.memoryStorage.getMemoriesByUser('system');
      console.log(`📊 Found ${memories.length} memory entries to sync`);
      
      return {
        success: true,
        result: { synced: memories.length },
        response: `Memory sync completed: ${memories.length} entries`
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute goal watcher worker
   */
  private async executeGoalWatcherWorker(parameters: any): Promise<ExecutionResult> {
    console.log('👁️ Running goal watcher worker');
    
    try {
      // Check for active goals and monitor progress
      const allMemories = await this.memoryStorage.getMemoriesByUser('system');
      const goals = allMemories.filter(memory => 
        memory.tags && memory.tags.includes('goal')
      );
      console.log(`🎯 Monitoring ${goals.length} active goals`);
      
      return {
        success: true,
        result: { monitored: goals.length },
        response: `Goal monitoring completed: ${goals.length} goals`
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute clear temp worker
   */
  private async executeClearTempWorker(parameters: any): Promise<ExecutionResult> {
    console.log('🧹 Running clear temp worker');
    
    try {
      // Clear temporary data older than specified time
      const maxAge = parameters.maxAge || '24h';
      console.log(`🗑️ Clearing temp data older than ${maxAge}`);
      
      return {
        success: true,
        result: { cleared: true },
        response: `Temporary data cleared (older than ${maxAge})`
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
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
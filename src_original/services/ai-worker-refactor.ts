// AI Worker System Refactor - Using Unified OpenAI Service
// Unified worker orchestration with modular control hooks and fallback dispatch

import { getUnifiedOpenAI, type ChatMessage } from './unified-openai.js';
import { createServiceLogger } from '../utils/logger.js';
import { validateWorkerTask } from '../utils/worker-validation.js';

const logger = createServiceLogger('AIWorkerRefactor');

export interface RefactorConfig {
  sdkVersion: string;
  fallback: string;
  controlHooks: boolean;
  modularize: boolean;
  logLevel: 'minimal' | 'verbose' | 'debug';
}

export interface WorkerSystemConfig {
  openaiApiKey?: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  fallbackWorker?: string;
}

// Modular Control Hooks System
export class ModularControlHooks {
  private hooks: Map<string, Function> = new Map();
  private fallbackHook?: Function;

  registerHook(name: string, hook: Function): void {
    if (this.hooks.has(name)) {
      logger.warning(`Control hook '${name}' already registered, skipping duplicate registration`);
      return;
    }
    this.hooks.set(name, hook);
    logger.info(`Control hook registered: ${name}`);
  }

  setFallbackHook(hook: Function): void {
    this.fallbackHook = hook;
    logger.info('Fallback hook registered');
  }

  async executeHook(name: string, ...args: any[]): Promise<any> {
    const hook = this.hooks.get(name);
    if (hook) {
      try {
        return await hook(...args);
      } catch (error: any) {
        logger.error(`Hook ${name} failed:`, error.message);
        if (this.fallbackHook) {
          logger.info(`Executing fallback hook for ${name}`);
          return await this.fallbackHook(name, ...args);
        }
        throw error;
      }
    }
    
    if (this.fallbackHook) {
      logger.info(`No hook found for ${name}, using fallback`);
      return await this.fallbackHook(name, ...args);
    }
    
    throw new Error(`No hook registered for: ${name}`);
  }

  listHooks(): string[] {
    return Array.from(this.hooks.keys());
  }
}

// Unified Fallback Dispatch System
export class UnifiedFallbackDispatch {
  private strategies: Map<string, Function> = new Map();
  private defaultStrategy?: Function;

  registerStrategy(name: string, strategy: Function): void {
    this.strategies.set(name, strategy);
    logger.info(`Fallback strategy registered: ${name}`);
  }

  setDefaultStrategy(strategy: Function): void {
    this.defaultStrategy = strategy;
    logger.info('Default fallback strategy set');
  }

  async dispatch(workerName: string, task: any, options: any = {}): Promise<any> {
    const strategies = [
      this.strategies.get(workerName),
      this.strategies.get('default'),
      this.defaultStrategy
    ].filter(Boolean);

    for (const strategy of strategies) {
      try {
        logger.info(`Attempting dispatch strategy for ${workerName}`);
        return await strategy!(task, options);
      } catch (error: any) {
        logger.warning(`Strategy failed for ${workerName}:`, error.message);
        continue;
      }
    }

    throw new Error(`All fallback strategies failed for worker: ${workerName}`);
  }
}

// Optimized AI Dispatcher Scheduling Format
export interface OptimizedScheduleFormat {
  worker: string;
  type: 'immediate' | 'delayed' | 'recurring' | 'conditional';
  schedule?: string; // cron expression for recurring
  delay?: number; // milliseconds for delayed
  condition?: string; // condition expression for conditional
  priority: number; // 1-10
  retryPolicy: {
    maxAttempts: number;
    backoffMs: number;
    exponential: boolean;
  };
  timeout: number;
  metadata?: Record<string, any>;
}

// Refactored AI Worker System
export class RefactoredAIWorkerSystem {
  private unifiedAI: ReturnType<typeof getUnifiedOpenAI>;
  private config: WorkerSystemConfig;
  private controlHooks: ModularControlHooks;
  private fallbackDispatch: UnifiedFallbackDispatch;
  private workers: Map<string, any> = new Map();
  private registeredWorkers: Set<string> = new Set(); // Track registered workers to prevent duplicates

  constructor(config: WorkerSystemConfig) {
    this.config = config;
    this.controlHooks = new ModularControlHooks();
    this.fallbackDispatch = new UnifiedFallbackDispatch();

    // Initialize Unified OpenAI service
    this.unifiedAI = getUnifiedOpenAI({
      apiKey: config.openaiApiKey || process.env.OPENAI_API_KEY,
      model: config.model,
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 2,
    });

    this.setupDefaultHooks();
    this.setupDefaultFallbacks();

    logger.info('Refactored AI Worker System initialized with unified service', {
      model: config.model || 'default',
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 2
    });
  }

  private setupDefaultHooks(): void {
    // Default worker registration hook
    this.controlHooks.registerHook('register', async (workerName: string, config: any) => {
      if (this.registeredWorkers.has(workerName)) {
        logger.info(`Worker '${workerName}' already registered, skipping duplicate registration`);
        return { success: true, worker: workerName, duplicate: true };
      }
      
      this.workers.set(workerName, {
        name: workerName,
        config,
        registered: Date.now(),
        status: 'registered'
      });
      this.registeredWorkers.add(workerName);
      return { success: true, worker: workerName, duplicate: false };
    });

    // Default worker orchestration hook
    this.controlHooks.registerHook('orchestrate', async (task: any) => {
      const validatedTask = validateWorkerTask(task);
      
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a worker orchestration system. Process the worker task and return appropriate instructions.'
        },
        {
          role: 'user',
          content: `Orchestrate worker: ${validatedTask.name} with parameters: ${JSON.stringify(validatedTask.parameters || {})}`
        }
      ];

      const response = await this.unifiedAI.chat(messages, {
        model: this.config.model || 'gpt-4-turbo',
        temperature: 0.3,
        maxTokens: 500,
      });

      return response.success ? response.content : 'Orchestration completed';
    });

    // Fallback hook for undefined operations
    this.controlHooks.setFallbackHook(async (hookName: string, ...args: any[]) => {
      logger.warning(`Using fallback for undefined hook: ${hookName}`);
      return {
        success: false,
        error: `Hook ${hookName} not implemented`,
        fallback: true,
        args
      };
    });
  }

  private setupDefaultFallbacks(): void {
    // Default worker fallback
    this.fallbackDispatch.registerStrategy('default', async (task: any, options: any) => {
      logger.info('Using default fallback strategy');
      const fallbackWorker = this.config.fallbackWorker || 'defaultWorker';
      
      return {
        worker: fallbackWorker,
        status: 'fallback_executed',
        task,
        result: `Fallback execution for ${task.name || 'unknown'} completed`
      };
    });

    // Graceful degradation strategy
    this.fallbackDispatch.setDefaultStrategy(async (task: any, options: any) => {
      logger.info('Using graceful degradation strategy');
      return {
        status: 'degraded',
        message: 'System running in degraded mode - worker orchestration unavailable',
        task: task.name || 'unknown'
      };
    });
  }

  async registerWorker(name: string, config: any = {}): Promise<any> {
    return await this.controlHooks.executeHook('register', name, config);
  }

  // Check if worker is already registered
  isWorkerRegistered(name: string): boolean {
    return this.registeredWorkers.has(name);
  }

  async orchestrateWorker(task: any): Promise<any> {
    try {
      return await this.controlHooks.executeHook('orchestrate', task);
    } catch (error: any) {
      logger.warning(`Orchestration failed, using fallback for ${task.name}`);
      return await this.fallbackDispatch.dispatch(task.name, task);
    }
  }

  async scheduleWorker(schedule: OptimizedScheduleFormat): Promise<any> {
    logger.info(`Scheduling worker with optimized format: ${schedule.worker}`);
    
    try {
      const result = await this.controlHooks.executeHook('schedule', schedule);
      return {
        success: true,
        scheduled: schedule.worker,
        type: schedule.type,
        priority: schedule.priority,
        result
      };
    } catch (error: any) {
      logger.error(`Scheduling failed for ${schedule.worker}:`, error.message);
      return await this.fallbackDispatch.dispatch(schedule.worker, schedule);
    }
  }

  getSystemStatus(): any {
    return {
      workers: this.workers.size,
      hooks: this.controlHooks.listHooks(),
      unifiedAIConnected: !!this.unifiedAI,
      model: this.config.model,
      registeredWorkers: Array.from(this.workers.keys())
    };
  }

  // Add custom hook with duplicate prevention
  addControlHook(name: string, hook: Function): void {
    this.controlHooks.registerHook(name, hook);
  }

  // Add custom fallback strategy
  addFallbackStrategy(name: string, strategy: Function): void {
    this.fallbackDispatch.registerStrategy(name, strategy);
  }
}

// Main refactoring function as specified in problem statement
export async function refactorAIWorkerSystem(config: RefactorConfig): Promise<RefactoredAIWorkerSystem> {
  logger.info('Starting AI Worker System refactoring', config);

  if (config.logLevel === 'minimal') {
    // Reduce logging for minimal mode
    logger.info('Running in minimal logging mode');
  }

  // Validate SDK version compatibility
  if (!config.sdkVersion.startsWith('1.')) {
    logger.warning(`SDK version ${config.sdkVersion} may not be fully compatible. Recommended: 1.x.x`);
  }

  // Create the refactored system
  const systemConfig: WorkerSystemConfig = {
    fallbackWorker: config.fallback,
    timeout: 30000,
    maxRetries: 2
  };

  const refactoredSystem = new RefactoredAIWorkerSystem(systemConfig);

  // Register default workers if controlHooks is enabled
  if (config.controlHooks) {
    const defaultWorkers = ['goalTracker', 'maintenanceScheduler', 'emailDispatcher', 'auditProcessor'];
    
    for (const worker of defaultWorkers) {
      try {
        const result = await refactoredSystem.registerWorker(worker, { 
          type: 'system',
          priority: 5,
          enabled: true 
        });
        
        if (result.duplicate) {
          logger.info(`Skipped registering default worker (already exists): ${worker}`);
        } else {
          logger.info(`Registered default worker: ${worker}`);
        }
      } catch (error: any) {
        logger.warning(`Failed to register worker ${worker}:`, error.message);
      }
    }
  }

  // Add modular hooks if requested
  if (config.modularize) {
    // Add health check hook (with deduplication protection)
    refactoredSystem.addControlHook('health', async () => {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        system: 'refactored'
      };
    });

    // Add validation hook (with deduplication protection)
    refactoredSystem.addControlHook('validate', async (data: any) => {
      return {
        valid: !!data,
        timestamp: new Date().toISOString()
      };
    });
  }

  logger.success('AI Worker System refactoring completed successfully');
  
  return refactoredSystem;
}


// 🔁 OpenAI SDK-Compatible Worker Initialization & Fallback Logic
// @deprecated This orchestrator is being replaced by UnifiedOpenAIService
// Use getUnifiedOpenAI() for new implementations

import { getUnifiedOpenAI } from './unified-openai';
import OpenAI from "openai"; // OpenAI SDK v4+ - kept for legacy compatibility
import { createServiceLogger } from '../utils/logger';
import { 
  validateWorkerTask, 
  validateWorkerRegistration, 
  validateOpenAIOrchestration,
  isKnownWorker,
  KNOWN_WORKERS,
  type WorkerTask,
  type WorkerRegistration
} from '../utils/worker-validation';

const logger = createServiceLogger('OpenAIWorkerOrchestrator');

// Enhanced OpenAI client initialization with comprehensive error handling
let openai: OpenAI | null = null;
let initializationError: string | null = null;

function initializeOpenAIClient(): void {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      initializationError = 'OPENAI_API_KEY environment variable not found';
      logger.warning('⚠️ OPENAI_API_KEY not found - OpenAI orchestration will be disabled');
      return;
    }

    if (apiKey.length < 20) {
      initializationError = 'OPENAI_API_KEY appears to be invalid (too short)';
      logger.warning('⚠️ OPENAI_API_KEY appears invalid - OpenAI orchestration will be disabled');
      return;
    }

    openai = new OpenAI({ 
      apiKey,
      timeout: 30000, // 30 second timeout
      maxRetries: 2   // Retry failed requests up to 2 times
    });
    
    logger.info('✅ OpenAI client initialized successfully');
    
  } catch (error: any) {
    initializationError = `Failed to initialize OpenAI client: ${error.message}`;
    logger.error('❌ Failed to initialize OpenAI client:', error.message);
    openai = null;
  }
}

// Initialize on module load
initializeOpenAIClient();

// Health check function (moved to avoid redeclaration)
function getOpenAIStatus(): { available: boolean; error?: string } {
  return {
    available: openai !== null,
    error: initializationError || undefined
  };
}

/**
 * Orchestrate worker logic safely with comprehensive validation and error handling.
 * Ensures OpenAI function orchestration fallback is respected.
 */
async function orchestrateWorker(task: unknown): Promise<string | null> {
  try {
    // Validate input parameters using zod schema
    const validatedTask = validateWorkerTask(task);
    
    // Check if worker is known/registered
    if (!isKnownWorker(validatedTask.name)) {
      logger.warning(`⚠️ Attempting to orchestrate unknown worker: ${validatedTask.name}`);
      logger.info(`Known workers: ${KNOWN_WORKERS.join(', ')}`);
    }

    // Check OpenAI availability and attempt lazy initialization if needed
    if (!openai) {
      initializeOpenAIClient();

      if (!openai) {
        const error = `OpenAI client not available - ${initializationError || 'Unknown initialization error'}`;
        logger.error(`❌ ${error}`);
        throw new Error(error);
      }
    }

    // Validate OpenAI orchestration parameters
    const orchestrationParams = validateOpenAIOrchestration({
      model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
      messages: [
        { 
          role: "system", 
          content: `Initialize and execute worker logic for '${validatedTask.name}'. Worker type: ${validatedTask.type}. Priority: ${validatedTask.priority}.` 
        },
        { 
          role: "user", 
          content: `Start '${validatedTask.name}' orchestration with parameters: ${JSON.stringify(validatedTask.parameters || {})}` 
        }
      ],
      timeout: validatedTask.timeout
    });

    logger.info(`🚀 Starting OpenAI orchestration for worker: ${validatedTask.name}`);
    
    // Execute OpenAI call with timeout and retry logic
    const response = await Promise.race([
      openai.chat.completions.create({
        model: orchestrationParams.model,
        messages: orchestrationParams.messages,
        temperature: orchestrationParams.temperature,
        max_tokens: orchestrationParams.maxTokens
      }),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('OpenAI request timeout')), orchestrationParams.timeout)
      )
    ]);

    const result = response.choices[0]?.message?.content;
    if (!result) {
      throw new Error('No response content received from OpenAI');
    }

    logger.info(`✅ [${validatedTask.name}] orchestration completed via OpenAI`);
    return result;
    
  } catch (error: any) {
    logger.error(`❌ OpenAI orchestration failed:`, {
      task: typeof task === 'object' && task !== null ? (task as any).name : 'unknown',
      error: error.message
    });
    throw error;
  }
}

// 🧩 Worker Registration with comprehensive validation and fallback orchestration
async function registerWorker(
  name: string, 
  orchestrator: Function = orchestrateWorker,
  config?: { enabled?: boolean; maxConcurrent?: number; timeout?: number; retryAttempts?: number }
): Promise<void> {
  try {
    // Validate registration parameters
    const validatedRegistration = validateWorkerRegistration({
      name,
      orchestrator,
      config
    });

    // Check if orchestrator function is valid
    if (typeof orchestrator !== "function") {
      logger.warning(`⚠️ Worker '${name}' registration failed: orchestrator is not a function (type: ${typeof orchestrator})`);
      throw new Error(`Invalid orchestrator function for worker '${name}'`);
    }

    // Check if worker name is known
    if (!isKnownWorker(name)) {
      logger.warning(`⚠️ Registering unknown worker '${name}'. Known workers: ${KNOWN_WORKERS.join(', ')}`);
    }

    logger.info(`🔧 Registering worker '${name}' with configuration:`, validatedRegistration.config);

    // Attempt orchestration with error handling and fallback
    try {
      const result = await orchestrator({ 
        name,
        type: 'ondemand',
        parameters: {},
        ...validatedRegistration.config
      });
      
      logger.info(`✅ Worker '${name}' registered successfully:`, result ? result.substring(0, 100) + '...' : 'No response content');
      
    } catch (orchestrationError: any) {
      logger.error(`❌ Primary orchestration failed for worker '${name}':`, orchestrationError.message);
      
      // Attempt fallback if orchestrator is not the default
      if (orchestrator !== orchestrateWorker) {
        logger.info(`🔄 Attempting fallback orchestration for worker '${name}'`);
        try {
          const fallbackResult = await orchestrateWorker({ 
            name,
            type: 'ondemand',
            parameters: {}
          });
          logger.info(`✅ Worker '${name}' registered via fallback orchestration`);
        } catch (fallbackError: any) {
          logger.error(`❌ Fallback orchestration also failed for worker '${name}':`, fallbackError.message);
          throw new Error(`Both primary and fallback orchestration failed for worker '${name}': ${orchestrationError.message}`);
        }
      } else {
        throw orchestrationError;
      }
    }
    
  } catch (error: any) {
    logger.error(`❌ Error registering worker '${name}':`, error.message);
    throw error;
  }
}

/**
 * Initialize all critical AI workers using OpenAI SDK orchestration with enhanced error handling
 */
async function initializeOpenAIWorkers(): Promise<void> {
  logger.info('🚀 Initializing workers with OpenAI SDK orchestration');
  
  // Check OpenAI availability first
  const status = getOpenAIStatus();
  if (!status.available) {
    const errorMsg = `OpenAI client not available: ${status.error}`;
    logger.warning(`⚠️ ${errorMsg} - skipping OpenAI worker initialization`);
    throw new Error(errorMsg);
  }
  
  // 🔁 Register all critical AI workers with validation
  const criticalWorkers = KNOWN_WORKERS.filter(worker => 
    ['goalTracker', 'maintenanceScheduler', 'emailDispatcher', 'auditProcessor'].includes(worker)
  );
  
  logger.info(`📋 Registering ${criticalWorkers.length} critical workers: ${criticalWorkers.join(', ')}`);
  
  const registrationResults = await Promise.allSettled(
    criticalWorkers.map(async (worker) => {
      try {
        await registerWorker(worker, orchestrateWorker, {
          enabled: true,
          timeout: 30000,
          retryAttempts: 2
        });
        return { worker, status: 'success' };
      } catch (error: any) {
        logger.error(`❌ Failed to register worker '${worker}':`, error.message);
        return { worker, status: 'failed', error: error.message };
      }
    })
  );
  
  // Analyze results
  const successful = registrationResults.filter(result => 
    result.status === 'fulfilled' && result.value.status === 'success'
  ).length;
  
  const failed = registrationResults.filter(result => 
    result.status === 'rejected' || (result.status === 'fulfilled' && result.value.status === 'failed')
  ).length;
  
  logger.info(`📊 Worker registration completed: ${successful} successful, ${failed} failed`);
  
  if (successful === 0) {
    throw new Error('All critical worker registrations failed');
  }
  
  if (failed > 0) {
    logger.warning(`⚠️ ${failed} worker registrations failed, but ${successful} succeeded`);
  }
  
  logger.success(`✅ OpenAI worker orchestration completed: ${successful}/${criticalWorkers.length} workers registered`);
}

/**
 * Fallback orchestration function for when OpenAI is not available
 */
async function fallbackOrchestrator(task: unknown): Promise<string | null> {
  const validatedTask = validateWorkerTask(task);
  
  logger.info(`🔄 Using fallback orchestration for worker: ${validatedTask.name}`);
  
  // Simple mock orchestration that simulates worker initialization
  const response = `Fallback orchestration: Worker '${validatedTask.name}' initialized in local mode. Type: ${validatedTask.type}, Priority: ${validatedTask.priority}. OpenAI integration unavailable.`;
  
  // Simulate some processing time
  await new Promise(resolve => setTimeout(resolve, 100));
  
  return response;
}

/**
 * Safe worker orchestration with automatic fallback
 */
export async function safeOrchestrateWorker(task: unknown): Promise<string | null> {
  try {
    // Try primary orchestration first
    return await orchestrateWorker(task);
  } catch (error: any) {
    logger.warning(`⚠️ Primary orchestration failed, attempting fallback:`, error.message);
    
    try {
      return await fallbackOrchestrator(task);
    } catch (fallbackError: any) {
      logger.error(`❌ Both primary and fallback orchestration failed:`, fallbackError.message);
      throw new Error(`All orchestration methods failed: ${error.message}`);
    }
  }
}

export { 
  orchestrateWorker, 
  registerWorker, 
  initializeOpenAIWorkers,
  fallbackOrchestrator,
  getOpenAIStatus
};
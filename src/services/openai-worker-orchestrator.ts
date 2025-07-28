// 🔁 OpenAI SDK-Compatible Worker Initialization & Fallback Logic

import OpenAI from "openai"; // OpenAI SDK v4+
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('OpenAIWorkerOrchestrator');

// Initialize OpenAI client with fallback handling
let openai: OpenAI | null = null;
try {
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else {
    logger.warning('⚠️ OPENAI_API_KEY not found - OpenAI orchestration will be disabled');
  }
} catch (error: any) {
  logger.error('❌ Failed to initialize OpenAI client:', error.message);
}

/**
 * Orchestrate worker logic safely.
 * Ensures OpenAI function orchestration fallback is respected.
 */
async function orchestrateWorker(task: { name: string }): Promise<string | null> {
  if (!task?.name) throw new Error("Worker task missing 'name'");

  if (!openai) {
    throw new Error("OpenAI client not available - check OPENAI_API_KEY environment variable");
  }

  try {
    // You can customize this OpenAI call
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // or fine-tuned version
      messages: [
        { role: "system", content: `Initialize and execute worker logic for '${task.name}'` },
        { role: "user", content: `Start '${task.name}' orchestration.` }
      ]
    });

    logger.info(`✅ [${task.name}] orchestration started via OpenAI`);
    return response.choices[0].message.content;
  } catch (error: any) {
    logger.error(`❌ OpenAI orchestration failed for '${task.name}':`, error.message);
    throw error;
  }
}

// 🧩 Worker Init with fallback orchestration
async function registerWorker(name: string, orchestrator = orchestrateWorker): Promise<void> {
  if (typeof orchestrator !== "function") {
    logger.warning(`⚠️ Worker '${name}' registration failed: orchestrator invalid.`);
    return;
  }

  try {
    const result = await orchestrator({ name });
    logger.info(`🔧 Worker '${name}' registered:`, result);
  } catch (err: any) {
    logger.error(`❌ Error initializing worker '${name}':`, err.message);
  }
}

/**
 * Initialize all critical AI workers using OpenAI SDK orchestration
 */
async function initializeOpenAIWorkers(): Promise<void> {
  logger.info('🚀 Initializing workers with OpenAI SDK orchestration');
  
  if (!openai) {
    logger.warning('⚠️ OpenAI client not available - skipping OpenAI worker initialization');
    return;
  }
  
  // 🔁 Register all critical AI workers
  const criticalWorkers = ["goalTracker", "maintenanceScheduler", "emailDispatcher", "auditProcessor"];
  
  const registrationPromises = criticalWorkers.map(worker => registerWorker(worker));
  
  try {
    await Promise.allSettled(registrationPromises);
    logger.success(`✅ OpenAI worker orchestration completed for ${criticalWorkers.length} workers`);
  } catch (error: any) {
    logger.error('❌ Failed to initialize OpenAI workers:', error.message);
  }
}

export { 
  orchestrateWorker, 
  registerWorker, 
  initializeOpenAIWorkers 
};
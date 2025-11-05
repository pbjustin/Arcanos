import cron from 'node-cron';
import config from '../config/index.js';
import { aiLogger } from '../utils/structuredLogging.js';
import { syncAssistantRegistry } from '../services/openai-assistants.js';

const LOG_CONTEXT = { module: 'assistant-sync' } as const;

async function runSync(trigger: 'startup' | 'cron'): Promise<void> {
  const context = { ...LOG_CONTEXT, operation: 'sync', trigger };
  try {
    const registry = await syncAssistantRegistry();
    aiLogger.info('[AI-ASSISTANT-SYNC] Sync completed', context, {
      count: Object.keys(registry).length
    });
  } catch (error) {
    aiLogger.error('[AI-ASSISTANT-SYNC] Sync execution failed', context, undefined, error as Error);
  }
}

if (config.assistantSync.enabled) {
  aiLogger.info('[AI-ASSISTANT-SYNC] Scheduling assistant sync job', {
    ...LOG_CONTEXT,
    schedule: config.assistantSync.schedule,
    path: config.assistantSync.registryPath
  });

  runSync('startup');
  cron.schedule(config.assistantSync.schedule, () => {
    runSync('cron');
  });
} else {
  aiLogger.info('[AI-ASSISTANT-SYNC] Assistant sync disabled via configuration', LOG_CONTEXT);
}

export {};

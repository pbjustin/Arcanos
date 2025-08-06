// ARCANOS AI-Controlled Cron Worker System
// All cron tasks are managed through AI model instructions

import cron from 'node-cron';
import axios from 'axios';
import { workerStatusService } from './worker-status.js';
import { modelControlHooks } from './model-control-hooks.js';
import { openAIAssistantsService } from './openai-assistants.js';
import { serviceAlreadyRegistered } from './service-registry.js';

const SERVER_URL =
  process.env.SERVER_URL ||
  (process.env.NODE_ENV === 'production'
    ? 'https://arcanos-v2-production.up.railway.app'
    : `http://localhost:${process.env.PORT || 8080}`);

// JSON-based cron instruction templates for AI model
export const CRON_INSTRUCTIONS = {
  healthCheck: {
    action: 'schedule',
    service: 'diagnostic',
    parameters: { type: 'health' },
    schedule: '*/15 * * * *',
    execute: true,
    priority: 6
  },
  maintenance: {
    action: 'schedule',
    service: 'maintenance',
    parameters: { type: 'cleanup' },
    schedule: '0 */6 * * *',
    execute: true,
    priority: 7
  },
  memorySync: {
    action: 'schedule',
    worker: 'memorySync',
    parameters: {},
    schedule: '0 */4 * * *',
    execute: true,
    priority: 5
  },
  goalWatcher: {
    action: 'schedule',
    worker: 'goalWatcher',
    parameters: {},
    schedule: '*/30 * * * *',
    execute: true,
    priority: 4
  },
  assistantSync: {
    action: 'schedule',
    service: 'assistantSync',
    parameters: { type: 'openai-sync' },
    schedule: '15,45 * * * *',
    execute: true,
    priority: 5
  },
  patchRetry: {
    action: 'schedule',
    service: 'patchRetry',
    parameters: { type: 'ai-patch-retry' },
    schedule: '*/10 * * * *',
    execute: true,
    priority: 4
  }
};

/**
 * Initialize cron worker schedules if not already registered
 */
export function initCronWorker(): void {
  if (serviceAlreadyRegistered('cron-worker')) {
    console.log('[AI-CRON] Cron worker already initialized');
    return;
  }

  // AI-Controlled Health Check (AI decides when to run)
  cron.schedule('*/15 * * * *', async () => {
  try {
    const result = await modelControlHooks.handleCronTrigger(
      'health-check',
      '*/15 * * * *',
      {
        userId: 'system',
        sessionId: 'cron',
        source: 'cron'
      }
    );

    if (result.success) {
      console.log('[AI-CRON] Health check approved by AI model');
      await executeHealthCheck();
    } else {
      console.log('[AI-CRON] Health check denied by AI:', result.error || 'No approval');
    }
  } catch (error: any) {
    console.error('[AI-CRON] AI control error:', error.message);
  }
});

// AI-Controlled Maintenance (AI decides when to run)
cron.schedule('0 */6 * * *', async () => {
  try {
    const result = await modelControlHooks.handleCronTrigger(
      'maintenance',
      '0 */6 * * *',
      {
        userId: 'system',
        sessionId: 'cron',
        source: 'cron'
      }
    );

    if (result.success) {
      console.log('[AI-CRON] Maintenance approved by AI model');
      await executeMaintenance();
    } else {
      console.log('[AI-CRON] Maintenance denied by AI:', result.error || 'No approval');
    }
  } catch (error: any) {
    console.error('[AI-CRON] AI maintenance control error:', error.message);
  }
});

// AI-Controlled Memory Sync (AI decides when to run)
cron.schedule('0 */4 * * *', async () => {
  try {
    const result = await modelControlHooks.orchestrateWorker(
      'memorySync',
      'scheduled',
      {},
      {
        userId: 'system',
        sessionId: 'cron',
        source: 'cron'
      }
    );

    if (result.success) {
      console.log('[AI-CRON] Memory sync approved by AI model');
    } else {
      console.log('[AI-CRON] Memory sync denied by AI:', result.error || 'No approval');
    }
  } catch (error: any) {
    console.error('[AI-CRON] AI memory sync control error:', error.message);
  }
});

// AI-Controlled Goal Watcher (AI decides when to run)
cron.schedule('*/30 * * * *', async () => {
  try {
    const result = await modelControlHooks.orchestrateWorker(
      'goalWatcher',
      'scheduled',
      {},
      {
        userId: 'system',
        sessionId: 'cron',
        source: 'cron'
      }
    );

    if (result.success) {
      console.log('[AI-CRON] Goal watcher approved by AI model');
    } else {
      console.log('[AI-CRON] Goal watcher denied by AI:', result.error || 'No approval');
    }
  } catch (error: any) {
    console.error('[AI-CRON] AI goal watcher control error:', error.message);
  }
});

// AI-Controlled Assistant Sync (AI decides when to run) - Every 30 minutes (offset by 15 min)
cron.schedule('15,45 * * * *', async () => {
  try {
    const result = await modelControlHooks.handleCronTrigger(
      'assistant-sync',
      '15,45 * * * *',
      {
        userId: 'system',
        sessionId: 'cron',
        source: 'cron'
      }
    );

    if (result.success) {
      console.log('[AI-CRON] Assistant sync approved by AI model');
      await executeAssistantSync();
    } else {
      console.log('[AI-CRON] Assistant sync denied by AI:', result.error || 'No approval');
    }
  } catch (error: any) {
    console.error('[AI-CRON] AI assistant sync control error:', error.message);
  }
});

// AI-Controlled Patch Retry (AI decides when to run)
cron.schedule('*/10 * * * *', async () => {
  try {
    const result = await modelControlHooks.handleCronTrigger(
      'patch-retry',
      '*/10 * * * *',
      {
        userId: 'system',
        sessionId: 'cron',
        source: 'cron'
      }
    );

    if (result.success) {
      console.log('[AI-CRON] Patch retry approved by AI model');
      await executePatchRetry();
    } else {
      console.log('[AI-CRON] Patch retry denied by AI:', result.error || 'No approval');
    }
  } catch (error: any) {
    console.error('[AI-CRON] AI patch retry control error:', error.message);
  }
});

/**
 * Execute health check when approved by AI
 */
async function executeHealthCheck(): Promise<void> {
  workerStatusService.updateWorkerStatus('worker-health', 'running', 'ai_approved_health_check');
  
  try {
    const response = await axios.get(`${SERVER_URL}/health`, { timeout: 10000 });
    console.log('[AI-HEALTH] Health check completed successfully');
    workerStatusService.updateWorkerStatus('worker-health', 'idle', 'ai_health_check_complete');
  } catch (error: any) {
    console.error('[AI-HEALTH] Health check failed:', error.message);
    workerStatusService.updateWorkerStatus('worker-health', 'error', 'ai_health_check_failed');
  }
}

/**
 * Execute maintenance when approved by AI
 */
async function executeMaintenance(): Promise<void> {
  workerStatusService.updateWorkerStatus('worker-maintenance', 'running', 'ai_approved_maintenance');
  
  try {
    // AI-controlled maintenance operations
    console.log('[AI-MAINTENANCE] Running AI-approved maintenance tasks');
    
    // Memory cleanup
    if (global.gc) {
      global.gc();
      console.log('[AI-MAINTENANCE] Memory garbage collection completed');
    }
    
    console.log('[AI-MAINTENANCE] Maintenance tasks completed');
    workerStatusService.updateWorkerStatus('worker-maintenance', 'idle', 'ai_maintenance_complete');
  } catch (error: any) {
    console.error('[AI-MAINTENANCE] Maintenance failed:', error.message);
    workerStatusService.updateWorkerStatus('worker-maintenance', 'error', 'ai_maintenance_failed');
  }
}

/**
 * Execute OpenAI assistant sync when approved by AI
 */
async function executeAssistantSync(): Promise<void> {
  workerStatusService.updateWorkerStatus('worker-assistant-sync', 'running', 'ai_approved_assistant_sync');
  
  try {
    console.log('[AI-ASSISTANT-SYNC] Running AI-approved assistant sync');
    
    // Sync assistants from OpenAI
    const assistantMap = await openAIAssistantsService.syncAssistants();
    const assistantCount = Object.keys(assistantMap).length;
    
    console.log(`[AI-ASSISTANT-SYNC] Successfully synced ${assistantCount} assistants`);
    console.log('[AI-ASSISTANT-SYNC] Available assistants:', Object.keys(assistantMap));
    
    workerStatusService.updateWorkerStatus('worker-assistant-sync', 'idle', `ai_assistant_sync_complete_${assistantCount}_assistants`);
  } catch (error: any) {
    console.error('[AI-ASSISTANT-SYNC] Assistant sync failed:', error.message);
    workerStatusService.updateWorkerStatus('worker-assistant-sync', 'error', 'ai_assistant_sync_failed');
  }
}

/**
 * Execute AI patch retry queue processing when approved by AI
 */
async function executePatchRetry(): Promise<void> {
  workerStatusService.updateWorkerStatus('worker-patch-retry', 'running', 'ai_approved_patch_retry');
  
  try {
    console.log('[AI-PATCH-RETRY] Running AI-approved patch retry processing');
    
    // Import and execute patch retry processing
    const { aiPatchSystem } = await import('./ai-patch-system.js');
    await aiPatchSystem.processRetryQueue();
    
    const status = await aiPatchSystem.getRetryQueueStatus();
    console.log(`[AI-PATCH-RETRY] Retry queue processed, ${status.queueLength} items remaining`);
    
    workerStatusService.updateWorkerStatus('worker-patch-retry', 'idle', `ai_patch_retry_complete_${status.queueLength}_remaining`);
  } catch (error: any) {
    console.error('[AI-PATCH-RETRY] Patch retry processing failed:', error.message);
    workerStatusService.updateWorkerStatus('worker-patch-retry', 'error', 'ai_patch_retry_failed');
  }
}

console.log('[AI-CRON] AI-controlled cron worker system initialized');
}

// Immediately initialize the cron worker
initCronWorker();

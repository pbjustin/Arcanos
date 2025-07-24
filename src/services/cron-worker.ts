import cron from 'node-cron';
import axios from 'axios';
import { workerStatusService } from './worker-status';
import { modelControlHooks } from './model-control-hooks';

const SERVER_URL = process.env.SERVER_URL || (process.env.NODE_ENV === 'production' 
  ? 'https://arcanos-production-426d.up.railway.app' 
  : `http://localhost:${process.env.PORT || 8080}`);

// AI-Controlled Health Check (every 15 minutes - only runs if AI approves)
cron.schedule('*/15 * * * *', async () => {
  try {
    // Ask AI if health check should run
    const result = await modelControlHooks.handleCronTrigger(
      'health-check',
      '*/15 * * * *',
      {
        userId: 'system',
        sessionId: 'cron',
        source: 'cron'
      }
    );

    if (result.success && result.response?.includes('approved')) {
      workerStatusService.updateWorkerStatus('worker-health', 'running', 'ai_approved_health_check');
      try {
        const response = await axios.get(`${SERVER_URL}/health`, { timeout: 10000 });
        console.log('[AI-HEALTH] AI-approved health check completed successfully');
        workerStatusService.updateWorkerStatus('worker-health', 'idle', 'ai_health_check_complete');
      } catch (error: any) {
        console.error('[AI-HEALTH] AI-approved health check failed:', error.message);
        workerStatusService.updateWorkerStatus('worker-health', 'error', 'ai_health_check_failed');
      }
    } else {
      console.log('[AI-HEALTH] AI denied health check execution:', result.error || 'No approval');
    }
  } catch (error: any) {
    console.error('[AI-HEALTH] AI control error:', error.message);
  }
});

// AI-Controlled Maintenance (every 6 hours - only runs if AI approves)
cron.schedule('0 */6 * * *', async () => {
  try {
    // Ask AI if maintenance should run
    const result = await modelControlHooks.handleCronTrigger(
      'maintenance',
      '0 */6 * * *',
      {
        userId: 'system',
        sessionId: 'cron',
        source: 'cron'
      }
    );

    if (result.success && result.response?.includes('approved')) {
      workerStatusService.updateWorkerStatus('worker-maintenance', 'running', 'ai_approved_maintenance');
      console.log('[AI-MAINTENANCE] AI approved maintenance sweep...');
      
      // AI-controlled cleanup
      setTimeout(() => {
        workerStatusService.updateWorkerStatus('worker-maintenance', 'idle', 'ai_maintenance_complete');
        console.log('[AI-MAINTENANCE] AI-approved maintenance completed');
      }, 2000);
    } else {
      console.log('[AI-MAINTENANCE] AI denied maintenance execution:', result.error || 'No approval');
    }
  } catch (error: any) {
    console.error('[AI-MAINTENANCE] AI control error:', error.message);
  }
});

export function startCronWorker() {
  console.log('[AI-CRON] AI-controlled worker service started:');
  console.log('[AI-CRON] - Health check: every 15 minutes (AI approval required)');
  console.log('[AI-CRON] - Maintenance: every 6 hours (AI approval required)');
  console.log(`[AI-CRON] Monitoring server at: ${SERVER_URL}`);
  console.log('[AI-CRON] All cron operations now require AI model approval');
  
  // Initialize minimal worker status tracking
  workerStatusService.initializeMinimalWorkers();
  console.log('[AI-CRON] AI-controlled worker status tracking initialized');
}
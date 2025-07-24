import cron from 'node-cron';
import axios from 'axios';
import { workerStatusService } from './worker-status';

const SERVER_URL = process.env.SERVER_URL || (process.env.NODE_ENV === 'production' 
  ? 'https://arcanos-production-426d.up.railway.app' 
  : `http://localhost:${process.env.PORT || 8080}`);

// 🔁 Basic health check monitor (every 15 minutes - reduced frequency)
cron.schedule('*/15 * * * *', async () => {
  workerStatusService.updateWorkerStatus('worker-health', 'running', 'health_monitoring');
  try {
    const response = await axios.get(`${SERVER_URL}/health`, { timeout: 10000 });
    console.log('[HEALTH] Server is healthy');
    workerStatusService.updateWorkerStatus('worker-health', 'idle', 'health_monitoring_complete');
  } catch (error: any) {
    console.error('[HEALTH] Server check failed:', error.message);
    workerStatusService.updateWorkerStatus('worker-health', 'error', 'health_check_failed');
  }
});

// 🧹 Basic maintenance (every 6 hours - much reduced frequency)
cron.schedule('0 */6 * * *', () => {
  workerStatusService.updateWorkerStatus('worker-maintenance', 'running', 'maintenance_sweep');
  console.log('[MAINTENANCE] Performing basic cleanup...');
  // Basic cleanup only
  setTimeout(() => {
    workerStatusService.updateWorkerStatus('worker-maintenance', 'idle', 'awaiting_job');
  }, 2000);
});

export function startCronWorker() {
  console.log('[CRON] Minimal worker service started with reduced schedules:');
  console.log('[CRON] - Health check: every 15 minutes');
  console.log('[CRON] - Basic maintenance: every 6 hours');
  console.log(`[CRON] Monitoring server at: ${SERVER_URL}`);
  
  // Initialize minimal worker status tracking
  workerStatusService.initializeMinimalWorkers();
  console.log('[CRON] Minimal worker status tracking initialized');
}
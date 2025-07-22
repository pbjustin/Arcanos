import cron from 'node-cron';
import axios from 'axios';
import { workerStatusService } from './worker-status';

const SERVER_URL = process.env.SERVER_URL || (process.env.NODE_ENV === 'production' 
  ? 'https://arcanos-production-426d.up.railway.app' 
  : `http://localhost:${process.env.PORT || 8080}`);

// 🕓 Sleep cycle worker (7 AM to 2 PM)
cron.schedule('* * * * *', () => {
  const hour = new Date().getHours();
  if (hour >= 7 && hour < 14) {
    workerStatusService.updateWorkerStatus('worker-5', 'running', 'sleep_mode_active');
    console.log('[SLEEP] Entering low-power state.');
    // Optional: toggle a flag or notify the main server
  } else {
    workerStatusService.updateWorkerStatus('worker-5', 'idle', 'awaiting_sleep_window');
  }
});

// 🔁 Health check monitor (every 5 minutes)
cron.schedule('*/5 * * * *', async () => {
  workerStatusService.updateWorkerStatus('worker-3', 'running', 'health_monitoring');
  try {
    const response = await axios.get(`${SERVER_URL}/health`);
    console.log('[HEALTH] Server is healthy:', response.data);
    workerStatusService.updateWorkerStatus('worker-3', 'running', 'health_monitoring');
  } catch (error: any) {
    console.error('[HEALTH] Server check failed:', error.message);
    workerStatusService.updateWorkerStatus('worker-3', 'error', 'health_check_failed');
  }
});

// 🧹 Maintenance sweep (every hour)
cron.schedule('0 * * * *', () => {
  workerStatusService.updateWorkerStatus('worker-4', 'running', 'maintenance_sweep');
  console.log('[MAINTENANCE] Performing cleanup tasks...');
  // Add any cleanup logic here (cache clears, file purges, etc.)
  setTimeout(() => {
    workerStatusService.updateWorkerStatus('worker-4', 'idle', 'awaiting_job');
  }, 5000); // Simulate 5 second maintenance task
});

// 🧠 Model responsiveness probe (every 15 minutes)
cron.schedule('*/15 * * * *', async () => {
  workerStatusService.updateWorkerStatus('worker-1', 'running', 'memory_diagnostics');
  try {
    const test = await axios.post(`${SERVER_URL}/api/ask`, {
      message: 'health_check',
      domain: 'system',
      useRAG: false,
      useHRC: false,
    });
    console.log('[PROBE] Model responded:', (test.data as any)?.response || 'No response');
    workerStatusService.updateWorkerStatus('worker-1', 'running', 'memory_diagnostics');
  } catch (err: any) {
    console.error('[PROBE] Model check failed:', err.message);
    workerStatusService.updateWorkerStatus('worker-1', 'error', 'model_check_failed');
  }
});

// 💾 Persist memory state to Postgres (every hour)
cron.schedule('0 * * * *', async () => {
  workerStatusService.updateWorkerStatus('worker-2', 'running', 'memory_persistence_sync');
  try {
    await axios.post(`${SERVER_URL}/memory/sync`);
    console.log('[MEMORY] Synced memory state to Postgres');
  } catch (err: any) {
    console.error('[MEMORY] Sync failed:', err.message);
  }
  workerStatusService.updateWorkerStatus('worker-2', 'idle', 'awaiting_job');
});

export function startCronWorker() {
  console.log('[CRON] Worker service started with the following schedules:');
  console.log('[CRON] - Sleep cycle check: every minute (active 7 AM - 2 PM)');
  console.log('[CRON] - Health check: every 5 minutes');
  console.log('[CRON] - Maintenance: every hour');
  console.log('[CRON] - Model probe: every 15 minutes');
  console.log('[CRON] - Memory sync: every hour');
  console.log(`[CRON] Monitoring server at: ${SERVER_URL}`);
  
  // Initialize worker status tracking
  workerStatusService.initializeSystemWorkers();
  console.log('[CRON] Worker status tracking initialized');
}
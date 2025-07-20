import cron from 'node-cron';
import axios from 'axios';

const SERVER_URL = process.env.SERVER_URL || (process.env.NODE_ENV === 'production' 
  ? 'https://arcanos-production-426d.up.railway.app' 
  : `http://localhost:${process.env.PORT || 8080}`);

// 🕓 Sleep cycle worker (7 AM to 2 PM)
cron.schedule('* * * * *', () => {
  const hour = new Date().getHours();
  if (hour >= 7 && hour < 14) {
    console.log('[SLEEP] Entering low-power state.');
    // Optional: toggle a flag or notify the main server
  }
});

// 🔁 Health check monitor (every 5 minutes)
cron.schedule('*/5 * * * *', async () => {
  try {
    const response = await axios.get(`${SERVER_URL}/health`);
    console.log('[HEALTH] Server is healthy:', response.data);
  } catch (error: any) {
    console.error('[HEALTH] Server check failed:', error.message);
  }
});

// 🧹 Maintenance sweep (every hour)
cron.schedule('0 * * * *', () => {
  console.log('[MAINTENANCE] Performing cleanup tasks...');
  // Add any cleanup logic here (cache clears, file purges, etc.)
});

// 🧠 Model responsiveness probe (every 15 minutes)
cron.schedule('*/15 * * * *', async () => {
  try {
    const test = await axios.post(`${SERVER_URL}/api/ask`, {
      message: 'health_check',
      domain: 'system',
      useRAG: false,
      useHRC: false,
    });
    console.log('[PROBE] Model responded:', test.data.response);
  } catch (err: any) {
    console.error('[PROBE] Model check failed:', err.message);
  }
});

// 💾 Optional memory persistence (every 30 minutes)
cron.schedule('*/30 * * * *', () => {
  console.log('[MEMORY] Syncing persistent state to disk (placeholder)');
});

export function startCronWorker() {
  console.log('[CRON] Worker service started with the following schedules:');
  console.log('[CRON] - Sleep cycle check: every minute (active 7 AM - 2 PM)');
  console.log('[CRON] - Health check: every 5 minutes');
  console.log('[CRON] - Maintenance: every hour');
  console.log('[CRON] - Model probe: every 15 minutes');
  console.log('[CRON] - Memory sync: every 30 minutes');
  console.log(`[CRON] Monitoring server at: ${SERVER_URL}`);
}
import cron from 'node-cron';

/**
 * Sets up recurring AI maintenance tasks.
 * Currently runs a heartbeat log every minute.
 */
function initAICron(): void {
  cron.schedule('* * * * *', () => {
    console.log('[🤖 AI Cron] heartbeat', new Date().toISOString());
  });
}

// Initialize cron tasks on import
initAICron();

export {};

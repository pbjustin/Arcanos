// Worker initialization module - conditionally starts workers based on RUN_WORKERS environment variable

function startWorkers() {
  // Import and start the cron worker service
  const { startCronWorker } = require('./services/cron-worker');
  startCronWorker();
  console.log('[WORKER-INIT] Workers started due to RUN_WORKERS=true');
}

// Conditional worker startup based on environment variable
if (process.env.RUN_WORKERS === 'true') {
  startWorkers(); // Your worker orchestration entry
} else {
  console.log('[WORKER-INIT] Workers disabled (RUN_WORKERS not set to true)');
}

export { startWorkers };
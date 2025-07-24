// Optimized Worker initialization - minimal workers on demand
import { workerStatusService } from './services/worker-status';
import { isTrue } from './utils/env';

function startWorkers() {
  // Import and start the optimized cron worker service
  const { startCronWorker } = require('./services/cron-worker');
  startCronWorker();
  console.log('[WORKER-INIT] Minimal workers started due to RUN_WORKERS=true');
}

// Always initialize minimal system workers for status tracking
workerStatusService.initializeMinimalWorkers();
console.log('[WORKER-INIT] Minimal system workers initialized');

// Conditional worker startup based on environment variable
if (isTrue(process.env.RUN_WORKERS)) {
  startWorkers();
} else {
  console.log('[WORKER-INIT] Workers disabled (RUN_WORKERS not set to true)');
}

export { startWorkers };

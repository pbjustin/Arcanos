const path = require('path');

// Worker jobs loaded but not auto-started
const jobs = [
  require(path.resolve(__dirname, './memorySync')),
  require(path.resolve(__dirname, './goalWatcher')),
  require(path.resolve(__dirname, './clearTemp')),
];

console.log('[WORKERS] Background workers loaded for on-demand execution');

// Export function to run workers on demand
function runWorkers() {
  console.log('[WORKERS] Running background tasks on demand');
  jobs.forEach(async job => {
    try {
      await job();
      console.log('[WORKER] Completed:', job.name || 'unknown');
    } catch (err) {
      console.error(`[WORKER ERROR] ${job.name}:`, err.message);
    }
  });
}

// Only export the run function, no auto-interval
module.exports = { runWorkers, jobs };

const jobs = [
  require('./memorySync'),
  require('./goalWatcher'),
  require('./clearTemp'),
];

console.log('[WORKERS] Booting background task loop');

setInterval(() => {
  jobs.forEach(async job => {
    try {
      await job();
    } catch (err) {
      console.error(`[WORKER ERROR] ${job.name}:`, err.message);
    }
  });
}, 1000 * 60 * 5); // every 5 minutes

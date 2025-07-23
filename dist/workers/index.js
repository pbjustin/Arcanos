const path = require('path');
const jobs = [
  require(path.resolve(__dirname, './memorySync')),
  require(path.resolve(__dirname, './goalWatcher')),
  require(path.resolve(__dirname, './clearTemp')),
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

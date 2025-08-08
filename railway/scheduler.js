import cron from 'node-cron';

console.log('Scheduler worker started');

cron.schedule('* * * * *', () => {
  console.log(`[Scheduler] tick ${new Date().toISOString()}`);
});

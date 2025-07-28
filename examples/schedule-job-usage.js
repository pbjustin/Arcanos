// Example usage of the scheduleJob function
// This demonstrates the proper way to schedule jobs with explicit worker validation

const { scheduleJob } = require('../dist/services/execution-engine');

// Example use case from the problem statement:
const scheduledJob = scheduleJob({
  key: 'scheduled_emails_worker',
  value: {
    worker: 'emailDispatcher',
    type: 'ondemand',
    timestamp: new Date().toISOString(),
    status: 'scheduled',
  },
  schedule: '@hourly',
  priority: 5,
});

console.log('Scheduled job:', JSON.stringify(scheduledJob, null, 2));

// Additional examples:
const memorySync = scheduleJob({
  key: 'memory_sync_job',
  value: {
    worker: 'memorySync',
    type: 'maintenance',
    timestamp: new Date().toISOString(),
    status: 'pending',
  },
  schedule: '0 */4 * * *', // Every 4 hours
  priority: 7,
});

console.log('Memory sync job:', JSON.stringify(memorySync, null, 2));
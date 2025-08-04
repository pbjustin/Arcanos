import cron from 'node-cron';
import { runReflectionSweep, finalizeMemoryWrite, queueSleepTasks } from './sleep-handlers.js';
import { ServiceLogger } from '../utils/logger.js';

const logger = new ServiceLogger('SleepPrep');

// 6:45 AM Eastern Time daily
cron.schedule('45 6 * * *', async () => {
  logger.info('🕒 PREP MODE: Initiating pre-sleep memory sweep and task queue');
  await runReflectionSweep('pre-sleep');
  await finalizeMemoryWrite();
  await queueSleepTasks();
  logger.success('✅ PREP COMPLETE: AI state saved and queued for sleep.');
}, { timezone: 'America/New_York' });

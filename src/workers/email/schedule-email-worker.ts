import cron from 'node-cron';
import { createServiceLogger } from '../../utils/logger';
import { workerRegistry } from '../../services/unified-worker-registry';

const logger = createServiceLogger('ScheduleEmailWorker');

export interface ScheduleEmailOptions {
  cron: string;
  request: any;
}

export function scheduleEmailWorker(options: ScheduleEmailOptions) {
  const { cron: cronExpr, request } = options;
  
  const emailHandler = workerRegistry.getWorkerHandler('emailDispatcher');
  if (!emailHandler) {
    logger.warning('emailDispatcher worker not registered, aborting schedule');
    return null;
  }
  
  const task = cron.schedule(cronExpr, async () => {
    await emailHandler(request);
  });
  
  logger.info('Scheduled emailDispatcher', { cron: cronExpr });
  return task;
}

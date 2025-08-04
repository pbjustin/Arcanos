import cron from 'node-cron';
import { createServiceLogger } from '../../utils/logger.js';

let registry: Map<string, any> | undefined;

(async () => {
  try {
    const module = await import('../../../workers/workerRegistry.js' as any);
    registry = module.workerRegistry;
  } catch {
    registry = undefined;
  }
})();

const logger = createServiceLogger('ScheduleEmailWorker');

export interface ScheduleEmailOptions {
  cron: string;
  request: any;
}

export function scheduleEmailWorker(options: ScheduleEmailOptions) {
  const { cron: cronExpr, request } = options;
  if (!registry || !registry.has('emailDispatcher')) {
    logger.warning('emailDispatcher worker not registered, aborting schedule');
    return null;
  }
  const handler = registry.get('emailDispatcher');
  const task = cron.schedule(cronExpr, async () => {
    await handler(request);
  });
  logger.info('Scheduled emailDispatcher', { cron: cronExpr });
  return task;
}

import { Router, Request, Response } from 'express';
import cron from 'node-cron';
import { executionEngine } from '../services/execution-engine';
import { isValidWorker } from '../services/worker-manager';
import { activeWorkers } from '../worker-init';
import { createServiceLogger } from '../utils/logger';

const router = Router();
const logger = createServiceLogger('CronRouter');

function validateSchedule(expr: string): boolean {
  try {
    return cron.validate(expr);
  } catch {
    return false;
  }
}

router.post('/register', async (req: Request, res: Response) => {
  const { worker, schedule, parameters = {} } = req.body || {};

  if (!worker || !schedule) {
    return res.status(400).json({
      error: 'worker and schedule are required',
    });
  }

  const workerName = String(worker);

  if (!isValidWorker(workerName)) {
    return res.status(400).json({
      error: `Invalid worker name: ${workerName}`,
    });
  }

  if (!activeWorkers.has(workerName)) {
    return res.status(400).json({
      error: `Unregistered worker: ${workerName}`,
    });
  }

  if (!validateSchedule(schedule)) {
    return res.status(400).json({
      error: 'Invalid cron expression',
    });
  }

  try {
    const result = executionEngine.handleSchedule({
      action: 'schedule',
      worker: workerName,
      schedule,
      parameters,
    });

    if (result.success) {
      logger.success('Cron job registered', { worker: workerName, schedule });
      res.json({ status: 'registered', worker: workerName, schedule });
    } else {
      logger.error('Cron schedule failed', result.error, { worker: workerName });
      res.status(500).json({ error: result.error });
    }
  } catch (error: any) {
    logger.error('Cron registration error', error, { worker: workerName });
    res.status(500).json({ error: error.message });
  }
});

export default router;

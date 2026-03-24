import express from 'express';

import { logExecution } from '@core/db/index.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import {
  getWorkerRuntimeStatus,
  startWorkers,
  type WorkerBootstrapSummary,
} from '@platform/runtime/workerConfig.js';

import { sendSdkFailure, sendSdkJson } from './shared.js';

const router = express.Router();

/**
 * Initialize workers via SDK call
 */
router.post('/workers/init', confirmGate, async (_, res) => {
  try {
    const results: WorkerBootstrapSummary = await startWorkers();

    await logExecution('sdk-interface', 'info', 'Workers initialized via SDK', { results });

    sendSdkJson(res, {
      success: true,
      message: 'Workers initialized successfully',
      results,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'Worker initialization failed via SDK', error);
  }
});

/**
 * Get worker status via SDK call
 */
router.get('/workers/status', async (_, res) => {
  try {
    const status = getWorkerRuntimeStatus();

    sendSdkJson(res, {
      success: true,
      status,
    });
  } catch (error: unknown) {
    await sendSdkFailure(res, 'Worker status check failed via SDK', error);
  }
});

export default router;

import express from 'express';
import { logExecution } from '../../db/index.js';
import { confirmGate } from '../../middleware/confirmGate.js';
import {
  getWorkerRuntimeStatus,
  startWorkers,
  type WorkerBootstrapSummary
} from '../../config/workerConfig.js';
import { resolveErrorMessage } from '../../lib/errors/index.js';

const router = express.Router();

/**
 * Initialize workers via SDK call
 */
router.post('/workers/init', confirmGate, async (_, res) => {
  try {
    const results: WorkerBootstrapSummary = await startWorkers();

    await logExecution('sdk-interface', 'info', 'Workers initialized via SDK', { results });

    res.json({
      success: true,
      message: 'Workers initialized successfully',
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    //audit Assumption: init failures should return 500
    const errorMessage = resolveErrorMessage(error);
    await logExecution('sdk-interface', 'error', 'Worker initialization failed via SDK', { error: errorMessage });
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get worker status via SDK call
 */
router.get('/workers/status', async (_, res) => {
  try {
    const status = getWorkerRuntimeStatus();

    res.json({
      success: true,
      status,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    //audit Assumption: status failures should return 500
    const errorMessage = resolveErrorMessage(error);
    await logExecution('sdk-interface', 'error', 'Worker status check failed via SDK', { error: errorMessage });
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;

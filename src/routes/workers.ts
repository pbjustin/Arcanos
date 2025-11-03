/**
 * Workers Route - Simplified worker management
 * Provides endpoints for running and monitoring workers
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createWorkerContext } from '../utils/workerContext.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { dispatchArcanosTask, getWorkerRuntimeStatus } from '../config/workerConfig.js';
import type {
  WorkerInfoDTO,
  WorkerRunResponseDTO,
  WorkerStatusResponseDTO
} from '../types/dto.js';

const router = Router();

// Get path to workers directory (from dist, it's one level up from the root)
const workersDir = path.resolve(process.cwd(), 'workers');

/**
 * GET /workers/status - Get available workers
 */
router.get(
  '/workers/status',
  async (_: Request, res: Response<WorkerStatusResponseDTO | { error: string; message: string }>) => {
  try {
    const workers: WorkerInfoDTO[] = [];
    
    if (fs.existsSync(workersDir)) {
      const files = fs.readdirSync(workersDir);
      const workerFiles = files.filter(file => file.endsWith('.js') && !file.includes('shared'));
      
      for (const file of workerFiles) {
        try {
          const workerPath = path.join(workersDir, file);
          const worker = await import(workerPath);

          workers.push({
            id: worker.id || file.replace('.js', ''),
            description: worker.description || 'No description available',
            file: file,
            available: true
          });
        } catch (error) {
          workers.push({
            id: file.replace('.js', ''),
            description: 'Failed to load worker',
            file: file,
            available: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    }
    
    // Include ARCANOS worker configuration status
    const runtimeStatus = getWorkerRuntimeStatus();
    const arcanosWorkers = {
      enabled: runtimeStatus.enabled,
      count: runtimeStatus.configuredCount,
      model: runtimeStatus.model,
      status: runtimeStatus.started ? 'Active' : runtimeStatus.enabled ? 'Pending' : 'Disabled',
      runtime: runtimeStatus
    };

    const payload: WorkerStatusResponseDTO = {
      timestamp: new Date().toISOString(),
      workersDirectory: workersDir,
      totalWorkers: workers.length,
      availableWorkers: workers.filter(w => w.available).length,
      workers,
      arcanosWorkers,
      system: {
        model: process.env.AI_MODEL || 'gpt-4-turbo',
        environment: process.env.NODE_ENV || 'development'
      }
    };

    res.json(payload);
  } catch (error) {
    console.error('Error getting worker status:', error);
    res.status(500).json({
      error: 'Failed to get worker status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
  }
);

/**
 * POST /workers/run/:workerId - Run a specific worker
 */
router.post('/workers/run/:workerId', confirmGate, async (
  req: Request,
  res: Response<WorkerRunResponseDTO>
) => {
  const { workerId } = req.params;
  const input = req.body;

  try {
    if (['arcanos', 'arcanos-core', 'worker.queue'].includes(workerId)) {
      const normalizedInput =
        typeof input === 'string'
          ? input
          : input?.input || input?.prompt || input?.text || JSON.stringify(input);

      const startTime = Date.now();
      const dispatchResults = await dispatchArcanosTask(normalizedInput);
      const primaryResult = dispatchResults[0];
      const duration = Date.now() - startTime;

      if (!primaryResult) {
        return res.status(500).json({
          success: false,
          workerId,
          executionTime: `${duration}ms`,
          timestamp: new Date().toISOString(),
          error: 'No result returned from ARCANOS worker'
        });
      }

      const response: WorkerRunResponseDTO = {
        success: !primaryResult.error,
        workerId: primaryResult.workerId || workerId,
        name: 'ARCANOS Core Worker',
        description: 'ARCANOS core logic with GPT-5 reasoning',
        pattern: 'arcanos-core',
        result: primaryResult,
        executionTime: `${duration}ms`,
        timestamp: new Date().toISOString(),
        error: primaryResult.error
      };

      return res.json(response);
    }

    const workerPath = path.join(workersDir, `${workerId}.js`);

    if (!fs.existsSync(workerPath)) {
      return res.status(404).json({
        success: false,
        workerId,
        executionTime: '0ms',
        timestamp: new Date().toISOString(),
        error: `Worker ${workerId} not found`
      });
    }

    const worker = await import(workerPath);
    const startTime = Date.now();
    let result: unknown;
    let workerInfo: {
      id: string;
      name?: string;
      description?: string;
      pattern?: 'context-based' | 'legacy';
    } = { id: workerId };

    // Check for new worker pattern (context-based)
    if (
      worker.default &&
      typeof worker.default === 'object' &&
      worker.default.name &&
      worker.default.run
    ) {
      const workerModule = worker.default;
      const context = createWorkerContext(workerId);

      result = await workerModule.run(context);
      workerInfo = {
        id: workerId,
        name: workerModule.name,
        description: workerModule.name,
        pattern: 'context-based'
      };

    }
    // Check for old worker pattern (legacy)
    else if (typeof worker.run === 'function') {
      result = await worker.run(input, {});
      workerInfo = {
        id: worker.id || workerId,
        description: worker.description || 'Legacy worker',
        pattern: 'legacy'
      };
    }
    else {
      return res.status(400).json({
        success: false,
        workerId,
        executionTime: '0ms',
        timestamp: new Date().toISOString(),
        error: `Worker ${workerId} does not export a valid run function`
      });
    }

    const duration = Date.now() - startTime;

    const response: WorkerRunResponseDTO = {
      success: true,
      workerId: workerInfo.id,
      name: workerInfo.name,
      description: workerInfo.description,
      pattern: workerInfo.pattern,
      result,
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    res.json(response);

  } catch (error) {
    console.error(`Error running worker ${workerId}:`, error);
    res.status(500).json({
      success: false,
      workerId,
      executionTime: '0ms',
      timestamp: new Date().toISOString(),
      error: 'Worker execution failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
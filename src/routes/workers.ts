/**
 * Workers Route - Simplified worker management
 * Provides endpoints for running and monitoring workers
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// Get path to workers directory (from dist, it's one level up from the root)
const workersDir = path.resolve(process.cwd(), 'workers');

/**
 * GET /workers/status - Get available workers
 */
router.get('/workers/status', async (req: Request, res: Response) => {
  try {
    const workers = [];
    
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
    const arcanosWorkers = {
      runWorkers: process.env.RUN_WORKERS === 'true' || process.env.RUN_WORKERS === '1',
      count: parseInt(process.env.WORKER_COUNT || '4', 10),
      model: process.env.WORKER_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH'
    };
    
    res.json({
      timestamp: new Date().toISOString(),
      workersDirectory: workersDir,
      totalWorkers: workers.length,
      availableWorkers: workers.filter(w => w.available).length,
      workers,
      arcanosWorkers: {
        enabled: arcanosWorkers.runWorkers,
        count: arcanosWorkers.count,
        model: arcanosWorkers.model,
        status: arcanosWorkers.runWorkers ? 'Active' : 'Disabled'
      },
      system: {
        model: process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2',
        environment: process.env.NODE_ENV || 'development'
      }
    });
  } catch (error) {
    console.error('Error getting worker status:', error);
    res.status(500).json({
      error: 'Failed to get worker status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /workers/run/:workerId - Run a specific worker
 */
router.post('/workers/run/:workerId', async (req: Request, res: Response) => {
  const { workerId } = req.params;
  const input = req.body;
  
  try {
    const workerPath = path.join(workersDir, `${workerId}.js`);
    
    if (!fs.existsSync(workerPath)) {
      return res.status(404).json({
        success: false,
        error: `Worker ${workerId} not found`
      });
    }
    
    const worker = await import(workerPath);
    
    if (typeof worker.run !== 'function') {
      return res.status(400).json({
        success: false,
        error: `Worker ${workerId} does not export a run function`
      });
    }
    
    const startTime = Date.now();
    const result = await worker.run(input, {});
    const duration = Date.now() - startTime;
    
    res.json({
      success: true,
      workerId: worker.id || workerId,
      description: worker.description,
      result,
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`Error running worker ${workerId}:`, error);
    res.status(500).json({
      success: false,
      workerId,
      error: 'Worker execution failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
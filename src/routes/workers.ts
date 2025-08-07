/**
 * Workers Status Route
 * Provides endpoints for monitoring worker status
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import WorkerManager from '../services/workerManager.js';

const router = Router();
const workerManager = new WorkerManager();

// Initialize workers on route load
workerManager.launchAllWorkers();

/**
 * GET /workers/status - Get current worker status
 */
router.get('/workers/status', (req: Request, res: Response) => {
  try {
    const status = workerManager.getWorkerStatus();
    
    res.json({
      timestamp: new Date().toISOString(),
      summary: {
        totalWorkers: status.activeWorkers.length + Object.keys(status.errors).length,
        activeWorkers: status.activeWorkers.length,
        errorWorkers: Object.keys(status.errors).length
      },
      workers: {
        active: status.activeWorkers,
        lastRunTimestamps: status.lastRunTimestamps,
        uptime: status.uptime,
        errors: status.errors
      },
      system: {
        model: process.env.AI_MODEL || 'gpt-3.5-turbo',
        memoryPath: process.env.NODE_ENV === 'production' ? '/var/arc/log/session.log' : './memory/session.log',
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
 * POST /workers/restart/:workerId - Restart a specific worker
 */
router.post('/workers/restart/:workerId', (req: Request, res: Response) => {
  const { workerId } = req.params;
  
  try {
    const success = workerManager.restartWorker(workerId);
    
    if (success) {
      res.json({
        success: true,
        message: `Worker ${workerId} restart initiated`,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(404).json({
        success: false,
        message: `Worker ${workerId} not found`
      });
    }
  } catch (error) {
    console.error(`Error restarting worker ${workerId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to restart worker',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /workers/restart-all - Restart all workers
 */
router.post('/workers/restart-all', (req: Request, res: Response) => {
  try {
    workerManager.stopAllWorkers();
    
    // Wait a moment then restart all
    setTimeout(() => {
      workerManager.launchAllWorkers();
    }, 2000);
    
    res.json({
      success: true,
      message: 'All workers restart initiated',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error restarting all workers:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to restart workers',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /workers/logs/:workerId - Get logs for a specific worker
 */
router.get('/workers/logs/:workerId', (req: Request, res: Response) => {
  const { workerId } = req.params;
  
  try {
    // Read from session log
    const logPath = process.env.NODE_ENV === 'production' ? '/var/arc/log/session.log' : './memory/session.log';
    
    if (fs.existsSync(logPath)) {
      const logs = fs.readFileSync(logPath, 'utf8');
      const workerLogs = logs
        .split('\n')
        .filter((line: string) => line.includes(`[${workerId}]`))
        .slice(-50); // Last 50 entries
      
      res.json({
        workerId,
        logs: workerLogs,
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({
        workerId,
        logs: [],
        message: 'No logs available yet'
      });
    }
  } catch (error) {
    console.error(`Error getting logs for worker ${workerId}:`, error);
    res.status(500).json({
      error: 'Failed to get worker logs',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
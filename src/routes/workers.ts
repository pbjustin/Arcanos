/**
 * Workers Status Route
 * Provides endpoints for monitoring worker status
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
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

/**
 * GET /workers/diagnosis - ARCANOS worker system diagnosis as requested
 * Returns diagnostic JSON with workers_detected, stubs_created, memory_status
 */
router.get('/workers/diagnosis', (req: Request, res: Response) => {
  try {
    // Check /app/workers directory
    const appWorkersPath = '/app/workers';
    let workersDetected = 0;
    let stubsCreated: string[] = [];
    let memoryStatus = 'OK';
    
    // Scan for workers in /app/workers
    if (fs.existsSync(appWorkersPath)) {
      const files = fs.readdirSync(appWorkersPath);
      const workerFiles = files.filter(file => file.endsWith('.js'));
      workersDetected = workerFiles.length;
      stubsCreated = workerFiles.map(file => file.replace('.js', ''));
    } else {
      memoryStatus = 'error - /app/workers directory not found';
    }
    
    // Check memory system
    const memoryLogPath = process.env.NODE_ENV === 'production' ? '/var/arc/log/session.log' : './memory/session.log';
    if (!fs.existsSync(path.dirname(memoryLogPath))) {
      memoryStatus = 'error - memory directory not accessible';
    } else if (memoryStatus === 'OK') {
      try {
        // Test write to memory
        const testLogPath = path.join(path.dirname(memoryLogPath), 'test.log');
        fs.writeFileSync(testLogPath, 'test');
        fs.unlinkSync(testLogPath);
      } catch (error) {
        memoryStatus = 'error - memory write test failed';
      }
    }
    
    // Get worker manager status for additional context
    const status = workerManager.getWorkerStatus();
    
    const diagnosticResult = {
      workers_detected: workersDetected,
      stubs_created: stubsCreated,
      memory_status: memoryStatus,
      timestamp: new Date().toISOString(),
      additional_info: {
        app_workers_path: appWorkersPath,
        app_workers_exists: fs.existsSync(appWorkersPath),
        running_workers: status.activeWorkers.length,
        total_registered: status.activeWorkers.length + Object.keys(status.errors).length,
        memory_log_path: memoryLogPath,
        fine_tuned_model: 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2'
      }
    };
    
    // Log the diagnosis for tracking
    const logMessage = `ARCANOS DIAGNOSIS: ${workersDetected} workers detected, stubs: [${stubsCreated.join(', ')}], memory: ${memoryStatus}`;
    console.log(`[${new Date().toISOString()}] [WorkerManager] ${logMessage}`);
    
    res.json(diagnosticResult);
  } catch (error) {
    console.error('Error in worker diagnosis:', error);
    res.status(500).json({
      workers_detected: 0,
      stubs_created: [],
      memory_status: 'error - diagnosis failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
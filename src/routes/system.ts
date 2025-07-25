import { Router } from 'express';
import { sleepManager } from '../services/sleep-manager';
import { getCurrentSleepWindowStatus, logSleepWindowStatus } from '../services/sleep-config';

const router = Router();

router.get('/diagnostics', async (_req, res) => {
  try {
    const result = {
      last_run: new Date().toISOString(),
      status: 'healthy',
      active_agents: ['ARCANOS Overseer', 'Runtime Companion'],
      pending_tasks: 2,
      errors: [] as string[],
    };

    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: 'Diagnostics failed',
      details: error.message,
    });
  }
});

router.get('/workers', async (_req, res) => {
  try {
    const workers = [
      { name: 'AuditWorker', status: 'running', lastCheck: new Date().toISOString() },
      { name: 'MemorySync', status: 'idle', lastRun: '2025-07-22T02:00:00Z' }
    ];

    res.json(workers);
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: 'Worker route failure',
      details: error.message
    });
  }
});

// Sleep window status endpoint
router.get('/sleep', async (_req, res) => {
  try {
    const sleepStatus = getCurrentSleepWindowStatus();
    const shouldReduce = sleepManager.shouldReduceActivity();
    
    res.json({
      sleepWindow: {
        active: sleepStatus.inSleepWindow,
        timeZone: 'America/New_York',
        windowHours: '7:00 AM - 2:00 PM ET',
        nextSleepStart: sleepStatus.nextSleepStart?.toISOString(),
        nextSleepEnd: sleepStatus.nextSleepEnd?.toISOString(),
        timeUntilSleep: sleepStatus.timeUntilSleep,
        timeUntilWake: sleepStatus.timeUntilWake
      },
      serverMode: {
        reducedActivity: shouldReduce,
        maintenanceTasksActive: sleepStatus.inSleepWindow,
        currentTime: new Date().toISOString()
      },
      manager: {
        initialized: true,
        status: 'active'
      }
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: 'Sleep status check failed',
      details: error.message
    });
  }
});

// Force log sleep status (for debugging)
router.post('/sleep/log', async (_req, res) => {
  try {
    logSleepWindowStatus();
    res.json({
      status: 'logged',
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to log sleep status',
      details: error.message
    });
  }
});

export default router;

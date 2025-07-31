import { Router } from 'express';
import { sleepManager } from '../services/sleep-manager';
import { getCurrentSleepWindowStatus, logSleepWindowStatus } from '../services/sleep-config';
import { diagnosticsService } from '../services/diagnostics';

const router = Router();

router.get('/diagnostics', async (_req, res) => {
  try {
    const result = await diagnosticsService.executeDiagnosticCommand('system health');
    const json = JSON.stringify(result, null, 2);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(json);
  } catch (error: any) {
    console.error('[Diagnostics Error]', error);
    res.status(500).json({
      error: 'Failed to run diagnostics',
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

// Worker heartbeat
router.get('/workers/heartbeat', (_req, res) => {
  res.json({ service: 'workers', status: 'ok', timestamp: new Date().toISOString() });
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

// Webhook listener for external events
router.post('/event', (req, res) => {
  console.log('\uD83D\uDD14 Webhook triggered:', req.body);

  // Placeholder for future event handling logic
  // - Log to memory
  // - Trigger fallback routines
  // - Flag status for analytics
  // - Patch Codex or MyAI context

  res.status(200).send({ success: true });
});

export default router;

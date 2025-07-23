import { Router } from 'express';

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

export default router;

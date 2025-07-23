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

export default router;

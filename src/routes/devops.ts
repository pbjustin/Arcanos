import { Router, Request, Response } from 'express';
import { runSelfTestPipeline } from '../services/selfTestPipeline.js';
import { generateDailySummary } from '../services/dailySummaryService.js';

const router = Router();

router.post('/devops/self-test', async (req: Request, res: Response) => {
  try {
    const summary = await runSelfTestPipeline({
      baseUrl: req.body?.baseUrl,
      triggeredBy: req.body?.triggeredBy || 'api'
    });
    res.json(summary);
  } catch (error) {
    console.error('[DEVOPS] Self-test execution failed', error);
    res.status(500).json({
      error: 'Self-test failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.post('/devops/daily-summary', async (_: Request, res: Response) => {
  try {
    const summary = await generateDailySummary('api');
    res.json(summary);
  } catch (error) {
    console.error('[DEVOPS] Daily summary failed', error);
    res.status(500).json({
      error: 'Daily summary failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;

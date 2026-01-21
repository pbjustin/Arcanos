import { Router, Request, Response } from 'express';
import { runSelfTestPipeline } from '../services/selfTestPipeline.js';
import { generateDailySummary } from '../services/dailySummaryService.js';
import { buildTimestampedPayload } from '../utils/responseHelpers.js';
import { resolveErrorMessage } from '../utils/errorHandling.js';

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
    //audit Assumption: self-test errors are server failures; risk: leaking sensitive details; invariant: 500 response; handling: sanitize message with fallback.
    res.status(500).json(buildTimestampedPayload({
      error: 'Self-test failed',
      message: resolveErrorMessage(error)
    }));
  }
});

router.post('/devops/daily-summary', async (_: Request, res: Response) => {
  try {
    const summary = await generateDailySummary('api');
    res.json(summary);
  } catch (error) {
    console.error('[DEVOPS] Daily summary failed', error);
    //audit Assumption: daily summary errors are server failures; risk: leaking sensitive details; invariant: 500 response; handling: sanitize message with fallback.
    res.status(500).json(buildTimestampedPayload({
      error: 'Daily summary failed',
      message: resolveErrorMessage(error)
    }));
  }
});

export default router;

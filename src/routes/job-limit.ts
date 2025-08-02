import { Router, Request, Response } from 'express';
import { delay } from '../utils/delay';
import { 
  createRateLimitMiddleware, 
  asyncHandler, 
  requestTimingMiddleware 
} from '../middleware/modern-middleware';

const router = Router();

const CONCURRENT_LIMIT = 3;

async function performJob(data: any): Promise<string> {
  // Simulate async work; replace with real logic
  // Use modern delay utility for better async/await pattern
  await delay(1000);
  return 'done';
}

// Apply modern middleware stack
router.use(requestTimingMiddleware);
router.use(createRateLimitMiddleware(CONCURRENT_LIMIT, 'jobs'));

router.post('/job', asyncHandler(async (req: Request, res: Response) => {
  const { rateLimit } = req as any;
  
  if (rateLimit.isAtLimit()) {
    return res.status(429).json({ 
      error: 'Too many jobs in progress',
      activeJobs: rateLimit.getCount(),
      limit: rateLimit.getLimit(),
      retryAfter: '5s'
    });
  }

  rateLimit.increment();
  try {
    const result = await performJob(req.body);
    res.json({ 
      result,
      jobsCompleted: true,
      activeJobs: rateLimit.getCount(),
      maxJobs: rateLimit.getLimit()
    });
  } finally {
    rateLimit.decrement();
  }
}));

export default router;

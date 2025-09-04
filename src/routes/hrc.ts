import express, { Request, Response } from 'express';
import { hrcCore } from '../modules/hrc.js';
import { createValidationMiddleware, createRateLimitMiddleware, securityHeaders } from '../utils/security.js';

const router = express.Router();

// Apply security middleware and basic rate limiting
router.use(securityHeaders);
router.use(createRateLimitMiddleware(30, 15 * 60 * 1000));

const hrcSchema = {
  message: { type: 'string' as const, required: true, minLength: 1, maxLength: 4000, sanitize: true }
};

interface HRCRequest {
  message: string;
}

router.post('/api/ask-hrc', createValidationMiddleware(hrcSchema), async (
  req: Request<{}, any, HRCRequest>,
  res: Response
) => {
  const { message } = req.body;

  try {
    const result = await hrcCore.evaluate(message);
    res.json({ success: true, result });
  } catch (err: any) {
    console.error('HRC evaluation failed:', err);
    res.status(500).json({ success: false, error: err.message || 'HRC evaluation failed' });
  }
});

export default router;

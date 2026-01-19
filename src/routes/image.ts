import express, { Request, Response } from 'express';
import { validateAIRequest, handleAIError } from '../utils/requestHandler.js';
import { createValidationMiddleware, createRateLimitMiddleware, securityHeaders, commonSchemas } from '../utils/security.js';
import { generateImage } from '../services/openai.js';

const router = express.Router();

// Apply security middleware
router.use(securityHeaders);
router.use(createRateLimitMiddleware(20, 15 * 60 * 1000)); // 20 requests per 15 minutes

// Validation schema for image generation
const imageValidationSchema = {
  ...commonSchemas.aiRequest,
  size: { type: 'string' as const, maxLength: 20, sanitize: true }
};

const imageValidationMiddleware = createValidationMiddleware(imageValidationSchema);

router.post('/image', imageValidationMiddleware, async (req: Request, res: Response) => {
  const validation = validateAIRequest(req, res, 'image');
  if (!validation) return; // Response already sent (mock or error)

  const { input } = validation;
  const size = typeof req.body.size === 'string' ? req.body.size : '1024x1024';

  try {
    const result = await generateImage(input, size);
    res.json(result);
  } catch (err) {
    handleAIError(err, input, 'image', res);
  }
});

export default router;

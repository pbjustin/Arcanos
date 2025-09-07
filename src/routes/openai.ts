import express from 'express';
import { handlePrompt } from '../controllers/openaiController.js';
import { createValidationMiddleware, createRateLimitMiddleware, commonSchemas } from '../utils/security.js';

const router = express.Router();

router.post(
  '/prompt',
  createRateLimitMiddleware(50, 15 * 60 * 1000),
  createValidationMiddleware(commonSchemas.aiRequest),
  handlePrompt
);

export default router;

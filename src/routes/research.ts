import express, { Request, Response } from 'express';
import { confirmGate } from '../middleware/confirmGate.js';
import { createValidationMiddleware } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { connectResearchBridge } from '../services/researchHub.js';
import { buildValidationErrorResponse } from '../utils/errorResponse.js';

const routeBridge = connectResearchBridge('ROUTE:RESEARCH');

const router = express.Router();

const researchSchema = {
  topic: {
    required: true,
    type: 'string' as const,
    minLength: 1,
    maxLength: 500,
    sanitize: true
  },
  urls: {
    required: false,
    type: 'array' as const
  }
};

router.post(
  '/commands/research',
  confirmGate,
  createValidationMiddleware(researchSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { topic, urls = [] } = req.body as { topic: string; urls?: string[] };

    if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string')) {
      //audit Assumption: urls must be string array; risk: rejecting valid payloads; invariant: only strings allowed; handling: standardized validation error.
      return res.status(400).json(buildValidationErrorResponse(["Field 'urls' must be an array of strings"]));
    }

    const result = await routeBridge.requestResearch({ topic, urls });

    res.json({
      success: true,
      ...result
    });
  })
);

export default router;

import express from 'express';
import { confirmGate } from '../../middleware/confirmGate.js';
import { createValidationMiddleware } from '../../utils/security.js';
import { connectResearchBridge } from '../../services/researchHub.js';
import { buildValidationErrorResponse } from '../../lib/errors/index.js';

const router = express.Router();
const sdkResearchBridge = connectResearchBridge('SDK:RESEARCH');

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
  '/research',
  confirmGate,
  createValidationMiddleware(researchSchema),
  async (req, res) => {
    const { topic, urls = [] } = req.body as { topic: string; urls?: string[] };

    //audit Assumption: urls must be string array; Handling: reject invalid values
    if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string')) {
      //audit Assumption: urls must be string array; risk: rejecting valid payloads; invariant: only strings allowed; handling: standardized validation error.
      return res
        .status(400)
        .json({ success: false, ...buildValidationErrorResponse(["Field 'urls' must be an array of strings"]) });
    }

    const result = await sdkResearchBridge.requestResearch({ topic, urls });

    res.json({
      success: true,
      ...result
    });
  }
);

export default router;

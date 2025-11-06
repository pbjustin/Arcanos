import express, { Request, Response } from 'express';
import { runThroughBrain } from '../logic/trinity.js';
import { validateAIRequest, handleAIError, logRequestFeedback } from '../utils/requestHandler.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { createValidationMiddleware, createRateLimitMiddleware, securityHeaders, commonSchemas } from '../utils/security.js';
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from '../types/dto.js';

const router = express.Router();

// Apply security middleware
router.use(securityHeaders);
router.use(createRateLimitMiddleware(60, 15 * 60 * 1000)); // 60 requests per 15 minutes

// Enhanced validation schema for ask requests
const askValidationSchema = {
  ...commonSchemas.aiRequest,
  sessionId: { type: 'string' as const, maxLength: 100, sanitize: true },
  overrideAuditSafe: { type: 'string' as const, maxLength: 50, sanitize: true }
};

export const askValidationMiddleware = createValidationMiddleware(askValidationSchema);

export type AskRequest = AIRequestDTO & {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
};

export interface AskResponse extends AIResponseDTO {
  routingStages?: string[];
  gpt5Used?: boolean;
  auditSafe?: {
    mode: boolean;
    overrideUsed: boolean;
    overrideReason?: string;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext?: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
  };
  taskLineage?: {
    requestId: string;
    logged: boolean;
  };
}

/**
 * Shared handler for both ask and brain endpoints
 * Handles AI request processing with standardized error handling and validation
 */
export const handleAIRequest = async (
  req: Request<{}, AskResponse | ErrorResponseDTO, AskRequest>,
  res: Response<AskResponse | ErrorResponseDTO>,
  endpointName: string
) => {
  const { sessionId, overrideAuditSafe } = req.body;

  // Use shared validation logic
  const validation = validateAIRequest(req, res, endpointName);
  if (!validation) return; // Response already sent

  const { client: openai, input: prompt } = validation;

  console.log(`[📨 ${endpointName.toUpperCase()}] Processing with sessionId: ${sessionId || 'none'}, auditOverride: ${overrideAuditSafe || 'none'}`);

  // Log request for feedback loop
  logRequestFeedback(prompt, endpointName);

  try {
    // runThroughBrain now unconditionally routes through GPT-5 before final ARCANOS processing
    const output = await runThroughBrain(openai, prompt, sessionId, overrideAuditSafe);
    return res.json(output as AskResponse);
  } catch (err) {
    handleAIError(err, prompt, endpointName, res);
  }
};

// Primary ask endpoint routed through the Trinity brain (no confirmation required)
router.post('/ask', askValidationMiddleware, (req, res) => handleAIRequest(req, res, 'ask'));

// Brain endpoint (alias for ask with same functionality) still requires confirmation
router.post('/brain', askValidationMiddleware, confirmGate, (req, res) => handleAIRequest(req, res, 'brain'));

export default router;

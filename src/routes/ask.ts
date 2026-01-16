import express, { Request, Response } from 'express';
import { runThroughBrain } from '../logic/trinity.js';
import { validateAIRequest, handleAIError, logRequestFeedback } from '../utils/requestHandler.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { createRateLimitMiddleware, securityHeaders, validateInput } from '../utils/security.js';
import type { AIRequestDTO, AIResponseDTO, ClientContextDTO, ErrorResponseDTO } from '../types/dto.js';

const router = express.Router();

// Apply security middleware
router.use(securityHeaders);
router.use(createRateLimitMiddleware(60, 15 * 60 * 1000)); // 60 requests per 15 minutes

const ASK_TEXT_FIELDS = ['prompt', 'userInput', 'content', 'text', 'query'] as const;

// Enhanced validation schema for ask requests that accepts multiple text field aliases
const askValidationSchema = {
  prompt: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  userInput: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  content: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  text: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  query: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  model: { type: 'string' as const, maxLength: 100, sanitize: true },
  temperature: { type: 'number' as const },
  max_tokens: { type: 'number' as const },
  clientContext: { type: 'object' as const },
  sessionId: { type: 'string' as const, maxLength: 100, sanitize: true },
  overrideAuditSafe: { type: 'string' as const, maxLength: 50, sanitize: true }
};

export const askValidationMiddleware = (req: Request, res: Response, next: () => void) => {
  const rawSource = req.method === 'GET' ? req.query : req.body;
  const source =
    req.method === 'GET'
      ? Object.fromEntries(
          Object.entries(rawSource).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
        )
      : rawSource;

  const validation = validateInput(source, askValidationSchema);

  if (!validation.isValid) {
    return res.status(400).json({
      error: 'Validation failed',
      details: validation.errors,
      timestamp: new Date().toISOString()
    });
  }

  const hasTextField = ASK_TEXT_FIELDS.some(field => {
    const value = validation.sanitized[field];
    return typeof value === 'string' && value.trim().length > 0;
  });

  if (!hasTextField) {
    return res.status(400).json({
      error: 'Validation failed',
      details: [`Request must include one of ${ASK_TEXT_FIELDS.join(', ')} fields`],
      acceptedFields: ASK_TEXT_FIELDS,
      maxLength: 10000,
      timestamp: new Date().toISOString()
    });
  }

  req.body = validation.sanitized;
  next();
};

export type AskRequest = AIRequestDTO & {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  clientContext?: ClientContextDTO;
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
  clientContext?: ClientContextDTO;
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
    // runThroughBrain now unconditionally routes through GPT-5.1 before final ARCANOS processing
    const output = await runThroughBrain(openai, prompt, sessionId, overrideAuditSafe);
    return res.json({ ...(output as AskResponse), clientContext: req.body.clientContext });
  } catch (err) {
    handleAIError(err, prompt, endpointName, res);
  }
};

// Primary ask endpoint routed through the Trinity brain (no confirmation required)
router.post('/ask', askValidationMiddleware, (req, res) => handleAIRequest(req, res, 'ask'));
router.get('/ask', askValidationMiddleware, (req, res) => handleAIRequest(req, res, 'ask'));

// Brain endpoint (alias for ask with same functionality) still requires confirmation
router.post('/brain', askValidationMiddleware, confirmGate, (req, res) => handleAIRequest(req, res, 'brain'));
router.get('/brain', askValidationMiddleware, confirmGate, (req, res) => handleAIRequest(req, res, 'brain'));

export default router;

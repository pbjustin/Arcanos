import express, { Request, Response } from 'express';
import { runThroughBrain } from '../logic/trinity.js';
import { 
  validateAIRequest, 
  handleAIError, 
  logRequestFeedback,
  StandardAIRequest,
  StandardAIResponse,
  ErrorResponse
} from '../utils/requestHandler.js';

const router = express.Router();

interface AskRequest extends StandardAIRequest {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
}

interface AskResponse extends StandardAIResponse {
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
const handleAIRequest = async (
  req: Request<{}, AskResponse | ErrorResponse, AskRequest>,
  res: Response<AskResponse | ErrorResponse>,
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
    return res.json(output);
  } catch (err) {
    handleAIError(err, prompt, endpointName, res);
  }
};

// Primary ask endpoint routed through the Trinity brain
router.post('/ask', (req, res) => handleAIRequest(req, res, 'ask'));

// Brain endpoint (alias for ask with same functionality)
router.post('/brain', (req, res) => handleAIRequest(req, res, 'brain'));

export default router;

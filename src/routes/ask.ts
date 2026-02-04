import express, { Request, Response } from 'express';
import { runThroughBrain } from '../logic/trinity.js';
import { validateAIRequest, handleAIError, logRequestFeedback } from '../utils/requestHandler.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { createRateLimitMiddleware, securityHeaders } from '../utils/security.js';
import type {
  ConfirmationRequiredResponseDTO,
  ErrorResponseDTO
} from '../types/dto.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { askValidationMiddleware } from './ask/validation.js';
import type { AskRequest, AskResponse } from './ask/types.js';
import { tryDispatchDaemonTools } from './ask/daemonTools.js';

const router = express.Router();

// Apply security middleware
router.use(securityHeaders);
router.use(createRateLimitMiddleware(60, 15 * 60 * 1000)); // 60 requests per 15 minutes


/**
 * Shared handler for both ask and brain endpoints
 * Handles AI request processing with standardized error handling and validation
 */
export const handleAIRequest = async (
  req: Request<{}, AskResponse | ErrorResponseDTO | ConfirmationRequiredResponseDTO, AskRequest>,
  res: Response<AskResponse | ErrorResponseDTO | ConfirmationRequiredResponseDTO>,
  endpointName: string
) => {
  const { sessionId, overrideAuditSafe, metadata } = req.body;

  // Use shared validation logic
  const validation = validateAIRequest(req, res, endpointName);
  if (!validation) return; // Response already sent

  const { client: openai, input: prompt } = validation;

  console.log(`[📨 ${endpointName.toUpperCase()}] Processing with sessionId: ${sessionId || 'none'}, auditOverride: ${overrideAuditSafe || 'none'}`);

  // Log request for feedback loop
  logRequestFeedback(prompt, endpointName);

  try {
    const daemonToolResponse = await tryDispatchDaemonTools(openai, prompt, metadata);
    if (daemonToolResponse) {
      if ('confirmation_required' in daemonToolResponse) {
        //audit Assumption: confirmation required should block response; risk: sensitive execution; invariant: 403 returned; handling: return challenge.
        return res.status(403).json({
          code: 'CONFIRMATION_REQUIRED',
          confirmationChallenge: { id: daemonToolResponse.confirmation_token },
          pending_actions: daemonToolResponse.pending_actions
        });
      }
      //audit Assumption: daemon tool response is terminal; risk: skipping trinity; invariant: tool actions queued; handling: return early.
      return res.json({ ...daemonToolResponse, clientContext: req.body.clientContext });
    }

    // runThroughBrain now unconditionally routes through GPT-5.1 before final ARCANOS processing
    const output = await runThroughBrain(openai, prompt, sessionId, overrideAuditSafe);
    return res.json({ ...(output as AskResponse), clientContext: req.body.clientContext });
  } catch (err) {
    handleAIError(err, prompt, endpointName, res);
  }
};

// Primary ask endpoint routed through the Trinity brain (no confirmation required)
router.post('/ask', askValidationMiddleware, asyncHandler((req, res) => handleAIRequest(req, res, 'ask')));
router.get('/ask', askValidationMiddleware, asyncHandler((req, res) => handleAIRequest(req, res, 'ask')));

// Brain endpoint (alias for ask with same functionality) still requires confirmation
router.post('/brain', askValidationMiddleware, confirmGate, asyncHandler((req, res) => handleAIRequest(req, res, 'brain')));
router.get('/brain', askValidationMiddleware, confirmGate, asyncHandler((req, res) => handleAIRequest(req, res, 'brain')));

export default router;

export type { AskRequest, AskResponse };
export { askValidationMiddleware };

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
import { confirmGate } from '../middleware/confirmGate.js';

const router = express.Router();

interface SiriRequest extends StandardAIRequest {
  query: string;
  sessionId?: string;
  overrideAuditSafe?: string;
}

interface SiriResponse extends StandardAIResponse {
  content: string;
}

const handleSiriRequest = async (
  req: Request<{}, SiriResponse | ErrorResponse, SiriRequest>,
  res: Response<SiriResponse | ErrorResponse>
) => {
  const { sessionId, overrideAuditSafe } = req.body;

  const validation = validateAIRequest(req, res, 'siri');
  if (!validation) return;

  const { client: openai, input } = validation;

  logRequestFeedback(input, 'siri');

  try {
    const output = await runThroughBrain(openai, input, sessionId, overrideAuditSafe);
    return res.json({ ...output, content: output.result });
  } catch (err) {
    handleAIError(err, input, 'siri', res);
  }
};

router.post('/siri', confirmGate, (req, res) => handleSiriRequest(req, res));

export default router;

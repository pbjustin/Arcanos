import express, { Request, Response } from 'express';
import { runThroughBrain } from '../logic/trinity.js';
import { validateAIRequest, handleAIError, logRequestFeedback } from '../utils/requestHandler.js';
import { confirmGate } from '../middleware/confirmGate.js';
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from '../types/dto.js';

const router = express.Router();

type SiriRequest = AIRequestDTO & {
  query: string;
  sessionId?: string;
  overrideAuditSafe?: string;
};

interface SiriResponse extends AIResponseDTO {
  content?: string;
}

const handleSiriRequest = async (
  req: Request<{}, SiriResponse | ErrorResponseDTO, SiriRequest>,
  res: Response<SiriResponse | ErrorResponseDTO>
) => {
  const { sessionId, overrideAuditSafe } = req.body;

  const validation = validateAIRequest(req, res, 'siri');
  if (!validation) return;

  const { client: openai, input } = validation;

  logRequestFeedback(input, 'siri');

  try {
    const output = await runThroughBrain(openai, input, sessionId, overrideAuditSafe);
    return res.json({ ...output, content: output.result } as SiriResponse);
  } catch (err) {
    handleAIError(err, input, 'siri', res);
  }
};

router.post('/siri', confirmGate, (req, res) => handleSiriRequest(req, res));

export default router;

import express, { Request, Response } from 'express';
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { validateAIRequest, handleAIError, logRequestFeedback } from "@transport/http/requestHandler.js";
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from "@shared/types/dto.js";
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { buildTrinityOutputControlOptions } from '@shared/ask/trinityRequestOptions.js';
import { buildTrinityUserVisibleResponse } from '@shared/ask/trinityResponseSerializer.js';

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
    const runtimeBudget = createRuntimeBudget();
    const output = await runTrinityWritingPipeline({
      input: {
        prompt: input,
        sessionId,
        overrideAuditSafe,
        sourceEndpoint: 'siri',
        body: req.body
      },
      context: {
        client: openai,
        requestId: req.requestId,
        runtimeBudget,
        runOptions: buildTrinityOutputControlOptions(req.body)
      }
    });
    const userVisibleResponse = buildTrinityUserVisibleResponse({
      trinityResult: output,
      endpoint: 'siri',
      clientContext: req.body.clientContext
    });
    return res.json({ ...userVisibleResponse, content: userVisibleResponse.result } as SiriResponse);
  } catch (err) {
    handleAIError(err, input, 'siri', res);
  }
};

router.post('/siri', confirmGate, (req, res) => handleSiriRequest(req, res));

export default router;

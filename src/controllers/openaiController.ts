import { Request, Response } from 'express';
import { createCentralizedCompletion, getDefaultModel } from '../services/openai.js';
import {
  validateAIRequest,
  handleAIError,
  StandardAIRequest,
  ErrorResponse
} from '../utils/requestHandler.js';

interface PromptRequest extends StandardAIRequest {
  prompt: string;
  model?: string;
}

interface PromptResponse {
  result: string;
  model: string;
}

export async function handlePrompt(
  req: Request<{}, PromptResponse | ErrorResponse, PromptRequest>,
  res: Response<PromptResponse | ErrorResponse>
): Promise<void> {
  const validation = validateAIRequest(req, res, 'prompt');
  if (!validation) return; // Response already handled (mock or error)

  const { input: prompt } = validation;
  const model =
    typeof req.body.model === 'string' && req.body.model.trim().length > 0
      ? req.body.model
      : getDefaultModel();

  try {
    const completion = await createCentralizedCompletion([
      { role: 'user', content: prompt }
    ], { model, max_tokens: 256 });

    const result = (completion as any).choices?.[0]?.message?.content || '';
    res.json({ result, model });
  } catch (err) {
    handleAIError(err, prompt, 'prompt', res);
  }
}

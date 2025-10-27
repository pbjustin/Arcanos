import { Request, Response } from 'express';
import { callOpenAI, getDefaultModel } from '../services/openai.js';
import { validateAIRequest, handleAIError } from '../utils/requestHandler.js';
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from '../types/dto.js';

type PromptRequest = AIRequestDTO & {
  prompt: string;
  model?: string;
};

type PromptResponse = AIResponseDTO & {
  model?: string;
};

export async function handlePrompt(
  req: Request<{}, PromptResponse | ErrorResponseDTO, PromptRequest>,
  res: Response<PromptResponse | ErrorResponseDTO>
): Promise<void> {
  const validation = validateAIRequest(req, res, 'prompt');
  if (!validation) return; // Response already handled (mock or error)

  const { input: prompt } = validation;
  const model =
    typeof req.body.model === 'string' && req.body.model.trim().length > 0
      ? req.body.model
      : getDefaultModel();

  try {
    const { output } = await callOpenAI(model, prompt, 256);
    const timestamp = Math.floor(Date.now() / 1000);
    res.json({
      result: output,
      model,
      meta: {
        id: `prompt_${timestamp}`,
        created: timestamp,
        tokens: undefined
      },
      activeModel: model,
      fallbackFlag: false
    });
  } catch (err) {
    handleAIError(err, prompt, 'prompt', res);
  }
}

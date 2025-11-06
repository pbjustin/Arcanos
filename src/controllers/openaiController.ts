import { Request, Response } from 'express';
import {
  callOpenAI,
  getDefaultModel,
  getFallbackModel,
  getGPT5Model,
  getOpenAIServiceHealth,
  getOpenAIKeySource
} from '../services/openai.js';
import { validateAIRequest, handleAIError } from '../utils/requestHandler.js';
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from '../types/dto.js';
import { getConfirmGateConfiguration } from '../middleware/confirmGate.js';

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

export function getOpenAIStatus(_: Request, res: Response): void {
  const health = getOpenAIServiceHealth();
  const confirmation = getConfirmGateConfiguration();
  const keySource = getOpenAIKeySource();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    openai: {
      configured: health.apiKey.configured,
      keyStatus: health.apiKey.status,
      keySource,
      defaultModel: getDefaultModel(),
      fallbackModel: getFallbackModel(),
      gpt5Model: getGPT5Model(),
      clientInitialized: health.client.initialized,
      timeout: health.client.timeout,
      baseURL: health.client.baseURL || null,
      circuitBreaker: health.circuitBreaker,
      cache: health.cache,
      lastHealthCheck: health.lastHealthCheck
    },
    confirmation,
    environment: {
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
      nodeEnv: process.env.NODE_ENV || 'development'
    }
  });
}

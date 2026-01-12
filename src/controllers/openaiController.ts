/**
 * OpenAI Controller
 * 
 * Provides HTTP endpoints for direct OpenAI API interactions including
 * prompt execution and service health status reporting.
 * 
 * @module openaiController
 */

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
import config from '../config/index.js';

/**
 * Request type for prompt execution with optional model override.
 */
type PromptRequest = AIRequestDTO & {
  prompt: string;
  model?: string;
};

/**
 * Response type for prompt execution including model information.
 */
type PromptResponse = AIResponseDTO & {
  model?: string;
};

const PROMPT_MAX_TOKENS = config.ai.defaultMaxTokens || 256;

/**
 * Handles direct OpenAI prompt execution requests.
 * Accepts a prompt string and optional model override. Validates input,
 * executes the completion, and returns the AI-generated response.
 * 
 * @param req - Express request with prompt and optional model
 * @param res - Express response for completion result
 */
export async function handlePrompt(
  req: Request<{}, PromptResponse | ErrorResponseDTO, PromptRequest>,
  res: Response<PromptResponse | ErrorResponseDTO>
): Promise<void> {
  const validation = validateAIRequest(req, res, 'prompt');
  if (!validation) return; // Response already handled (mock or error)

  const { input: prompt } = validation;
  const modelOverride = typeof req.body.model === 'string' ? req.body.model.trim() : undefined;
  const model = modelOverride && modelOverride.length > 0 ? modelOverride : getDefaultModel();

  try {
    const { output } = await callOpenAI(model, prompt, PROMPT_MAX_TOKENS);
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

/**
 * Returns comprehensive OpenAI service status and configuration.
 * Includes API key status, model configuration, circuit breaker state,
 * cache status, and environment details. Useful for diagnostics and monitoring.
 * 
 * @param _ - Express request (unused)
 * @param res - Express response with service status
 */
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

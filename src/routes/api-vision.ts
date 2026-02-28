import express, { Request, Response } from 'express';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from "@platform/runtime/security.js";
import { buildValidationErrorResponse, resolveErrorMessage } from "@core/lib/errors/index.js";
import { aiLogger } from "@platform/logging/structuredLogging.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import type { ErrorResponseDTO } from "@shared/types/dto.js";
import { asyncHandler } from "@transport/http/asyncHandler.js";
import { buildVisionRequest } from "@services/openai/requestBuilders.js";
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { sendOpenAIProcessingFailed, sendOpenAIServiceUnavailable } from "@platform/resilience/serviceUnavailable.js";

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(20, 15 * 60 * 1000)); // 20 requests per 15 minutes

const MAX_IMAGE_BASE64_LENGTH = 8_000_000;
const MAX_PROMPT_LENGTH = 2000;
const DEFAULT_PROMPT = 'Describe this image clearly and concisely.';

const visionValidationSchema = {
  imageBase64: { type: 'string' as const, required: true, minLength: 1, maxLength: MAX_IMAGE_BASE64_LENGTH },
  prompt: { type: 'string' as const, required: false, maxLength: MAX_PROMPT_LENGTH, sanitize: true },
  temperature: { type: 'number' as const, required: false },
  model: { type: 'string' as const, required: false, maxLength: 100, sanitize: true },
  maxTokens: { type: 'number' as const, required: false }
};

const visionValidation = createValidationMiddleware(visionValidationSchema);

interface VisionRequest {
  imageBase64: string;
  prompt?: string;
  temperature?: number;
  model?: string;
  maxTokens?: number;
}

interface VisionResponse {
  response: string;
  tokens: number;
  cost: number;
  model: string;
}

function normalizeImagePayload(rawValue: string): { base64: string; mimeType: string } {
  const trimmedValue = rawValue.trim();
  const dataPrefixMatch = trimmedValue.match(/^data:([^;]+);base64,(.*)$/);
  if (dataPrefixMatch && dataPrefixMatch[2]) {
    return { base64: dataPrefixMatch[2].trim(), mimeType: dataPrefixMatch[1].trim() };
  }
  return { base64: trimmedValue, mimeType: 'image/png' };
}

function resolveVisionModel(override?: string): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  // Default vision model (config can be extended later)
  return 'gpt-4o';
}

function calculateVisionCost(inputTokens: number, outputTokens: number): number {
  // GPT-4o vision pricing: $2.50/1M input, $10.00/1M output
  const inputRate = 2.50;
  const outputRate = 10.00;
  const safeInputTokens = Math.max(0, inputTokens);
  const safeOutputTokens = Math.max(0, outputTokens);
  return (safeInputTokens * inputRate + safeOutputTokens * outputRate) / 1_000_000;
}

router.post('/api/vision', visionValidation, asyncHandler(async (req: Request<{}, VisionResponse | ErrorResponseDTO, VisionRequest>, res: Response<VisionResponse | ErrorResponseDTO>) => {
    const { imageBase64, prompt, temperature, model, maxTokens } = req.body;
    try {

    if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.trim().length === 0) {
      return res.status(400).json(
        buildValidationErrorResponse(['imageBase64 is required and must be a non-empty string'])
      );
    }

    const { base64, mimeType } = normalizeImagePayload(imageBase64);
    if (base64.length === 0) {
      return res.status(400).json(
        buildValidationErrorResponse(['imageBase64 must contain valid base64 data'])
      );
    }

    if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
      return res.status(400).json(
        buildValidationErrorResponse([`imageBase64 exceeds maximum length of ${MAX_IMAGE_BASE64_LENGTH} characters`])
      );
    }

    const { adapter } = getOpenAIClientOrAdapter();
    if (!adapter) {
      aiLogger.warn('OpenAI adapter not available for vision request');
      sendOpenAIServiceUnavailable(res);
      return;
    }

    const imageBuffer = Buffer.from(base64, 'base64');
    if (imageBuffer.length === 0) {
      return res.status(400).json(
        buildValidationErrorResponse(['imageBase64 is not valid base64'])
      );
    }

    const visionModel = resolveVisionModel(model);
    const visionPrompt = (prompt && prompt.trim()) || DEFAULT_PROMPT;
    const visionTemperature = temperature !== undefined ? Math.max(0, Math.min(2, temperature)) : 0.7;

    recordTraceEvent('openai.vision.start', {
      model: visionModel,
      promptLength: visionPrompt.length,
      imageBytes: imageBuffer.length
    });

    const requestPayload = buildVisionRequest({
      prompt: visionPrompt,
      imageBase64: base64,
      mimeType,
      model: visionModel,
      temperature: visionTemperature,
      maxTokens: maxTokens || 1024
    });
    const completion = await adapter.responses.create(requestPayload);

    const responseText = completion.choices[0]?.message?.content || '';
    const tokens = completion.usage?.total_tokens || 0;
    const inputTokens = completion.usage?.prompt_tokens || 0;
    const outputTokens = completion.usage?.completion_tokens || 0;
    const cost = calculateVisionCost(inputTokens, outputTokens);

    recordTraceEvent('openai.vision.success', {
      model: visionModel,
      tokens,
      cost
    });

    aiLogger.info('Vision request completed', {
      operation: 'vision',
      model: visionModel,
      tokens,
      cost
    });

    return res.json({
      response: responseText,
      tokens,
      cost,
      model: visionModel
    });
  } catch (error: unknown) {
    aiLogger.error('Vision request failed', { operation: 'vision' }, undefined, error instanceof Error ? error : undefined);
    recordTraceEvent('openai.vision.error', {
      error: resolveErrorMessage(error)
    });

    sendOpenAIProcessingFailed(res, 'Failed to process vision request');
    return;
  }
}));

export default router;

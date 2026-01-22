/**
 * Vision Route
 * Handle image analysis requests using OpenAI vision.
 */

import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import { logAuditEvent } from '../database';
import { logger } from '../logger';

const router = Router();

interface VisionPayload {
  imageBase64: string;
  prompt: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  mimeType: string;
}

interface ParseResult<T> {
  ok: boolean;
  error?: string;
  value?: T;
}

const MAX_IMAGE_BASE64_LENGTH = 8_000_000;
const MAX_PROMPT_LENGTH = 2000;
const DEFAULT_PROMPT = 'Describe this image clearly and concisely.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  //audit assumption: payload should be a JSON object; risk: invalid body; invariant: plain object; strategy: type guard.
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeImagePayload(rawValue: string): { base64: string; mimeType: string } {
  const trimmedValue = rawValue.trim();
  const dataPrefixMatch = trimmedValue.match(/^data:([^;]+);base64,(.*)$/);
  if (dataPrefixMatch && dataPrefixMatch[2]) {
    //audit assumption: data URL prefix present; risk: incorrect parsing; invariant: base64 extracted; strategy: parse regex.
    return { base64: dataPrefixMatch[2].trim(), mimeType: dataPrefixMatch[1].trim() };
  }
  //audit assumption: raw value is base64; risk: missing mime type; invariant: base64 used; strategy: default to image/png.
  return { base64: trimmedValue, mimeType: 'image/png' };
}

function parseTemperature(value: unknown): ParseResult<number> {
  if (value === undefined || value === null || value === '') {
    //audit assumption: temperature optional; risk: missing value; invariant: default used; strategy: return default.
    return { ok: true, value: 0.7 };
  }

  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    //audit assumption: temperature must be numeric; risk: invalid input; invariant: finite number; strategy: return error.
    return { ok: false, error: 'temperature must be a number' };
  }

  if (parsed < 0 || parsed > 2) {
    //audit assumption: temperature within range; risk: invalid parameter; invariant: 0-2 inclusive; strategy: return error.
    return { ok: false, error: 'temperature must be between 0 and 2' };
  }

  return { ok: true, value: parsed };
}

function parseMaxTokens(value: unknown): ParseResult<number | undefined> {
  if (value === undefined || value === null || value === '') {
    //audit assumption: maxTokens optional; risk: missing value; invariant: undefined allowed; strategy: return undefined.
    return { ok: true, value: undefined };
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    //audit assumption: maxTokens must be positive integer; risk: invalid input; invariant: positive int; strategy: return error.
    return { ok: false, error: 'maxTokens must be a positive integer' };
  }

  return { ok: true, value: parsed };
}

function parseModel(value: unknown): string {
  const configuredModel = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
  if (typeof value === 'string' && value.trim().length > 0) {
    //audit assumption: model override allowed; risk: unsupported model; invariant: non-empty string; strategy: trim and use.
    return value.trim();
  }
  //audit assumption: default model used; risk: config missing; invariant: fallback provided; strategy: return configured default.
  return configuredModel;
}

function parseVisionPayload(body: unknown): ParseResult<VisionPayload> {
  if (!isPlainObject(body)) {
    //audit assumption: request body is JSON object; risk: invalid payload; invariant: object; strategy: return error.
    return { ok: false, error: 'request body must be an object' };
  }

  const rawImageBase64 = body.imageBase64;
  if (typeof rawImageBase64 !== 'string') {
    //audit assumption: imageBase64 required; risk: missing image; invariant: string; strategy: return error.
    return { ok: false, error: 'imageBase64 is required' };
  }

  const { base64, mimeType } = normalizeImagePayload(rawImageBase64);
  if (base64.length === 0) {
    //audit assumption: base64 should be non-empty; risk: invalid payload; invariant: non-empty; strategy: return error.
    return { ok: false, error: 'imageBase64 must be non-empty' };
  }
  if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
    //audit assumption: payload length limited; risk: oversized payload; invariant: size cap; strategy: return error.
    return { ok: false, error: 'imageBase64 exceeds maximum length' };
  }

  const promptValue = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (promptValue.length > MAX_PROMPT_LENGTH) {
    //audit assumption: prompt length limited; risk: oversized payload; invariant: prompt length cap; strategy: return error.
    return { ok: false, error: `prompt exceeds ${MAX_PROMPT_LENGTH} characters` };
  }

  const temperatureResult = parseTemperature(body.temperature);
  if (!temperatureResult.ok || temperatureResult.value === undefined) {
    //audit assumption: temperature valid; risk: invalid temperature; invariant: temperature ok; strategy: return error.
    return { ok: false, error: temperatureResult.error || 'invalid temperature' };
  }

  const maxTokensResult = parseMaxTokens(body.maxTokens);
  if (!maxTokensResult.ok) {
    //audit assumption: maxTokens valid; risk: invalid maxTokens; invariant: maxTokens ok; strategy: return error.
    return { ok: false, error: maxTokensResult.error || 'invalid maxTokens' };
  }

  return {
    ok: true,
    value: {
      imageBase64: base64,
      prompt: promptValue || DEFAULT_PROMPT,
      model: parseModel(body.model),
      temperature: temperatureResult.value,
      maxTokens: maxTokensResult.value,
      mimeType: mimeType || 'image/png'
    }
  };
}

function resolveVisionCostRates() {
  const defaultInputRate = Number.parseFloat(process.env.OPENAI_VISION_INPUT_COST_PER_1M || '2.5');
  const defaultOutputRate = Number.parseFloat(process.env.OPENAI_VISION_OUTPUT_COST_PER_1M || '10');

  //audit assumption: cost rates are finite numbers; risk: NaN; invariant: numeric rates; strategy: fallback to defaults.
  const inputRate = Number.isFinite(defaultInputRate) ? defaultInputRate : 2.5;
  const outputRate = Number.isFinite(defaultOutputRate) ? defaultOutputRate : 10;

  return { inputRate, outputRate };
}

function calculateVisionCost(inputTokens: number, outputTokens: number): number {
  const { inputRate, outputRate } = resolveVisionCostRates();
  //audit assumption: token counts are non-negative; risk: negative values; invariant: non-negative; strategy: max with zero.
  const safeInputTokens = Math.max(0, inputTokens);
  const safeOutputTokens = Math.max(0, outputTokens);
  //audit assumption: cost is linear; risk: inaccurate pricing; invariant: approximation; strategy: per-1M calculation.
  return (safeInputTokens * inputRate + safeOutputTokens * outputRate) / 1_000_000;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId || 'anonymous';
    const payloadResult = parseVisionPayload(req.body);

    if (!payloadResult.ok || !payloadResult.value) {
      //audit assumption: payload should be valid; risk: bad request; invariant: payload ok; strategy: return 400.
      return res.status(400).json({
        error: 'Bad Request',
        message: payloadResult.error || 'Invalid request body'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      //audit assumption: API key configured; risk: backend unusable; invariant: key set; strategy: return 500.
      logger.error('OPENAI_API_KEY is not configured');
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'OpenAI API key is not configured'
      });
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const imageBuffer = Buffer.from(payloadResult.value.imageBase64, 'base64');
    if (imageBuffer.length === 0) {
      //audit assumption: base64 decodes to bytes; risk: invalid base64; invariant: non-empty buffer; strategy: return 400.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'imageBase64 is not valid base64'
      });
    }

    const completion = await openai.chat.completions.create({
      model: payloadResult.value.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: payloadResult.value.prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${payloadResult.value.mimeType};base64,${payloadResult.value.imageBase64}`,
                detail: 'auto'
              }
            }
          ]
        }
      ],
      temperature: payloadResult.value.temperature,
      max_tokens: payloadResult.value.maxTokens
    });

    const responseText = completion.choices[0]?.message?.content || '';
    const tokens = completion.usage?.total_tokens || 0;
    const inputTokens = completion.usage?.prompt_tokens || 0;
    const outputTokens = completion.usage?.completion_tokens || 0;
    const cost = calculateVisionCost(inputTokens, outputTokens);

    await logAuditEvent(
      userId,
      'vision',
      {
        tokens,
        cost,
        model: payloadResult.value.model,
        promptLength: payloadResult.value.prompt.length,
        imageBytes: imageBuffer.length
      },
      req.ip,
      req.get('user-agent')
    );

    return res.json({
      success: true,
      response: responseText,
      tokens,
      cost,
      model: payloadResult.value.model
    });
  } catch (error) {
    //audit assumption: unexpected errors handled; risk: crash; invariant: 500 returned; strategy: log and return error.
    logger.error('Failed to process vision request', { error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process vision request'
    });
  }
});

export default router;

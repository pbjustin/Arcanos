import express, { Request, Response } from 'express';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from '../utils/security.js';
import { buildValidationErrorResponse } from '../utils/errorResponse.js';
import { getOpenAIClient } from '../services/openai/clientFactory.js';
import { aiLogger } from '../utils/structuredLogging.js';
import { recordTraceEvent } from '../utils/telemetry.js';
import { toFile } from 'openai/uploads';
import path from 'path';
import type { ErrorResponseDTO } from '../types/dto.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(20, 15 * 60 * 1000)); // 20 requests per 15 minutes

const MAX_AUDIO_BASE64_LENGTH = 8_000_000;
const DEFAULT_FILENAME = 'audio.wav';

const transcribeValidationSchema = {
  audioBase64: { type: 'string' as const, required: true, minLength: 1, maxLength: MAX_AUDIO_BASE64_LENGTH },
  filename: { type: 'string' as const, required: false, maxLength: 255, sanitize: true },
  model: { type: 'string' as const, required: false, maxLength: 100, sanitize: true },
  language: { type: 'string' as const, required: false, maxLength: 10, sanitize: true }
};

const transcribeValidation = createValidationMiddleware(transcribeValidationSchema);

interface TranscribeRequest {
  audioBase64: string;
  filename?: string;
  model?: string;
  language?: string;
}

interface TranscribeResponse {
  text: string;
  model: string;
}

function sanitizeFilename(value: string | undefined): string {
  if (!value || !value.trim()) {
    return DEFAULT_FILENAME;
  }
  return path.basename(value.trim());
}

function resolveTranscribeModel(override?: string): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
}

router.post('/api/transcribe', transcribeValidation, asyncHandler(async (req: Request<{}, TranscribeResponse | ErrorResponseDTO, TranscribeRequest>, res: Response<TranscribeResponse | ErrorResponseDTO>) => {
    const { audioBase64, filename, model, language } = req.body;
    try {

    if (!audioBase64 || typeof audioBase64 !== 'string' || audioBase64.trim().length === 0) {
      return res.status(400).json(
        buildValidationErrorResponse(['audioBase64 is required and must be a non-empty string'])
      );
    }

    const trimmedAudio = audioBase64.trim();
    if (trimmedAudio.length > MAX_AUDIO_BASE64_LENGTH) {
      return res.status(400).json(
        buildValidationErrorResponse([`audioBase64 exceeds maximum length of ${MAX_AUDIO_BASE64_LENGTH} characters`])
      );
    }

    const client = getOpenAIClient();
    if (!client) {
      aiLogger.warn('OpenAI client not available for transcription request');
      return res.status(503).json({
        error: 'Service Unavailable',
        details: 'OpenAI service is not configured'
      });
    }

    const audioBuffer = Buffer.from(trimmedAudio, 'base64');
    if (audioBuffer.length === 0) {
      return res.status(400).json(
        buildValidationErrorResponse(['audioBase64 is not valid base64'])
      );
    }

    const transcribeModel = resolveTranscribeModel(model);
    const sanitizedFilename = sanitizeFilename(filename);
    const transcribeLanguage = (language && language.trim()) || undefined;

    recordTraceEvent('openai.transcribe.start', {
      model: transcribeModel,
      audioBytes: audioBuffer.length,
      filename: sanitizedFilename
    });

    const file = await toFile(audioBuffer, sanitizedFilename);
    const transcription = await client.audio.transcriptions.create({
      model: transcribeModel,
      file,
      ...(transcribeLanguage ? { language: transcribeLanguage } : {})
    });

    const text = typeof transcription === 'string' ? transcription : transcription.text;

    recordTraceEvent('openai.transcribe.success', {
      model: transcribeModel,
      textLength: text.length
    });

    aiLogger.info('Transcription request completed', {
      operation: 'transcribe',
      model: transcribeModel,
      textLength: text.length
    });

    return res.json({
      text,
      model: transcribeModel
    });
  } catch (error: unknown) {
    aiLogger.error('Transcription request failed', { operation: 'transcribe' }, undefined, error instanceof Error ? error : undefined);
    recordTraceEvent('openai.transcribe.error', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    return res.status(500).json({
      error: 'Internal Server Error',
      details: 'Failed to process transcription request'
    });
  }
}));

export default router;

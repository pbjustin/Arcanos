import express, { Request, Response } from 'express';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from '../utils/security.js';
import { buildValidationErrorResponse, resolveErrorMessage } from '../lib/errors/index.js';
import { aiLogger } from '../utils/structuredLogging.js';
import { recordTraceEvent } from '../utils/telemetry.js';
import { toFile } from 'openai/uploads';
import path from 'path';
import type { ErrorResponseDTO } from '../types/dto.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { buildTranscriptionRequest } from '../services/openai/requestBuilders.js';
import { getOpenAIClientOrAdapter } from '../services/openai/clientBridge.js';
import { sendOpenAIProcessingFailed, sendOpenAIServiceUnavailable } from '../utils/serviceUnavailable.js';

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
  // Default model (config can be extended later to include transcribeModel)
  return 'whisper-1';
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

    const { adapter } = getOpenAIClientOrAdapter();
    if (!adapter) {
      aiLogger.warn('OpenAI adapter not available for transcription request');
      sendOpenAIServiceUnavailable(res);
      return;
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
    const requestParams = buildTranscriptionRequest({
      audioFile: file,
      filename: sanitizedFilename,
      model: transcribeModel,
      language: transcribeLanguage
    });
    const transcription = await adapter.audio.transcriptions.create(requestParams);

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
      error: resolveErrorMessage(error)
    });

    sendOpenAIProcessingFailed(res, 'Failed to process transcription request');
    return;
  }
}));

export default router;

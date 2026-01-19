/**
 * Transcribe Route
 * Handle audio transcription requests using OpenAI.
 */

import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import path from 'path';
import { logAuditEvent } from '../database';
import { logger } from '../logger';

const router = Router();

interface TranscribePayload {
  audioBase64: string;
  model: string;
  filename: string;
  language?: string;
}

interface ParseResult<T> {
  ok: boolean;
  error?: string;
  value?: T;
}

const MAX_AUDIO_BASE64_LENGTH = 8_000_000;
const DEFAULT_FILENAME = 'audio.wav';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  //audit assumption: payload should be a JSON object; risk: invalid body; invariant: plain object; strategy: type guard.
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseModel(value: unknown): string {
  const configuredModel = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
  if (typeof value === 'string' && value.trim().length > 0) {
    //audit assumption: model override allowed; risk: unsupported model; invariant: non-empty string; strategy: trim and use.
    return value.trim();
  }
  //audit assumption: default model used; risk: config missing; invariant: fallback provided; strategy: return configured default.
  return configuredModel;
}

function sanitizeFilename(value: string | undefined): string {
  if (!value) {
    //audit assumption: filename optional; risk: missing filename; invariant: fallback used; strategy: default filename.
    return DEFAULT_FILENAME;
  }
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    //audit assumption: empty filename invalid; risk: blank filename; invariant: default used; strategy: fallback.
    return DEFAULT_FILENAME;
  }
  //audit assumption: basename prevents path traversal; risk: path injection; invariant: basename; strategy: path.basename.
  return path.basename(trimmedValue);
}

function parseTranscribePayload(body: unknown): ParseResult<TranscribePayload> {
  if (!isPlainObject(body)) {
    //audit assumption: request body is JSON object; risk: invalid payload; invariant: object; strategy: return error.
    return { ok: false, error: 'request body must be an object' };
  }

  const audioBase64 = body.audioBase64;
  if (typeof audioBase64 !== 'string') {
    //audit assumption: audioBase64 required; risk: missing audio; invariant: string; strategy: return error.
    return { ok: false, error: 'audioBase64 is required' };
  }

  const trimmedAudio = audioBase64.trim();
  if (!trimmedAudio) {
    //audit assumption: audioBase64 should be non-empty; risk: invalid payload; invariant: non-empty; strategy: return error.
    return { ok: false, error: 'audioBase64 must be non-empty' };
  }

  if (trimmedAudio.length > MAX_AUDIO_BASE64_LENGTH) {
    //audit assumption: payload length limited; risk: oversized payload; invariant: size cap; strategy: return error.
    return { ok: false, error: 'audioBase64 exceeds maximum length' };
  }

  const model = parseModel(body.model);
  const filename = sanitizeFilename(typeof body.filename === 'string' ? body.filename : undefined);
  const language = typeof body.language === 'string' && body.language.trim().length > 0
    ? body.language.trim()
    : undefined;

  return {
    ok: true,
    value: {
      audioBase64: trimmedAudio,
      model,
      filename,
      language
    }
  };
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId || 'anonymous';
    const payloadResult = parseTranscribePayload(req.body);

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

    const audioBuffer = Buffer.from(payloadResult.value.audioBase64, 'base64');
    if (audioBuffer.length === 0) {
      //audit assumption: base64 decodes to bytes; risk: invalid base64; invariant: non-empty buffer; strategy: return 400.
      return res.status(400).json({
        error: 'Bad Request',
        message: 'audioBase64 is not valid base64'
      });
    }

    const file = await toFile(audioBuffer, payloadResult.value.filename);
    const transcription = await openai.audio.transcriptions.create({
      model: payloadResult.value.model,
      file,
      language: payloadResult.value.language
    });

    const text = typeof transcription === 'string' ? transcription : transcription.text;

    await logAuditEvent(
      userId,
      'transcription',
      {
        model: payloadResult.value.model,
        audioBytes: audioBuffer.length,
        textLength: text.length
      },
      req.ip,
      req.get('user-agent')
    );

    return res.json({
      success: true,
      text,
      model: payloadResult.value.model
    });
  } catch (error) {
    //audit assumption: unexpected errors handled; risk: crash; invariant: 500 returned; strategy: log and return error.
    logger.error('Failed to process transcription request', { error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process transcription request'
    });
  }
});

export default router;

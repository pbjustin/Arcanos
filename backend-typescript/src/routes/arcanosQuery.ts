/**
 * Arcanos Query Route
 * Validates payloads and returns a normalized response envelope
 */

import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import path from 'path';
import { logger } from '../logger';

const router = Router();
const fallbackPath = path.resolve(process.cwd(), 'relay', 'fallback.js');
const { buildFallbackResponse } = require(fallbackPath) as {
  buildFallbackResponse: (reason: string, detail?: string) => Record<string, unknown>;
};

const MAX_QUERY_LENGTH = 12000;
const MAX_TAGS = 10;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

router.post('/', async (req: Request, res: Response) => {
  const body = req.body;
  if (!isPlainObject(body)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Payload must be a JSON object'
    });
  }

  const { query, tags, meta, dryRun } = body as {
    query?: unknown;
    tags?: unknown;
    meta?: unknown;
    dryRun?: unknown;
  };

  if (typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'query is required'
    });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'query exceeds maximum length'
    });
  }

  if (tags !== undefined && !Array.isArray(tags)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'tags must be an array of strings'
    });
  }

  if (meta !== undefined && !isPlainObject(meta)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'meta must be an object'
    });
  }

  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'dryRun must be a boolean'
    });
  }

  try {
    const safeTags = Array.isArray(tags)
      ? tags.filter((tag) => typeof tag === 'string').slice(0, MAX_TAGS)
      : [];

    return res.json({
      success: true,
      requestId: randomUUID(),
      query: query.trim(),
      tags: safeTags,
      meta: meta || null,
      dryRun: Boolean(dryRun),
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    const message = (error as Error).message;
    logger.error('Arcanos query failed', { error: message });
    const fallback = buildFallbackResponse('arcanos_query_failed', message);
    return res.status(500).json(fallback);
  }
});

export default router;

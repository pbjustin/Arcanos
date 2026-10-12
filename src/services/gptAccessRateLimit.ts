import type { RequestHandler } from 'express';

import {
  createRateLimitMiddleware,
  getRequestClientAddress,
} from '@platform/runtime/security.js';

export const GPT_ACCESS_RATE_LIMIT_MAX_REQUESTS = 120;
export const GPT_ACCESS_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

export interface GptAccessRateLimitOptions {
  maxRequests?: number;
  windowMs?: number;
}

export function createGptAccessRateLimit(
  options: GptAccessRateLimitOptions = {}
): RequestHandler {
  return createRateLimitMiddleware({
    bucketName: 'gpt-access',
    maxRequests: options.maxRequests ?? GPT_ACCESS_RATE_LIMIT_MAX_REQUESTS,
    windowMs: options.windowMs ?? GPT_ACCESS_RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => (
      `ip:${getRequestClientAddress(req)}:gpt-access`
    ),
  });
}

/**
 * Shared gateway budget. The early Gaming boundary and the downstream router
 * deliberately reuse this instance so a request is counted once without
 * splitting the existing GPT-access client budget.
 */
export const gptAccessRateLimit = createGptAccessRateLimit();

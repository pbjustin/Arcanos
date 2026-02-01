/**
 * costControlMiddleware.ts
 *
 * Request-level cost control for OpenAI usage with caching, batching, throttling, and audit logs.
 */

import { Request, Response, NextFunction } from 'express';
import { auditLogger } from '../utils/auditLogger.js';
import { DEFAULT_CONFIG, createDefaultOpenAIClient } from './costControl/defaults.js';
import { defaultIdleStateProvider } from './costControl/idle.js';
import { responseCache, requestTimestamps, scheduleBatch, trimRequestTimestamps } from './costControl/batching.js';
import { createResponseGuard, resolvePayload, resolvePrompt } from './costControl/requests.js';
import type { CostControlConfig, CostControlDependencies, IdleState } from './costControl/types.js';

function getCurrentRateLimit(state: IdleState, defaultRate: number): number {
  //audit Assumption: idle/critical should be throttled; risk: over-throttling; invariant: rate >= 1; handling: clamp to minimum 1.
  if (state === 'idle') return Math.max(1, Math.floor(defaultRate / 2));
  if (state === 'critical') return 1;
  return defaultRate;
}


/**
 * Create middleware for OpenAI cost control with caching, batching, throttling, and audit logging.
 * Inputs: optional dependency overrides and configuration options.
 * Outputs: Express middleware function.
 * Edge cases: missing prompt payloads bypass processing and call next().
 */
export function createCostControlMiddleware(
  dependencies: CostControlDependencies = {},
  configOverrides: Partial<CostControlConfig> = {}
) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const openaiClient = dependencies.openaiClient ?? createDefaultOpenAIClient(config);
  const idleStateProvider = dependencies.idleStateProvider ?? defaultIdleStateProvider;
  const audit = dependencies.audit ?? auditLogger;
  const now = dependencies.now ?? Date.now;

  return async function costControlMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const responseGuard = createResponseGuard(res);
    const prompt = resolvePrompt(req);
    //audit Assumption: requests without prompt should pass through; risk: missed control; invariant: only prompt traffic uses middleware; handling: delegate to next.
    if (!prompt) {
      return next();
    }

    const idleState = idleStateProvider.getState();
    const currentRate = getCurrentRateLimit(idleState.state, config.rateLimitPerMinute);
    const currentTimestamp = now();
    audit.log({
      event: 'openai_request_received',
      prompt,
      idle_state: idleState.state,
      timestamp: new Date(currentTimestamp).toISOString()
    });
    //audit Assumption: tracking traffic aids idle heuristics; risk: extra overhead; invariant: only called for prompt requests; handling: call noteTraffic if available.
    idleStateProvider.noteTraffic?.({ route: req.path, promptLength: prompt.length });

    trimRequestTimestamps(currentTimestamp, 60_000);
    //audit Assumption: rate limiting per minute protects cost; risk: false positives; invariant: deny when over limit; handling: compare to current rate.
    if (requestTimestamps.length >= currentRate) {
      audit.log({
        event: 'rate_limited',
        prompt,
        rateLimit: currentRate,
        timestamp: new Date(currentTimestamp).toISOString()
      });
      responseGuard.sendJson(429, { error: 'Rate limit exceeded', retryAfterSeconds: 60 });
      return;
    }
    requestTimestamps.push(currentTimestamp);

    const cacheKey = prompt;
    const cached = responseCache.get(cacheKey);
    //audit Assumption: cache entries expire by TTL; risk: stale data; invariant: cache age within TTL; handling: validate timestamp.
    if (cached && currentTimestamp - cached.timestamp < config.cacheTtlMs) {
      audit.log({
        event: 'cache_hit',
        prompt,
        timestamp: new Date(currentTimestamp).toISOString()
      });
      responseGuard.sendOk(cached.response);
      return;
    }

    if (req.path === config.batchEndpointPath) {
      //audit Assumption: batching only for specific endpoint; risk: accidental batch on wrong path; invariant: path match required; handling: check path.
      const payload = resolvePayload(req, prompt);
      await new Promise<void>((resolve, reject) => {
        scheduleBatch(
          {
            prompt,
            payload,
            respond: (result) => {
              responseGuard.sendOk(result);
              resolve();
            },
            reject: (error) => {
              reject(error);
            }
          },
          openaiClient,
          audit,
          now,
          config
        );
      }).catch((error) => {
        audit.log({
          event: 'batch_item_error',
          prompt,
          details: (error as Error).message,
          timestamp: new Date(now()).toISOString()
        });
        responseGuard.sendJson(500, { error: 'Batch processing failed' });
      });
      return;
    }

    const payload = resolvePayload(req, prompt);
    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      //audit Assumption: timeout protects long-running OpenAI calls; risk: duplicate responses; invariant: timeout triggers once; handling: response guard prevents double send.
      audit.log({
        event: 'openai_timeout',
        prompt,
        timestamp: new Date(now()).toISOString()
      });
      responseGuard.sendJson(504, { error: 'OpenAI timeout - fallback triggered' });
    }, config.requestTimeoutMs);

    try {
      const result = await openaiClient.call(payload);
      //audit Assumption: timeout handle may be cleared only once; risk: clearing null; invariant: clear when present; handling: guard with if.
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = null;

      responseCache.set(cacheKey, {
        prompt,
        response: result,
        timestamp: now()
      });
      //audit Assumption: cache update is safe after success; risk: partial state; invariant: cache reflects response; handling: set after success.
      audit.log({
        event: 'openai_request',
        prompt,
        idle_state: idleState.state,
        timestamp: new Date(now()).toISOString()
      });
      responseGuard.sendOk(result);
    } catch (error) {
      //audit Assumption: errors should be forwarded to error handler; risk: silent failures; invariant: errors logged and forwarded; handling: log + next.
      audit.log({
        event: 'middleware_error',
        details: (error as Error).message,
        timestamp: new Date(now()).toISOString()
      });
      //audit Assumption: timeout handle should be cleared on error; risk: leaving timer running; invariant: no pending timeout post-error; handling: guard with if.
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = null;
      next(error);
    }
  };
}

/**
 * Default middleware instance using built-in dependencies.
 * Inputs: Express request/response lifecycle.
 * Outputs: JSON response or error propagation.
 * Edge cases: defers to next() when prompt is missing.
 */
export const costControlMiddleware = createCostControlMiddleware();

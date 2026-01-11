/**
 * costControlMiddleware.ts
 *
 * Request-level cost control for OpenAI usage with caching, batching, throttling, and audit logs.
 */

import { Request, Response, NextFunction } from 'express';
import { callOpenAI } from '../services/openai.js';
import { getDefaultModel } from '../services/openai/credentialProvider.js';
import { auditLogger, AuditLogger } from '../utils/auditLogger.js';
import { createIdleManager, IdleManager } from '../utils/idleManager.js';

type IdleState = 'active' | 'idle' | 'critical';

interface CacheEntry {
  prompt: string;
  response: unknown;
  timestamp: number;
}

interface CostControlConfig {
  cacheTtlMs: number;
  batchWindowMs: number;
  rateLimitPerMinute: number;
  requestTimeoutMs: number;
  batchEndpointPath: string;
  defaultTokenLimit: number;
}

interface IdleStateSnapshot {
  state: IdleState;
}

interface IdleStateProvider {
  getState: () => IdleStateSnapshot;
  noteTraffic?: (meta?: Record<string, unknown>) => void;
}

interface OpenAIRequestPayload {
  prompt: string;
  model?: string;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

interface OpenAIClient {
  call: (payload: OpenAIRequestPayload) => Promise<unknown>;
  batch: (payloads: OpenAIRequestPayload[]) => Promise<unknown[]>;
}

interface CostControlDependencies {
  openaiClient?: OpenAIClient;
  idleStateProvider?: IdleStateProvider;
  audit?: AuditLogger;
  now?: () => number;
}

interface BatchQueueItem {
  prompt: string;
  payload: OpenAIRequestPayload;
  respond: (result: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_CONFIG: CostControlConfig = {
  cacheTtlMs: 60_000,
  batchWindowMs: 500,
  rateLimitPerMinute: 5,
  requestTimeoutMs: 8_000,
  batchEndpointPath: '/openai-endpoint',
  defaultTokenLimit: 1024
};

const responseCache = new Map<string, CacheEntry>();
const requestTimestamps: number[] = [];
const batchQueue: BatchQueueItem[] = [];
let batchTimer: NodeJS.Timeout | null = null;

const defaultIdleManager: IdleManager = createIdleManager(auditLogger);

const defaultIdleStateProvider: IdleStateProvider = {
  getState: () => {
    const idle = defaultIdleManager.isIdle();
    //audit Assumption: idle manager's boolean can map to idle/active; risk: misclassification; invariant: idle true => idle state; handling: map directly.
    return { state: idle ? 'idle' : 'active' };
  },
  noteTraffic: (meta?: Record<string, unknown>) => {
    //audit Assumption: traffic note is safe to record; risk: missing activity; invariant: noteTraffic updates idle heuristics; handling: forward to idle manager.
    defaultIdleManager.noteTraffic(meta);
  }
};

function createDefaultOpenAIClient(config: CostControlConfig): OpenAIClient {
  const call = async (payload: OpenAIRequestPayload) => {
    const model = payload.model ?? getDefaultModel();
    const tokenLimit = payload.maxTokens ?? config.defaultTokenLimit;
    //audit Assumption: model/tokenLimit are valid inputs; risk: invalid configuration; invariant: callOpenAI returns a result or throws; handling: propagate errors.
    return callOpenAI(model, payload.prompt, tokenLimit, true, {
      metadata: payload.metadata
    });
  };
  const batch = async (payloads: OpenAIRequestPayload[]) => {
    //audit Assumption: batch size can be handled sequentially; risk: latency increases; invariant: each payload yields a result; handling: Promise.all to aggregate.
    return Promise.all(payloads.map((payload) => call(payload)));
  };
  return { call, batch };
}

function getCurrentRateLimit(state: IdleState, defaultRate: number): number {
  //audit Assumption: idle/critical should be throttled; risk: over-throttling; invariant: rate >= 1; handling: clamp to minimum 1.
  if (state === 'idle') return Math.max(1, Math.floor(defaultRate / 2));
  if (state === 'critical') return 1;
  return defaultRate;
}

function trimRequestTimestamps(now: number, windowMs: number): void {
  //audit Assumption: timestamps are sorted by insertion; risk: stale timestamps accumulate; invariant: array holds recent entries; handling: shift until within window.
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > windowMs) {
    requestTimestamps.shift();
  }
}

function resolvePrompt(req: Request): string | null {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  //audit Assumption: prompt is required for OpenAI calls; risk: empty prompt; invariant: non-empty prompt for downstream; handling: return null when invalid.
  return prompt.length > 0 ? prompt : null;
}

function resolvePayload(req: Request, prompt: string): OpenAIRequestPayload {
  const payload: OpenAIRequestPayload = {
    prompt,
    model: typeof req.body?.model === 'string' ? req.body.model : undefined,
    maxTokens: typeof req.body?.maxTokens === 'number' ? req.body.maxTokens : undefined,
    metadata: { route: req.path }
  };
  //audit Assumption: request body fields are safe to map; risk: incorrect types; invariant: payload fields are optional; handling: guard types.
  return payload;
}

function createResponseGuard(res: Response) {
  let responded = false;
  return {
    sendJson: (status: number, payload: unknown) => {
      //audit Assumption: response can be sent once; risk: double send; invariant: response is sent at most once; handling: guard with flag and headersSent.
      if (responded || res.headersSent) return;
      responded = true;
      res.status(status).json(payload);
    },
    sendOk: (payload: unknown) => {
      //audit Assumption: success responses are JSON; risk: incorrect format; invariant: JSON response for API; handling: delegate to sendJson.
      if (responded || res.headersSent) return;
      responded = true;
      res.json(payload);
    }
  };
}

async function flushBatch(
  openaiClient: OpenAIClient,
  audit: AuditLogger,
  now: () => number,
  config: CostControlConfig
): Promise<void> {
  //audit Assumption: empty batches require no work; risk: unnecessary processing; invariant: queue length zero means no items; handling: early return.
  if (batchQueue.length === 0) return;
  const items = batchQueue.splice(0, batchQueue.length);
  const payloads = items.map((item) => item.payload);
  //audit Assumption: batch flush processes all queued items; risk: partial flush; invariant: queue drained before execution; handling: copy then clear.
  audit.log({
    event: 'batch_flush',
    batchSize: items.length,
    timestamp: new Date(now()).toISOString()
  });

  try {
    const results = await openaiClient.batch(payloads);
    results.forEach((result, index) => {
      const item = items[index];
      responseCache.set(item.prompt, {
        prompt: item.prompt,
        response: result,
        timestamp: now()
      });
      //audit Assumption: batch response aligns with payload order; risk: mismatch; invariant: index maps to payloads; handling: use shared ordering.
      audit.log({
        event: 'batch_response',
        prompt: item.prompt,
        timestamp: new Date(now()).toISOString()
      });
      item.respond(result);
    });
  } catch (error) {
    //audit Assumption: batch failure should reject all queued items; risk: unhandled promises; invariant: each queued response receives error; handling: reject all.
    items.forEach((item) => item.reject(error as Error));
    audit.log({
      event: 'batch_error',
      details: (error as Error).message,
      timestamp: new Date(now()).toISOString()
    });
  }

  batchTimer = null;
  if (batchQueue.length > 0) {
    //audit Assumption: new items may arrive during flush; risk: dropped batches; invariant: queued items should still be processed; handling: reschedule timer.
    batchTimer = setTimeout(() => {
      void flushBatch(openaiClient, audit, now, config);
    }, config.batchWindowMs);
  }
}

function scheduleBatch(
  item: BatchQueueItem,
  openaiClient: OpenAIClient,
  audit: AuditLogger,
  now: () => number,
  config: CostControlConfig
): void {
  batchQueue.push(item);
  //audit Assumption: batch timer should exist per window; risk: starvation; invariant: batch flush scheduled; handling: start timer when null.
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      void flushBatch(openaiClient, audit, now, config);
    }, config.batchWindowMs);
  }
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

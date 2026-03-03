/**
 * idleManager.ts
 *
 * Memory-aware idle detection + dynamic timeout + OpenAI memoization.
 */

import type OpenAI from 'openai';

import { getEnvNumber } from '@platform/runtime/env.js';
import { createCacheKey } from '@shared/hashUtils.js';
import { normalizeResponsesCreateParams } from '@core/adapters/openai.adapter.js';

const DEFAULTS = {
  IDLE_MEMORY_THRESHOLD_MB: getEnvNumber('IDLE_MEMORY_THRESHOLD_MB', 150),
  MEMORY_GROWTH_WINDOW_MS: getEnvNumber('MEMORY_GROWTH_WINDOW_MS', 60000),
  INITIAL_IDLE_TIMEOUT_MS: getEnvNumber('INITIAL_IDLE_TIMEOUT_MS', 30000),
  MIN_IDLE_TIMEOUT_MS: getEnvNumber('MIN_IDLE_TIMEOUT_MS', 10000),
  MAX_IDLE_TIMEOUT_MS: getEnvNumber('MAX_IDLE_TIMEOUT_MS', 120000),
  EWMA_DECAY: getEnvNumber('EWMA_DECAY', 0.85),
  CACHE_TTL_MS: getEnvNumber('OPENAI_CACHE_TTL_MS', 60000),
  BATCH_WINDOW_MS: getEnvNumber('OPENAI_BATCH_WINDOW_MS', 150)
};

type ResponsesCreateParams = Parameters<OpenAI['responses']['create']>[0];
type ResponsesCreateResult = Awaited<ReturnType<OpenAI['responses']['create']>>;

interface Logger {
  log?: (message: string, metadata?: Record<string, unknown>) => void;
}

interface CacheEntry {
  timestamp: number;
  data: ResponsesCreateResult;
}

interface QueuedRequest {
  key: string;
  payload: ResponsesCreateParams;
  resolve: (data: ResponsesCreateResult) => void;
  reject: (err: Error) => void;
}

interface IdleStats {
  idleTimeoutMs: number;
  trafficRate: number;
  memoryIsGrowing: boolean;
}

interface OpenAIWrapper {
  responses: {
    create: (payload: ResponsesCreateParams) => Promise<ResponsesCreateResult>;
  };
  destroy: () => void;
}

export interface IdleManager {
  noteTraffic: (meta?: Record<string, unknown>) => void;
  isIdle: () => boolean;
  wrapOpenAI: (openai: OpenAI) => OpenAIWrapper;
  getStats: () => IdleStats;
  destroy: () => void;
}

/**
 * Create an idle manager with optional audit logging.
 */
export function createIdleManager(auditLogger: Logger = console as Logger): IdleManager {
  let lastMemory = process.memoryUsage().heapUsed;
  let lastMemoryCheck = Date.now();
  let memoryIsGrowing = false;

  let trafficRate = 0;
  let lastRequestTime = Date.now();
  let idleTimeoutMs = DEFAULTS.INITIAL_IDLE_TIMEOUT_MS;

  const responseCache = new Map<string, CacheEntry>();
  const requestQueue: QueuedRequest[] = [];
  let batchInterval: NodeJS.Timeout | null = null;

  function noteTraffic(meta: Record<string, unknown> = {}): void {
    const now = Date.now();
    const dt = (now - lastRequestTime) / 1000;
    lastRequestTime = now;

    const instantRate = dt > 0 ? 1 / dt : 0;
    trafficRate = DEFAULTS.EWMA_DECAY * trafficRate + (1 - DEFAULTS.EWMA_DECAY) * instantRate;

    if (trafficRate > 0.5) {
      idleTimeoutMs = Math.min(DEFAULTS.MAX_IDLE_TIMEOUT_MS, idleTimeoutMs * 1.5);
    } else if (trafficRate < 0.05) {
      idleTimeoutMs = Math.max(DEFAULTS.MIN_IDLE_TIMEOUT_MS, idleTimeoutMs * 0.8);
    }

    auditLogger.log?.('[AUDIT] Traffic noted', {
      meta,
      idleTimeoutMs,
      trafficRate: trafficRate.toFixed(3)
    });
  }

  function isIdle(): boolean {
    const mem = process.memoryUsage();
    const now = Date.now();

    if (now - lastMemoryCheck > DEFAULTS.MEMORY_GROWTH_WINDOW_MS) {
      memoryIsGrowing = mem.heapUsed > lastMemory * 1.1;
      lastMemory = mem.heapUsed;
      lastMemoryCheck = now;
    }

    const overThreshold = mem.rss / 1024 / 1024 > DEFAULTS.IDLE_MEMORY_THRESHOLD_MB;
    const idle = !memoryIsGrowing && !overThreshold && now - lastRequestTime > idleTimeoutMs;

    auditLogger.log?.('[AUDIT] Idle check', {
      idle,
      memoryIsGrowing,
      overThreshold,
      idleTimeoutMs
    });

    return idle;
  }

  function wrapOpenAI(openai: OpenAI): OpenAIWrapper {
    async function batchedResponse(payload: ResponsesCreateParams): Promise<ResponsesCreateResult> {
      const modelKey = typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : 'unknown-model';
      const key = createCacheKey(modelKey, payload.input);
      const now = Date.now();

      const cached = responseCache.get(key);
      if (cached && now - cached.timestamp < DEFAULTS.CACHE_TTL_MS) {
        auditLogger.log?.('[AUDIT] OpenAI cache hit', { key });
        return cached.data;
      }

      return new Promise((resolve, reject) => {
        requestQueue.push({ key, payload, resolve, reject });
      });
    }

    if (batchInterval === null) {
      batchInterval = setInterval(async () => {
        if (requestQueue.length === 0) {
          return;
        }

        const grouped = new Map<string, QueuedRequest[]>();
        const itemsToBatch = requestQueue.splice(0, requestQueue.length);

        for (const request of itemsToBatch) {
          if (!grouped.has(request.key)) {
            grouped.set(request.key, []);
          }
          grouped.get(request.key)!.push(request);
        }

        for (const [key, group] of grouped.entries()) {
          try {
            const payload = group[0].payload;
            const data = await openai.responses.create(normalizeResponsesCreateParams({
              ...payload,
              stream: false
            }));

            responseCache.set(key, { timestamp: Date.now(), data });
            for (const request of group) {
              request.resolve(data);
            }

            auditLogger.log?.('[AUDIT] Batched OpenAI call', {
              key,
              batchSize: group.length
            });
          } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            for (const request of group) {
              request.reject(error);
            }
          }
        }
      }, DEFAULTS.BATCH_WINDOW_MS);
    }

    return {
      responses: {
        create: batchedResponse
      },
      destroy: () => {
        // Wrapper-level destroy is intentionally a no-op.
      }
    };
  }

  function destroy(): void {
    if (batchInterval !== null) {
      clearInterval(batchInterval);
      batchInterval = null;
    }
    responseCache.clear();
    requestQueue.length = 0;
  }

  return {
    noteTraffic,
    isIdle,
    wrapOpenAI,
    getStats(): IdleStats {
      return { idleTimeoutMs, trafficRate, memoryIsGrowing };
    },
    destroy
  };
}


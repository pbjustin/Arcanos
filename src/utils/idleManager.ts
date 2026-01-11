/**
 * idleManager.ts
 *
 * Memory-aware idle detection + dynamic timeout + OpenAI memoization
 * Fully Railway-ready, audit-logged, and OpenAI SDK compatible.
 */

import { createCacheKey } from './hashUtils.js';

// Configuration with environment variable overrides
const DEFAULTS = {
  IDLE_MEMORY_THRESHOLD_MB: parseInt(process.env.IDLE_MEMORY_THRESHOLD_MB || '150', 10),
  MEMORY_GROWTH_WINDOW_MS: parseInt(process.env.MEMORY_GROWTH_WINDOW_MS || '60000', 10),
  INITIAL_IDLE_TIMEOUT_MS: parseInt(process.env.INITIAL_IDLE_TIMEOUT_MS || '30000', 10),
  MIN_IDLE_TIMEOUT_MS: parseInt(process.env.MIN_IDLE_TIMEOUT_MS || '10000', 10),
  MAX_IDLE_TIMEOUT_MS: parseInt(process.env.MAX_IDLE_TIMEOUT_MS || '120000', 10),
  EWMA_DECAY: parseFloat(process.env.EWMA_DECAY || '0.85'),
  CACHE_TTL_MS: parseInt(process.env.OPENAI_CACHE_TTL_MS || '60000', 10),
  BATCH_WINDOW_MS: parseInt(process.env.OPENAI_BATCH_WINDOW_MS || '150', 10),
};

interface Logger {
  log?: (message: string, metadata?: any) => void;
}

interface CacheEntry {
  timestamp: number;
  data: any;
}

interface QueuedRequest {
  key: string;
  payload: any;
  resolve: (data: any) => void;
  reject: (err: any) => void;
}

interface IdleStats {
  idleTimeoutMs: number;
  trafficRate: number;
  memoryIsGrowing: boolean;
}

interface OpenAIWrapper {
  chat: {
    completions: {
      create: (payload: any) => Promise<any>;
    };
  };
  destroy: () => void;
}

export interface IdleManager {
  noteTraffic: (meta?: any) => void;
  isIdle: () => boolean;
  wrapOpenAI: (openai: any) => OpenAIWrapper;
  getStats: () => IdleStats;
  destroy: () => void;
}

export function createIdleManager(auditLogger: Logger = console as Logger): IdleManager {
  // --- Internal state ---
  let lastMemory = process.memoryUsage().heapUsed;
  let lastMemoryCheck = Date.now();
  let memoryIsGrowing = false;

  let trafficRate = 0; // EWMA: requests per sec
  let lastRequestTime = Date.now();

  let idleTimeoutMs = DEFAULTS.INITIAL_IDLE_TIMEOUT_MS;

  const responseCache = new Map<string, CacheEntry>();
  const requestQueue: QueuedRequest[] = [];
  let batchInterval: NodeJS.Timeout | null = null;

  // --- Traffic tracking ---
  function noteTraffic(meta: any = {}) {
    const now = Date.now();
    const dt = (now - lastRequestTime) / 1000;
    lastRequestTime = now;

    const instantRate = dt > 0 ? 1 / dt : 0;
    trafficRate = DEFAULTS.EWMA_DECAY * trafficRate + (1 - DEFAULTS.EWMA_DECAY) * instantRate;

    // Adjust idle timeout based on live traffic
    if (trafficRate > 0.5)
      idleTimeoutMs = Math.min(DEFAULTS.MAX_IDLE_TIMEOUT_MS, idleTimeoutMs * 1.5);
    else if (trafficRate < 0.05)
      idleTimeoutMs = Math.max(DEFAULTS.MIN_IDLE_TIMEOUT_MS, idleTimeoutMs * 0.8);

    auditLogger.log?.("[AUDIT] Traffic noted", {
      meta,
      idleTimeoutMs,
      trafficRate: trafficRate.toFixed(3),
    });
  }

  // --- Idle detection ---
  function isIdle(): boolean {
    const mem = process.memoryUsage();
    const now = Date.now();

    if (now - lastMemoryCheck > DEFAULTS.MEMORY_GROWTH_WINDOW_MS) {
      memoryIsGrowing = mem.heapUsed > lastMemory * 1.1;
      lastMemory = mem.heapUsed;
      lastMemoryCheck = now;
    }

    const overThreshold = mem.rss / 1024 / 1024 > DEFAULTS.IDLE_MEMORY_THRESHOLD_MB;

    const idle =
      !memoryIsGrowing && !overThreshold && now - lastRequestTime > idleTimeoutMs;

    auditLogger.log?.("[AUDIT] Idle check", {
      idle,
      memoryIsGrowing,
      overThreshold,
      idleTimeoutMs,
    });

    return idle;
  }

  // --- OpenAI wrapper (memoization + batching) ---
  function wrapOpenAI(openai: any): OpenAIWrapper {
    async function batchedChat(payload: any): Promise<any> {
      // Use hash-based cache key for better performance and consistency
      const key = createCacheKey(payload.model, payload.messages);
      const now = Date.now();

      // Serve from cache
      if (responseCache.has(key)) {
        const { timestamp, data } = responseCache.get(key)!;
        if (now - timestamp < DEFAULTS.CACHE_TTL_MS) {
          auditLogger.log?.("[AUDIT] OpenAI cache hit", { key });
          return data;
        }
      }

      // Create batched request
      return new Promise((resolve, reject) => {
        requestQueue.push({ key, payload, resolve, reject });
      });
    }

    // Batch executor - process queue at regular intervals
    if (batchInterval === null) {
      batchInterval = setInterval(async () => {
        if (requestQueue.length === 0) return;

        const grouped = new Map<string, QueuedRequest[]>();
        // Drain the queue
        const itemsToBatch = requestQueue.splice(0, requestQueue.length);
        
        for (const r of itemsToBatch) {
          if (!grouped.has(r.key)) grouped.set(r.key, []);
          grouped.get(r.key)!.push(r);
        }

        for (const [key, group] of grouped.entries()) {
          try {
            const payload = group[0].payload;
            const data = await openai.chat.completions.create(payload);
            responseCache.set(key, { timestamp: Date.now(), data });

            for (const r of group) r.resolve(data);

            auditLogger.log?.("[AUDIT] Batched OpenAI call", {
              key,
              batchSize: group.length,
            });
          } catch (err) {
            for (const r of group) r.reject(err);
          }
        }
      }, DEFAULTS.BATCH_WINDOW_MS);
    }

    return {
      chat: {
        completions: {
          create: batchedChat
        }
      },
      destroy: () => {
        if (batchInterval !== null) {
          clearInterval(batchInterval);
          batchInterval = null;
        }
      }
    };
  }

  // --- Cleanup function ---
  function destroy() {
    if (batchInterval !== null) {
      clearInterval(batchInterval);
      batchInterval = null;
    }
    responseCache.clear();
    requestQueue.length = 0;
  }

  // --- Public API ---
  return {
    noteTraffic,
    isIdle,
    wrapOpenAI,
    getStats(): IdleStats {
      return { idleTimeoutMs, trafficRate, memoryIsGrowing };
    },
    destroy,
  };
}

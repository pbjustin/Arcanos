/**
 * idleManager.ts
 *
 * Memory-aware idle detection + dynamic timeout + OpenAI memoization
 * Fully Railway-ready, audit-logged, and OpenAI SDK compatible.
 * 
 * ## Features
 * - **Memory-aware idle detection**: Monitors heap and RSS to prevent shutdown under load
 * - **Dynamic timeout adjustment**: Uses EWMA to adapt idle timeout based on traffic patterns
 * - **OpenAI memoization**: Caches responses and batches identical requests
 * - **Resource management**: Proper cleanup to prevent memory leaks
 * 
 * ## Configuration (via environment variables)
 * - `IDLE_MEMORY_THRESHOLD_MB` (default: 150): RSS threshold for staying awake
 * - `MEMORY_GROWTH_WINDOW_MS` (default: 60000): Memory growth check interval
 * - `INITIAL_IDLE_TIMEOUT_MS` (default: 30000): Starting idle timeout
 * - `MIN_IDLE_TIMEOUT_MS` (default: 10000): Minimum idle timeout
 * - `MAX_IDLE_TIMEOUT_MS` (default: 120000): Maximum idle timeout
 * - `EWMA_DECAY` (default: 0.85): Traffic rate smoothing factor
 * - `OPENAI_CACHE_TTL_MS` (default: 60000): Response cache lifetime
 * - `OPENAI_BATCH_WINDOW_MS` (default: 150): Batch processing interval
 * 
 * ## Usage Example
 * ```typescript
 * import { createIdleManager } from './utils/idleManager.js';
 * import { aiLogger } from './utils/structuredLogging.js';
 * 
 * const manager = createIdleManager(aiLogger);
 * 
 * // Track traffic
 * manager.noteTraffic({ endpoint: '/api/chat' });
 * 
 * // Check if idle
 * if (manager.isIdle()) {
 *   console.log('System is idle, can shut down');
 * }
 * 
 * // Wrap OpenAI client for batching and caching
 * const wrappedClient = manager.wrapOpenAI(openaiClient);
 * const response = await wrappedClient.chat.completions.create({ ... });
 * 
 * // Clean up when done
 * manager.destroy();
 * ```
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

import type OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletion } from '../services/openai/types.js';

interface Logger {
  log?: (message: string, metadata?: Record<string, unknown>) => void;
}

interface CacheEntry {
  timestamp: number;
  data: ChatCompletion;
}

interface QueuedRequest {
  key: string;
  payload: ChatCompletionCreateParams;
  resolve: (data: ChatCompletion) => void;
  reject: (err: Error) => void;
}

interface IdleStats {
  idleTimeoutMs: number;
  trafficRate: number;
  memoryIsGrowing: boolean;
}

interface OpenAIWrapper {
  chat: {
    completions: {
      create: (payload: ChatCompletionCreateParams) => Promise<ChatCompletion>;
    };
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
  /**
   * Track traffic patterns for idle management
   * @confidence 1.0 - Type-safe metadata tracking
   */
  function noteTraffic(meta: Record<string, unknown> = {}): void {
    const now = Date.now();
    const dt = (now - lastRequestTime) / 1000;
    lastRequestTime = now;

    const instantRate = dt > 0 ? 1 / dt : 0;
    trafficRate = DEFAULTS.EWMA_DECAY * trafficRate + (1 - DEFAULTS.EWMA_DECAY) * instantRate;

    // Adjust idle timeout based on live traffic
    //audit Assumption: high traffic should increase idle timeout
    if (trafficRate > 0.5)
      idleTimeoutMs = Math.min(DEFAULTS.MAX_IDLE_TIMEOUT_MS, idleTimeoutMs * 1.5);
    //audit Assumption: low traffic should decrease idle timeout
    else if (trafficRate < 0.05)
      idleTimeoutMs = Math.max(DEFAULTS.MIN_IDLE_TIMEOUT_MS, idleTimeoutMs * 0.8);

    //audit Assumption: traffic logs are helpful for idle decisions
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

    //audit Assumption: memory growth check runs on fixed interval
    if (now - lastMemoryCheck > DEFAULTS.MEMORY_GROWTH_WINDOW_MS) {
      memoryIsGrowing = mem.heapUsed > lastMemory * 1.1;
      lastMemory = mem.heapUsed;
      lastMemoryCheck = now;
    }

    //audit Assumption: RSS threshold indicates memory pressure
    const overThreshold = mem.rss / 1024 / 1024 > DEFAULTS.IDLE_MEMORY_THRESHOLD_MB;

    const idle =
      !memoryIsGrowing && !overThreshold && now - lastRequestTime > idleTimeoutMs;

    //audit Assumption: idle decision should be auditable
    auditLogger.log?.("[AUDIT] Idle check", {
      idle,
      memoryIsGrowing,
      overThreshold,
      idleTimeoutMs,
    });

    return idle;
  }

  // --- OpenAI wrapper (memoization + batching) ---
  // Note: All wrapper instances share the same batch queue and cache.
  // This enables request deduplication across multiple wrapper instances.
  function wrapOpenAI(openai: OpenAI): OpenAIWrapper {
    async function batchedChat(payload: ChatCompletionCreateParams): Promise<ChatCompletion> {
      // Use hash-based cache key for better performance and consistency
      const key = createCacheKey(payload.model, payload.messages);
      const now = Date.now();

      // Serve from cache
      const cached = responseCache.get(key);
      //audit Assumption: cached entries are valid within TTL
      if (cached) {
        const { timestamp, data } = cached;
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

    // Batch executor - start only once for all wrappers
    // This ensures all requests are batched together efficiently
    if (batchInterval === null) {
      batchInterval = setInterval(async () => {
        //audit Assumption: empty queue should skip processing
        if (requestQueue.length === 0) return;

        const grouped = new Map<string, QueuedRequest[]>();
        // Efficiently drain the queue
        const itemsToBatch = requestQueue.splice(0, requestQueue.length);
        
        for (const r of itemsToBatch) {
          if (!grouped.has(r.key)) grouped.set(r.key, []);
          const group = grouped.get(r.key);
          if (group) {
            group.push(r);
          }
        }

        for (const [key, group] of grouped.entries()) {
          try {
            //audit Assumption: first payload is representative for batch
            const payload = group[0].payload;
            const data = await openai.chat.completions.create({
              ...payload,
              stream: false
            });
            responseCache.set(key, { timestamp: Date.now(), data });

            for (const r of group) r.resolve(data);

            auditLogger.log?.("[AUDIT] Batched OpenAI call", {
              key,
              batchSize: group.length,
            });
          } catch (err: unknown) {
            //audit Assumption: OpenAI errors should reject all batch entries
            const error = err instanceof Error ? err : new Error(String(err));
            for (const r of group) r.reject(error);
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
      // Note: This destroy() only stops the batch processor. 
      // Call the manager's destroy() to fully clean up.
      destroy: () => {
        // No-op at wrapper level; cleanup happens at manager level
        // This maintains consistency across all wrapper instances
      }
    };
  }

  // --- Cleanup function ---
  function destroy() {
    //audit Assumption: cleanup should stop batching and clear caches
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

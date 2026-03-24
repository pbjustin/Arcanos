/**
 * v2 Trust Verification — Redis Client
 *
 * Atomic NX-based nonce and lock operations with fail-closed semantics.
 * Wraps redis calls through a CircuitBreaker to prevent cascading failures.
 * Uses a connection promise to prevent double-initialization races.
 *
 * REQUIRES: npm install redis
 */

import { createClient } from "redis";
import { V2_CONFIG } from "./config.js";
import { CircuitBreaker } from "./circuitBreaker.js";

type RedisClient = ReturnType<typeof createClient>;

let connectionPromise: Promise<RedisClient> | null = null;
const breaker = new CircuitBreaker();

export async function getRedis(): Promise<RedisClient> {
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    const client = createClient({
      url: V2_CONFIG.REDIS_URL,
      socket: {
        reconnectStrategy: (retries: number) => Math.min(retries * 100, 3_000),
        connectTimeout: 5_000,
      },
    });

    client.on("error", (err: Error) => {
      console.error("[v2/redis] connection error:", err.message);
    });

    await client.connect();
    return client;
  })();

  return connectionPromise;
}

/**
 * Atomically set a key only if it doesn't exist. Fail-closed on error.
 * Returns true if set succeeded, throws on Redis failure.
 */
export async function setNX(key: string, ttlSeconds: number): Promise<boolean> {
  if (ttlSeconds <= 0) {
    throw new Error(`Invalid TTL: ${ttlSeconds}s — token may be expired`);
  }

  return breaker.call(async () => {
    const redis = await getRedis();
    const result = await redis.set(key, "1", { NX: true, EX: ttlSeconds });
    return result === "OK";
  });
}

/**
 * Extend the TTL of an existing key (for lock heartbeat).
 */
export async function extendTTL(
  key: string,
  ttlMs: number
): Promise<boolean> {
  return breaker.call(async () => {
    const redis = await getRedis();
    const result = await redis.pExpire(key, ttlMs);
    return Boolean(result);
  });
}

/**
 * Delete a key (for lock release). Best-effort — does not throw.
 */
export async function deleteKey(key: string): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.del(key);
  } catch {
    console.error("[v2/redis] failed to delete key");
  }
}

/**
 * Graceful disconnect.
 */
export async function disconnectRedis(): Promise<void> {
  if (!connectionPromise) return;
  const promise = connectionPromise;
  connectionPromise = null;
  try {
    const client = await promise;
    await client.quit();
  } catch {
    // best-effort
  }
}

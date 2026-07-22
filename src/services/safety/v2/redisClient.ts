/**
 * v2 Trust Verification — Redis Client
 *
 * Atomic NX-based nonce and lock operations with fail-closed semantics.
 * Uses the shared Redis dependency lifecycle so this service does not create
 * or own a separate Redis connection.
 *
 * REQUIRES: npm install redis
 */

import {
  executeRedisOperation,
  requireReadyRedisClient,
  type RedisLifecycleClient,
} from "@platform/runtime/redisLifecycle.js";

export async function getRedis(): Promise<RedisLifecycleClient> {
  return requireReadyRedisClient();
}

/**
 * Atomically set a key only if it doesn't exist. Fail-closed on error.
 * Returns true if set succeeded, throws on Redis failure.
 */
export async function setNX(key: string, ttlSeconds: number): Promise<boolean> {
  if (ttlSeconds <= 0) {
    throw new Error(`Invalid TTL: ${ttlSeconds}s — token may be expired`);
  }

  return executeRedisOperation(async (redis) => {
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
  return executeRedisOperation(async (redis) => {
    const result = await redis.pExpire(key, ttlMs);
    return Boolean(result);
  });
}

/**
 * Delete a key (for lock release). Best-effort — does not throw.
 */
export async function deleteKey(key: string): Promise<void> {
  try {
    await executeRedisOperation((redis) => redis.del(key));
  } catch {
    console.error("[v2/redis] failed to delete key");
  }
}

/**
 * Graceful disconnect.
 */
export async function disconnectRedis(): Promise<void> {
  // The process-level Redis lifecycle owns and closes the shared client.
}

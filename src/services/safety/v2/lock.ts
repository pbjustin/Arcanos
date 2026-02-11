/**
 * v2 Trust Verification — Distributed Lock with Heartbeat
 *
 * Provides atomic lock acquisition, heartbeat-based extension, and
 * safe release. Uses Redis NX with unique owner tokens for cluster-safe
 * locking. Release uses a Lua script for conditional delete to prevent
 * releasing another holder's lock.
 */

import { randomUUID } from "node:crypto";
import { V2_CONFIG } from "./config.js";
import { getRedis } from "./redisClient.js";
import { CircuitBreaker } from "./circuitBreaker.js";

const breaker = new CircuitBreaker();

export type LockLostCallback = (key: string) => void;

export class DistributedLock {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly ownerId: string;
  private released = false;
  private onLockLost: LockLostCallback | null;

  constructor(
    name: string,
    opts?: {
      ttlMs?: number;
      heartbeatMs?: number;
      onLockLost?: LockLostCallback;
    }
  ) {
    this.key = `${V2_CONFIG.LOCK_PREFIX}${name}`;
    this.ttlMs = opts?.ttlMs ?? V2_CONFIG.LOCK_DEFAULTS.TTL_MS;
    this.heartbeatMs =
      opts?.heartbeatMs ?? V2_CONFIG.LOCK_DEFAULTS.HEARTBEAT_INTERVAL_MS;
    this.ownerId = randomUUID();
    this.onLockLost = opts?.onLockLost ?? null;
  }

  /**
   * Acquire the lock. Throws if already held by another owner.
   */
  async acquire(): Promise<void> {
    const result = await breaker.call(async () => {
      const redis = await getRedis();
      return redis.set(this.key, this.ownerId, { NX: true, PX: this.ttlMs });
    });

    if (result !== "OK") {
      throw new Error(`Lock already held: ${this.key}`);
    }

    this.released = false;
    this.startHeartbeat();
  }

  /**
   * Release the lock only if we still own it (conditional delete via Lua).
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopHeartbeat();

    // Lua script: delete only if the value matches our ownerId
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      const redis = await getRedis();
      await redis.eval(script, { keys: [this.key], arguments: [this.ownerId] });
    } catch {
      // best-effort release — log for diagnostics
      try {
        // eslint-disable-next-line no-console
        console.error(`[v2/lock] failed to release lock ${this.key}`);
      } catch {}
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      if (this.released) return;
      try {
        // Atomically extend TTL only if we still own the lock to avoid race
        const redis = await getRedis();
        const script = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;
        const res = await redis.eval(script, {
          keys: [this.key],
          arguments: [this.ownerId, String(this.ttlMs)],
        });
        if (!res) {
          // Lock was stolen or expired — notify caller
          this.released = true;
          this.stopHeartbeat();
          this.onLockLost?.(this.key);
          return;
        }
      } catch {
        // Log and notify owner lost — heartbeat is best-effort
        try {
          // eslint-disable-next-line no-console
          console.error(`[v2/lock] heartbeat failed for ${this.key}`);
        } catch {}
        this.released = true;
        this.stopHeartbeat();
        this.onLockLost?.(this.key);
      }
    }, this.heartbeatMs);

    // Prevent the heartbeat from keeping the process alive
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

/**
 * Convenience: acquire lock, run fn, release lock.
 * Release errors are logged but do not replace the original error.
 */
export async function withLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts?: { ttlMs?: number; heartbeatMs?: number; onLockLost?: LockLostCallback }
): Promise<T> {
  const lock = new DistributedLock(name, opts);
  await lock.acquire();
  try {
    return await fn();
  } finally {
    try {
      await lock.release();
    } catch (releaseErr) {
      console.error("[v2/lock] release failed:", releaseErr);
    }
  }
}

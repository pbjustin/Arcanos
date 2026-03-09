/**
 * Simple In-Memory Cache Implementation
 * Provides high-performance caching for frequently accessed data
 */

import { APPLICATION_CONSTANTS } from "@shared/constants.js";
import { logger } from "@platform/logging/structuredLogging.js";

export interface CacheOptions {
  defaultTtlMs: number;
  maxEntries: number;
  cleanupIntervalMs: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
}

export class MemoryCache<T = any> {
  private cache = new Map<string, CacheEntry<T>>();
  private lastCleanupAtMs = 0;
  private readonly cacheLogger = logger.child({ module: 'cache' });

  private static readonly EVICTION_RATIO = 0.1;

  constructor(private options: CacheOptions) {
    this.lastCleanupAtMs = Date.now();
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.maybeCleanupExpiredEntries(Date.now());
    const expireTime = Date.now() + (ttlMs || this.options.defaultTtlMs);

    // Enforce max entries by removing oldest accessed items
    if (this.cache.size >= this.options.maxEntries) {
      this.evictOldestEntries(Math.floor(this.options.maxEntries * MemoryCache.EVICTION_RATIO)); // Remove 10%
    }

    this.cache.set(key, {
      value,
      expiresAt: expireTime,
      accessCount: 0,
      lastAccessed: Date.now()
    });
  }

  get(key: string): T | null {
    this.maybeCleanupExpiredEntries(Date.now());
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return null;
    }

    // Update access metrics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    
    return entry.value;
  }

  has(key: string): boolean {
    this.maybeCleanupExpiredEntries(Date.now());
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  getStats() {
    const now = Date.now();
    this.maybeCleanupExpiredEntries(now);
    let expired = 0;
    let total = 0;
    let totalAccessCount = 0;

    for (const entry of this.cache.values()) {
      total++;
      totalAccessCount += entry.accessCount;

      if (this.isExpired(entry, now)) {
        expired++;
      }
    }

    return {
      totalEntries: total,
      expiredEntries: expired,
      activeEntries: total - expired,
      averageAccessCount: total > 0 ? totalAccessCount / total : 0,
      memoryUsage: this.cache.size
    };
  }

  private evictOldestEntries(count: number): void {
    if (count <= 0) {
      return;
    }

    const entries = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed)
      .slice(0, count);

    for (const [key] of entries) {
      this.cache.delete(key);
    }

    this.cacheLogger.info('Cache eviction completed', {
      count,
      reason: 'max_entries',
      cacheSize: this.cache.size
    });
  }

  private cleanup(): void {
    const now = Date.now();
    let removedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      this.cacheLogger.info('Cache cleanup completed', {
        removedCount,
        cacheSize: this.cache.size,
        action: 'expired_entry_prune'
      });
    }
  }

  /**
   * Opportunistically remove expired cache entries without background timers.
   *
   * Purpose: keep module-scope caches test-safe and worker-safe by avoiding import-time intervals.
   * Inputs/outputs: accepts the current timestamp and prunes stale entries when the cleanup window elapses.
   * Edge cases: no-op when the cache is empty or cleanup was run recently.
   */
  private maybeCleanupExpiredEntries(now: number): void {
    //audit Assumption: request-driven cache cleanup is sufficient for bounded memory under active traffic; failure risk: expired entries remain longer during idle periods; expected invariant: expired entries are removed on the next eligible cache access; handling strategy: throttle cleanup work instead of scheduling background timers.
    if (this.cache.size === 0) {
      this.lastCleanupAtMs = now;
      return;
    }
    if (now - this.lastCleanupAtMs < this.options.cleanupIntervalMs) {
      return;
    }
    this.cleanup();
    this.lastCleanupAtMs = now;
  }

  destroy(): void {
    this.clear();
  }

  private isExpired(entry: CacheEntry<T>, now: number = Date.now()): boolean {
    return now > entry.expiresAt;
  }
}

// Global cache instances for different types of data
export const responseCache = new MemoryCache({
  defaultTtlMs: APPLICATION_CONSTANTS.CACHE_TTL_SHORT,
  maxEntries: APPLICATION_CONSTANTS.CACHE_MAX_ENTRIES_LARGE,
  cleanupIntervalMs: APPLICATION_CONSTANTS.CACHE_CLEANUP_INTERVAL_SHORT
});

export const queryCache = new MemoryCache({
  defaultTtlMs: APPLICATION_CONSTANTS.CACHE_TTL_MEDIUM,
  maxEntries: APPLICATION_CONSTANTS.CACHE_MAX_ENTRIES_MEDIUM,
  cleanupIntervalMs: APPLICATION_CONSTANTS.CACHE_CLEANUP_INTERVAL_MEDIUM
});

export const configCache = new MemoryCache({
  defaultTtlMs: APPLICATION_CONSTANTS.CACHE_TTL_LONG,
  maxEntries: APPLICATION_CONSTANTS.CACHE_MAX_ENTRIES_SMALL,
  cleanupIntervalMs: APPLICATION_CONSTANTS.CACHE_CLEANUP_INTERVAL_LONG
});

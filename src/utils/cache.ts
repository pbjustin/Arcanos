/**
 * Simple In-Memory Cache Implementation
 * Provides high-performance caching for frequently accessed data
 */

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
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private options: CacheOptions) {
    this.startCleanupTimer();
  }

  set(key: string, value: T, ttlMs?: number): void {
    const expireTime = Date.now() + (ttlMs || this.options.defaultTtlMs);
    
    // Enforce max entries by removing oldest accessed items
    if (this.cache.size >= this.options.maxEntries) {
      this.evictOldestEntries(Math.floor(this.options.maxEntries * 0.1)); // Remove 10%
    }

    this.cache.set(key, {
      value,
      expiresAt: expireTime,
      accessCount: 0,
      lastAccessed: Date.now()
    });
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Update access metrics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    
    return entry.value;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (Date.now() > entry.expiresAt) {
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
    let expired = 0;
    let total = 0;
    let totalAccessCount = 0;

    for (const entry of this.cache.values()) {
      total++;
      totalAccessCount += entry.accessCount;
      
      if (now > entry.expiresAt) {
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
    const entries = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed)
      .slice(0, count);

    for (const [key] of entries) {
      this.cache.delete(key);
    }

    if (count > 0) {
      console.log(`🧹 Cache: Evicted ${count} oldest entries to maintain max size`);
    }
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
      console.log(`🧹 Cache: Cleaned up ${removedCount} expired entries`);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.options.cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
  }
}

// Global cache instances for different types of data
export const responseCache = new MemoryCache({
  defaultTtlMs: 5 * 60 * 1000, // 5 minutes
  maxEntries: 1000,
  cleanupIntervalMs: 60 * 1000 // 1 minute
});

export const queryCache = new MemoryCache({
  defaultTtlMs: 10 * 60 * 1000, // 10 minutes  
  maxEntries: 500,
  cleanupIntervalMs: 2 * 60 * 1000 // 2 minutes
});

export const configCache = new MemoryCache({
  defaultTtlMs: 30 * 60 * 1000, // 30 minutes
  maxEntries: 100,
  cleanupIntervalMs: 5 * 60 * 1000 // 5 minutes
});
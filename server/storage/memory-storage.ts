import { randomUUID } from 'crypto';
import type {
  MemoryEntry,
  APIRequest,
  CacheEntry,
  LogEntry,
  SystemEvent
} from '../types';
import { HARDCODED_USER as SINGLE_USER } from '../types';

export class MemoryStorage {
  private memories: Map<string, MemoryEntry> = new Map();
  private requests: Map<string, APIRequest> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private logs: Map<string, LogEntry> = new Map();
  private events: Map<string, SystemEvent> = new Map();

  private readonly MAX_MEMORY_ENTRIES = 10000;
  private readonly MAX_LOG_ENTRIES = 5000;
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour

  constructor() {
    this.startCleanupTimer();
    console.log('[MEMORY] Single-user memory storage initialized for:', SINGLE_USER.username);
  }

  private startCleanupTimer() {
    setInterval(() => {
      this.cleanupExpiredMemories();
      this.cleanupOldLogs();
      this.cleanupCache();
    }, 30 * 60 * 1000);
  }

  // Memory Management
  async storeMemory(
    userId: string,
    sessionId: string,
    type: MemoryEntry['type'],
    key: string,
    value: any,
    tags: string[] = [],
    ttl?: number
  ): Promise<MemoryEntry> {
    if (this.memories.size >= this.MAX_MEMORY_ENTRIES) {
      this.cleanupOldMemories();
    }
    const memory: MemoryEntry = {
      id: randomUUID(),
      userId,
      sessionId,
      type,
      key,
      value,
      timestamp: new Date(),
      ttl,
      tags,
      metadata: {
        importance: 'medium',
        category: type,
        source: 'user',
        version: 1,
        encrypted: false
      }
    };
    this.memories.set(memory.id, memory);
    this.logEvent('memory.created', 'memory', userId, { memoryId: memory.id, key, type });
    return memory;
  }

  async getMemoriesByUser(userId: string, type?: MemoryEntry['type']): Promise<MemoryEntry[]> {
    // For single-user system, always return memories for the hardcoded user
    const memories = Array.from(this.memories.values())
      .filter(m => {
        if (type && m.type !== type) return false;
        if (m.ttl && Date.now() - m.timestamp.getTime() > m.ttl) {
          this.memories.delete(m.id);
          return false;
        }
        return true;
      })
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return memories;
  }

  // Request Logging
  async logRequest(request: Omit<APIRequest, 'id'>): Promise<APIRequest> {
    const fullRequest: APIRequest = {
      id: randomUUID(),
      ...request
    };
    this.requests.set(fullRequest.id, fullRequest);
    return fullRequest;
  }

  async getRequests(limit: number = 100): Promise<APIRequest[]> {
    return Array.from(this.requests.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  // Cache Management
  async setCache<T>(key: string, value: T, ttl: number = this.CACHE_TTL): Promise<void> {
    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + ttl),
      accessCount: 0,
      lastAccessed: new Date(),
      size: JSON.stringify(value).length
    };
    this.cache.set(key, entry);
  }

  async getCache<T>(key: string): Promise<T | undefined> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt.getTime() < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    entry.accessCount++;
    entry.lastAccessed = new Date();
    this.cache.set(key, entry);
    return entry.value;
  }

  // Event Management
  async logEvent(
    type: SystemEvent['type'],
    source: string,
    userId?: string,
    data: Record<string, any> = {}
  ): Promise<SystemEvent> {
    const event: SystemEvent = {
      id: randomUUID(),
      type,
      timestamp: new Date(),
      source,
      userId,
      data,
      metadata: {
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
      }
    };
    this.events.set(event.id, event);
    return event;
  }

  // Cleanup methods
  private cleanupExpiredMemories() {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [id, memory] of this.memories) {
      if (memory.ttl && now - memory.timestamp.getTime() > memory.ttl) {
        this.memories.delete(id);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`[MEMORY] Cleaned up ${cleanedCount} expired memories`);
    }
  }

  private cleanupOldMemories() {
    const memoriesArray = Array.from(this.memories.entries());
    memoriesArray.sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime());
    const toRemove = memoriesArray.slice(0, memoriesArray.length - this.MAX_MEMORY_ENTRIES + 1000);
    for (const [id] of toRemove) {
      this.memories.delete(id);
    }
    console.log(`[MEMORY] Cleaned up ${toRemove.length} old memories`);
  }

  private cleanupOldLogs() {
    const logsArray = Array.from(this.logs.entries());
    logsArray.sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime());
    const toRemove = logsArray.slice(0, logsArray.length - this.MAX_LOG_ENTRIES + 1000);
    for (const [id] of toRemove) {
      this.logs.delete(id);
    }
    console.log(`[MEMORY] Cleaned up ${toRemove.length} old logs`);
  }

  private cleanupCache() {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt && entry.expiresAt.getTime() < now) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`[MEMORY] Cleaned up ${cleanedCount} expired cache entries`);
    }
  }

  getStorageStats() {
    return {
      memories: this.memories.size,
      requests: this.requests.size,
      cacheEntries: this.cache.size,
      logs: this.logs.size,
      events: this.events.size,
      memoryUsage: process.memoryUsage(),
      user: SINGLE_USER
    };
  }
}
import { databaseService } from '../services/database.js';

export interface MemoryEntry {
  id: string;
  userId: string;
  sessionId: string;
  type: 'context' | 'preference' | 'interaction' | 'system';
  key: string;
  value: any;
  timestamp: Date;
  ttl?: number;
  tags: string[];
  metadata: {
    importance: 'low' | 'medium' | 'high';
    category: string;
    source: string;
    version: number;
    encrypted: boolean;
  };
}

export class MemoryStorage {
  private memories: Map<string, MemoryEntry> = new Map();
  private userIndex: Map<string, Set<string>> = new Map(); // User -> MemoryIDs
  private typeIndex: Map<string, Set<string>> = new Map(); // Type -> MemoryIDs
  private keyIndex: Map<string, Set<string>> = new Map(); // Key -> MemoryIDs
  private persistent = !!process.env.DATABASE_URL;
  
  // Memory optimization: LRU cache with size limits
  private maxCacheSize = parseInt(process.env.MEMORY_CACHE_SIZE || '10000');
  private accessOrder: string[] = []; // LRU tracking

  private updateIndexes(memory: MemoryEntry): void {
    // Update user index
    if (!this.userIndex.has(memory.userId)) {
      this.userIndex.set(memory.userId, new Set());
    }
    this.userIndex.get(memory.userId)!.add(memory.id);
    
    // Update type index
    if (!this.typeIndex.has(memory.type)) {
      this.typeIndex.set(memory.type, new Set());
    }
    this.typeIndex.get(memory.type)!.add(memory.id);
    
    // Update key index
    if (!this.keyIndex.has(memory.key)) {
      this.keyIndex.set(memory.key, new Set());
    }
    this.keyIndex.get(memory.key)!.add(memory.id);
  }

  private removeFromIndexes(memory: MemoryEntry): void {
    this.userIndex.get(memory.userId)?.delete(memory.id);
    this.typeIndex.get(memory.type)?.delete(memory.id);
    this.keyIndex.get(memory.key)?.delete(memory.id);
  }

  private enforceMemoryLimit(): void {
    while (this.memories.size > this.maxCacheSize) {
      const oldestId = this.accessOrder.shift();
      if (oldestId) {
        const memory = this.memories.get(oldestId);
        if (memory) {
          this.removeFromIndexes(memory);
          this.memories.delete(oldestId);
        }
      }
    }
  }

  private updateAccessOrder(id: string): void {
    // Remove from current position and add to end (most recent)
    const index = this.accessOrder.indexOf(id);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(id);
  }

  async storeMemory(
    userId: string,
    sessionId: string,
    type: MemoryEntry['type'],
    key: string,
    value: any,
    tags: string[] = [],
    ttl?: number
  ): Promise<MemoryEntry> {
    const memory: MemoryEntry = {
      id: Math.random().toString(36).substr(2, 9),
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
    
    // Memory-optimized storage with indexing
    this.memories.set(memory.id, memory);
    this.updateIndexes(memory);
    this.updateAccessOrder(memory.id);
    this.enforceMemoryLimit();

    if (this.persistent) {
      try {
        await databaseService.saveMemory({
          memory_key: memory.id,
          memory_value: memory,
          container_id: userId,
        });
      } catch (error: any) {
        console.warn('Persistent memory save failed:', error.message);
      }
    }

    return memory;
  }

  async getMemoriesByUser(userId: string, type?: MemoryEntry['type']): Promise<MemoryEntry[]> {
    // Memory-optimized query using indexes
    let candidateIds: Set<string>;
    
    // Start with user index for fast filtering
    const userMemoryIds = this.userIndex.get(userId);
    if (!userMemoryIds || userMemoryIds.size === 0) {
      // Check persistent storage if no in-memory results
      if (this.persistent) {
        try {
          const results = await databaseService.loadAllMemory(userId);
          return results.map(r => r.memory_value as MemoryEntry)
            .filter(m => !type || m.type === type)
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        } catch (error: any) {
          console.warn('Persistent memory load failed:', error.message);
          return [];
        }
      }
      return [];
    }
    
    candidateIds = new Set(userMemoryIds);
    
    // Apply type filter using index intersection if specified
    if (type) {
      const typeMemoryIds = this.typeIndex.get(type);
      if (typeMemoryIds) {
        candidateIds = new Set([...candidateIds].filter(id => typeMemoryIds.has(id)));
      } else {
        candidateIds = new Set(); // No memories of this type
      }
    }
    
    // Retrieve and filter memories
    const entries: MemoryEntry[] = [];
    for (const id of candidateIds) {
      const memory = this.memories.get(id);
      if (memory) {
        // Update access order for LRU
        this.updateAccessOrder(id);
        
        // Check TTL
        if (memory.ttl && Date.now() - new Date(memory.timestamp).getTime() > memory.ttl) {
          this.removeFromIndexes(memory);
          this.memories.delete(id);
          continue;
        }
        entries.push(memory);
      }
    }

    return entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async getMemory(userId: string, key: string): Promise<MemoryEntry | undefined> {
    // Memory-optimized query using key index
    const keyMemoryIds = this.keyIndex.get(key);
    if (keyMemoryIds) {
      for (const id of keyMemoryIds) {
        const memory = this.memories.get(id);
        if (memory && memory.userId === userId) {
          this.updateAccessOrder(id);
          return memory;
        }
      }
    }
    
    // Fallback to database if not in cache
    if (this.persistent) {
      try {
        const results = await databaseService.loadAllMemory(userId);
        const found = results.find(r => (r.memory_value as MemoryEntry).key === key);
        return found ? (found.memory_value as MemoryEntry) : undefined;
      } catch (error: any) {
        console.warn('Persistent memory load failed:', error.message);
      }
    }
    
    return undefined;
  }

  async getMemoryById(id: string): Promise<MemoryEntry | undefined> {
    // Memory-optimized direct access
    const memory = this.memories.get(id);
    if (memory) {
      this.updateAccessOrder(id);
      return memory;
    }
    
    // Fallback to persistent storage
    if (this.persistent) {
      try {
        const result = await databaseService.loadMemory({ memory_key: id });
        const memoryEntry = result ? (result.memory_value as MemoryEntry) : undefined;
        
        // Cache the result for future access
        if (memoryEntry) {
          this.memories.set(id, memoryEntry);
          this.updateIndexes(memoryEntry);
          this.updateAccessOrder(id);
          this.enforceMemoryLimit();
        }
        
        return memoryEntry;
      } catch (error: any) {
        console.warn('Persistent memory load by id failed:', error.message);
        return undefined;
      }
    }
    return undefined;
  }

  async clearAll(userId: string): Promise<{ cleared: number }> {
    let cleared = 0;
    
    // Memory-optimized clearing using user index
    const userMemoryIds = this.userIndex.get(userId);
    if (userMemoryIds) {
      for (const id of userMemoryIds) {
        const memory = this.memories.get(id);
        if (memory) {
          this.removeFromIndexes(memory);
          this.memories.delete(id);
          
          // Remove from access order
          const accessIndex = this.accessOrder.indexOf(id);
          if (accessIndex > -1) {
            this.accessOrder.splice(accessIndex, 1);
          }
          
          cleared++;
        }
      }
      
      // Clear the user index
      this.userIndex.delete(userId);
    }

    // Clear from persistent storage
    if (this.persistent) {
      try {
        await databaseService.clearMemory(userId);
      } catch (error: any) {
        console.warn('Persistent memory clear failed:', error.message);
      }
    }

    return { cleared };
  }

  // Additional memory optimization methods
  getCacheStats() {
    return {
      totalEntries: this.memories.size,
      maxCacheSize: this.maxCacheSize,
      cacheUtilization: (this.memories.size / this.maxCacheSize * 100).toFixed(2) + '%',
      userIndexes: this.userIndex.size,
      typeIndexes: this.typeIndex.size,
      keyIndexes: this.keyIndex.size
    };
  }

  async compactCache(): Promise<void> {
    // Remove expired entries
    const now = Date.now();
    const toRemove: string[] = [];
    
    for (const [id, memory] of this.memories.entries()) {
      if (memory.ttl && now - new Date(memory.timestamp).getTime() > memory.ttl) {
        toRemove.push(id);
      }
    }
    
    for (const id of toRemove) {
      const memory = this.memories.get(id);
      if (memory) {
        this.removeFromIndexes(memory);
        this.memories.delete(id);
        
        const accessIndex = this.accessOrder.indexOf(id);
        if (accessIndex > -1) {
          this.accessOrder.splice(accessIndex, 1);
        }
      }
    }
  }
}

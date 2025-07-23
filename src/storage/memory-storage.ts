import { databaseService } from '../services/database';

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
  private persistent = !!process.env.DATABASE_URL;

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
    this.memories.set(memory.id, memory);

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
    let entries: MemoryEntry[] = [];

    if (this.persistent) {
      try {
        const results = await databaseService.loadAllMemory(userId);
        entries = results.map(r => r.memory_value as MemoryEntry);
      } catch (error: any) {
        console.warn('Persistent memory load failed:', error.message);
        entries = [];
      }
    } else {
      entries = Array.from(this.memories.values()).filter(m => m.userId === userId);
    }

    const filtered = entries.filter(m => {
      if (type && m.type !== type) return false;
      if (m.ttl && Date.now() - new Date(m.timestamp).getTime() > m.ttl) {
        this.memories.delete(m.id);
        return false;
      }
      return true;
    });

    return filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async getMemory(userId: string, key: string): Promise<MemoryEntry | undefined> {
    const entries = await this.getMemoriesByUser(userId);
    return entries.find(m => m.key === key);
  }

  async clearAll(userId: string): Promise<{ cleared: number }> {
    let cleared = 0;
    for (const [id, mem] of this.memories.entries()) {
      if (mem.userId === userId) {
        this.memories.delete(id);
        cleared++;
      }
    }

    if (this.persistent) {
      try {
        await databaseService.clearMemory(userId);
      } catch (error: any) {
        console.warn('Persistent memory clear failed:', error.message);
      }
    }

    return { cleared };
  }
}
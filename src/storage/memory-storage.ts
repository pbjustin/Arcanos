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
    return memory;
  }

  async getMemoriesByUser(userId: string, type?: MemoryEntry['type']): Promise<MemoryEntry[]> {
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
}
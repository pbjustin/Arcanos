import { randomUUID } from 'crypto';

export interface SessionMetadata {
  topic?: string;
  tags?: string[];
  summary?: string;
  [key: string]: unknown;
}

export interface SessionEntry {
  sessionId: string;
  conversations_core: any;
  metadata?: SessionMetadata;
}

export interface SessionUpsert {
  sessionId?: string;
  conversations_core?: any;
  metadata?: SessionMetadata;
}

interface MemoryStoreOptions {
  capacity?: number;
}

const DEFAULT_CAPACITY = parseInt(process.env.SESSION_CACHE_CAPACITY || '200', 10);

class MemoryStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly capacity: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.capacity = options.capacity || DEFAULT_CAPACITY;
  }

  getAllSessions(): SessionEntry[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  saveSession(entry: SessionUpsert): SessionEntry {
    const sessionId = entry.sessionId || randomUUID();
    const existing = this.sessions.get(sessionId);
    const merged: SessionEntry = {
      sessionId,
      conversations_core: entry.conversations_core ?? existing?.conversations_core ?? [],
      metadata: this.mergeMetadata(existing?.metadata, entry.metadata)
    };

    this.sessions.set(sessionId, merged);
    this.enforceCapacity();
    return merged;
  }

  private mergeMetadata(current?: SessionMetadata, incoming?: SessionMetadata): SessionMetadata | undefined {
    if (!current && !incoming) {
      return undefined;
    }

    return {
      ...(current || {}),
      ...(incoming || {})
    };
  }

  private enforceCapacity(): void {
    if (this.sessions.size <= this.capacity) {
      return;
    }

    const overflow = this.sessions.size - this.capacity;
    const keys = Array.from(this.sessions.keys());

    for (let i = 0; i < overflow; i += 1) {
      const key = keys[i];
      if (key) {
        this.sessions.delete(key);
      }
    }
  }
}

const memoryStore = new MemoryStore();
export default memoryStore;
export { MemoryStore };

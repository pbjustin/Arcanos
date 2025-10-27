import { randomUUID } from 'crypto';
import { createSessionPersistenceAdapter, type SessionPersistenceAdapter } from './sessionPersistence.js';

export interface SessionMetadata {
  topic?: string;
  tags?: string[];
  summary?: string;
  [key: string]: unknown;
}

export interface SessionEntry {
  sessionId: string;
  conversations_core: unknown[];
  metadata?: SessionMetadata;
  updatedAt: number;
}

export interface SessionUpsert {
  sessionId?: string;
  conversations_core?: unknown[];
  metadata?: SessionMetadata;
}

interface MemoryStoreOptions {
  capacity?: number;
}

const DEFAULT_CAPACITY = parseInt(process.env.SESSION_CACHE_CAPACITY || '200', 10);
const DEFAULT_RETENTION_MINUTES = parseInt(process.env.SESSION_RETENTION_MINUTES || '1440', 10);

class MemoryStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly capacity: number;
  private readonly retentionMs: number;
  private persistence: SessionPersistenceAdapter | null;
  private initialized = false;

  constructor(options: MemoryStoreOptions = {}) {
    this.capacity = options.capacity || DEFAULT_CAPACITY;
    const retentionMinutes = Number.isFinite(DEFAULT_RETENTION_MINUTES) ? DEFAULT_RETENTION_MINUTES : 1440;
    this.retentionMs = Math.max(retentionMinutes, 1) * 60 * 1000;
    this.persistence = createSessionPersistenceAdapter();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.persistence) {
      try {
        await this.persistence.initialize();
        const sessions = await this.persistence.loadSessions();
        sessions.forEach(session => this.sessions.set(session.sessionId, session));
        this.enforceCapacity();
        await this.enforceRetentionAsync();
      } catch (error) {
        console.error('[memory-store] Failed to initialize session persistence', error);
        this.persistence = null;
      }
    }

    this.initialized = true;
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
      conversations_core: (entry.conversations_core ?? existing?.conversations_core ?? []) as unknown[],
      metadata: this.mergeMetadata(existing?.metadata, entry.metadata),
      updatedAt: Date.now()
    };

    this.sessions.set(sessionId, merged);

    const removedByCapacity = this.enforceCapacity();
    const removedByRetention = this.enforceRetention();

    if (this.persistence) {
      void this.persistence.persistSession(merged).catch(error => {
        console.warn('[memory-store] Failed to persist session', {
          sessionId,
          error: error instanceof Error ? error.message : 'unknown'
        });
      });

      for (const removedId of [...removedByCapacity, ...removedByRetention]) {
        void this.persistence.removeSession(removedId).catch(error => {
          console.warn('[memory-store] Failed to remove persisted session', {
            sessionId: removedId,
            error: error instanceof Error ? error.message : 'unknown'
          });
        });
      }

      if (removedByRetention.length === 0) {
        void this.persistence
          .purgeExpired(new Date(Date.now() - this.retentionMs))
          .catch(error =>
            console.warn('[memory-store] Failed to purge expired sessions', {
              error: error instanceof Error ? error.message : 'unknown'
            })
          );
      }
    }

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

  private enforceCapacity(): string[] {
    if (this.sessions.size <= this.capacity) {
      return [];
    }

    const overflow = this.sessions.size - this.capacity;
    const keys = Array.from(this.sessions.keys());
    const removed: string[] = [];

    for (let i = 0; i < overflow; i += 1) {
      const key = keys[i];
      if (key && this.sessions.delete(key)) {
        removed.push(key);
      }
    }

    return removed;
  }

  private enforceRetention(): string[] {
    if (this.retentionMs <= 0) {
      return [];
    }

    const cutoff = Date.now() - this.retentionMs;
    const removed: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.updatedAt < cutoff) {
        this.sessions.delete(sessionId);
        removed.push(sessionId);
      }
    }

    return removed;
  }

  private async enforceRetentionAsync(): Promise<void> {
    const removed = this.enforceRetention();
    if (!this.persistence) {
      return;
    }

    for (const sessionId of removed) {
      await this.persistence.removeSession(sessionId).catch(error => {
        console.warn('[memory-store] Failed to remove expired session from persistence', {
          sessionId,
          error: error instanceof Error ? error.message : 'unknown'
        });
      });
    }

    await this.persistence.purgeExpired(new Date(Date.now() - this.retentionMs)).catch(error => {
      console.warn('[memory-store] Failed to purge expired sessions during initialization', {
        error: error instanceof Error ? error.message : 'unknown'
      });
    });
  }
}

const memoryStore = new MemoryStore();
export default memoryStore;
export { MemoryStore };

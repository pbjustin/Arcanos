import path from 'path';
import { createSessionCacheStore, type SessionCacheStore, type SessionCacheStoreConfig } from '../db/sessionCacheStore.js';
import { logger } from '../utils/structuredLogging.js';
import type { SessionEntry } from './store.js';

export interface SessionPersistenceAdapter {
  initialize(): Promise<void>;
  loadSessions(): Promise<SessionEntry[]>;
  persistSession(session: SessionEntry): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  purgeExpired(cutoff: Date): Promise<void>;
}

type PersistenceConfig = SessionCacheStoreConfig;

class SqlSessionPersistenceAdapter implements SessionPersistenceAdapter {
  private readonly store: SessionCacheStore;

  constructor(config: PersistenceConfig) {
    this.store = createSessionCacheStore(config);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async loadSessions(): Promise<SessionEntry[]> {
    const rows = await this.store.loadSessions();

    return rows
      .map(row => {
        //audit assumption: cached payload is JSON; risk: corrupted data; invariant: returns null when invalid.
        const payload = safeParse(row.data);
        if (!payload) {
          return null;
        }
        return {
          ...payload,
          sessionId: row.sessionId,
          updatedAt: row.updatedAt.getTime()
        } satisfies SessionEntry;
      })
      //audit assumption: nulls represent invalid cache rows; risk: data loss; invariant: only valid sessions returned.
      .filter((session): session is SessionEntry => session !== null);
  }

  async persistSession(session: SessionEntry): Promise<void> {
    const payload = JSON.stringify(session);
    await this.store.persistSession(session.sessionId, payload, new Date(session.updatedAt));
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.store.removeSession(sessionId);
  }

  async purgeExpired(cutoff: Date): Promise<void> {
    await this.store.purgeExpired(cutoff);
  }
}

function safeParse(payload: string): SessionEntry | null {
  try {
    const parsed = JSON.parse(payload) as SessionEntry;
    //audit assumption: parsed payload follows SessionEntry; risk: invalid cache data; invariant: sessionId string required.
    if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string') {
      return parsed;
    }
    return null;
  } catch (error) {
    //audit assumption: JSON parse errors are expected in corrupted cache rows; risk: log noise; invariant: invalid payload returns null.
    logger.warn('Failed to parse session cache payload', {
      module: 'sessionPersistence',
      error: error instanceof Error ? error.message : 'unknown'
    });
    return null;
  }
}

function resolvePersistenceConfig(): PersistenceConfig | null {
  let client = (process.env.SESSION_PERSISTENCE_CLIENT || '').toLowerCase();
  const sqlitePath = process.env.SESSION_PERSISTENCE_SQLITE_PATH;

  if (!client) {
    //audit assumption: DATABASE_URL implies Postgres; risk: wrong auto-detect; invariant: client resolved when env is set.
    if (process.env.DATABASE_URL) {
      client = 'pg';
    } else if (sqlitePath) {
      client = 'better-sqlite3';
    }
  }

  if (client !== 'pg' && client !== 'better-sqlite3') {
    //audit assumption: unsupported clients should disable persistence; risk: silent disablement; invariant: caller handles null.
    return null;
  }

  if (client === 'pg') {
    const connection = process.env.SESSION_PERSISTENCE_URL || process.env.DATABASE_URL;
    if (!connection) {
      //audit assumption: connection string is required; risk: missing persistence; invariant: warn and disable.
      logger.warn('Session persistence configured for Postgres but no connection string provided');
      return null;
    }
    return { client, connection };
  }

  if (!sqlitePath) {
    //audit assumption: sqlite path required; risk: missing persistence; invariant: warn and disable.
    logger.warn('SQLite session persistence requested but SESSION_PERSISTENCE_SQLITE_PATH is missing');
    return null;
  }

  return {
    client,
    connection: {
      filename: path.resolve(sqlitePath)
    }
  };
}

/**
 * Build the session persistence adapter with database-backed storage.
 * Inputs: none (reads environment variables).
 * Output: adapter instance or null if persistence is disabled.
 * Edge cases: returns null when configuration is incomplete.
 */
export function createSessionPersistenceAdapter(): SessionPersistenceAdapter | null {
  const config = resolvePersistenceConfig();
  //audit assumption: missing config disables persistence; risk: sessions stay in memory; invariant: caller handles null.
  if (!config) {
    return null;
  }

  try {
    return new SqlSessionPersistenceAdapter(config);
  } catch (error) {
    //audit assumption: initialization failures are recoverable; risk: sessions not persisted; invariant: warning logged.
    logger.warn('Session persistence adapter initialization failed, continuing with in-memory store', {
      module: 'sessionPersistence',
      error: error instanceof Error ? error.message : 'unknown'
    });
    return null;
  }
}

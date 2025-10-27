import path from 'path';
import knexPkg from 'knex';
import type { Knex } from 'knex';
import { logger } from '../utils/structuredLogging.js';
import type { SessionEntry } from './store.js';

const knexFactory = knexPkg as unknown as (config: Knex.Config) => Knex;

export interface SessionPersistenceAdapter {
  initialize(): Promise<void>;
  loadSessions(): Promise<SessionEntry[]>;
  persistSession(session: SessionEntry): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  purgeExpired(cutoff: Date): Promise<void>;
}

interface PersistenceConfig {
  client: 'pg' | 'better-sqlite3';
  connection: string | Knex.StaticConnectionConfig;
}

class SqlSessionPersistenceAdapter implements SessionPersistenceAdapter {
  private readonly tableName = 'session_cache';
  private readonly db: Knex;
  private readonly client: 'pg' | 'better-sqlite3';

  constructor(config: PersistenceConfig) {
    this.client = config.client;
    this.db = knexFactory({
      client: config.client,
      connection: config.connection,
      useNullAsDefault: config.client === 'better-sqlite3'
    });
  }

  async initialize(): Promise<void> {
    const exists = await this.db.schema.hasTable(this.tableName);
    if (!exists) {
      await this.db.schema.createTable(this.tableName, table => {
        table.string('session_id').primary();
        if (this.client === 'pg') {
          table.jsonb('data').notNullable();
        } else {
          table.text('data').notNullable();
        }
        table.dateTime('updated_at').notNullable().index();
      });
    }
  }

  async loadSessions(): Promise<SessionEntry[]> {
    const rows = await this.db<{
      session_id: string;
      data: string | SessionEntry;
      updated_at: Date;
    }>(this.tableName).select('session_id', 'data', 'updated_at');

    return rows
      .map(row => {
        const payload = typeof row.data === 'string' ? safeParse(row.data) : row.data;
        if (!payload) {
          return null;
        }
        return {
          ...payload,
          sessionId: row.session_id,
          updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime()
        } satisfies SessionEntry;
      })
      .filter((session): session is SessionEntry => session !== null);
  }

  async persistSession(session: SessionEntry): Promise<void> {
    const payload = JSON.stringify(session);
    await this.db(this.tableName)
      .insert({
        session_id: session.sessionId,
        data: payload,
        updated_at: new Date(session.updatedAt)
      })
      .onConflict('session_id')
      .merge({ data: payload, updated_at: new Date(session.updatedAt) });
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.db(this.tableName).where({ session_id: sessionId }).del();
  }

  async purgeExpired(cutoff: Date): Promise<void> {
    await this.db(this.tableName).where('updated_at', '<', cutoff).del();
  }
}

function safeParse(payload: string): SessionEntry | null {
  try {
    const parsed = JSON.parse(payload) as SessionEntry;
    if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string') {
      return parsed;
    }
    return null;
  } catch (error) {
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
    if (process.env.DATABASE_URL) {
      client = 'pg';
    } else if (sqlitePath) {
      client = 'better-sqlite3';
    }
  }

  if (client !== 'pg' && client !== 'better-sqlite3') {
    return null;
  }

  if (client === 'pg') {
    const connection = process.env.SESSION_PERSISTENCE_URL || process.env.DATABASE_URL;
    if (!connection) {
      logger.warn('Session persistence configured for Postgres but no connection string provided');
      return null;
    }
    return { client, connection };
  }

  if (!sqlitePath) {
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

export function createSessionPersistenceAdapter(): SessionPersistenceAdapter | null {
  const config = resolvePersistenceConfig();
  if (!config) {
    return null;
  }

  try {
    return new SqlSessionPersistenceAdapter(config);
  } catch (error) {
    logger.warn('Session persistence adapter initialization failed, continuing with in-memory store', {
      module: 'sessionPersistence',
      error: error instanceof Error ? error.message : 'unknown'
    });
    return null;
  }
}

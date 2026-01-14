import knexPkg from 'knex';
import type { Knex } from 'knex';

const knexFactory = knexPkg as unknown as (config: Knex.Config) => Knex;

export interface SessionCacheRow {
  sessionId: string;
  data: string;
  updatedAt: Date;
}

export interface SessionCacheStore {
  /**
   * Ensure the session cache table exists.
   * Inputs: none.
   * Output: resolves once the table exists.
   * Edge cases: throws if the schema operation fails.
   */
  initialize(): Promise<void>;
  /**
   * Load all cached session rows.
   * Inputs: none.
   * Output: array of session cache rows.
   * Edge cases: throws if the query fails.
   */
  loadSessions(): Promise<SessionCacheRow[]>;
  /**
   * Upsert a session cache row.
   * Inputs: session id, serialized data, updated timestamp.
   * Output: resolves once persisted.
   * Edge cases: throws if the insert fails.
   */
  persistSession(sessionId: string, data: string, updatedAt: Date): Promise<void>;
  /**
   * Remove a cached session by id.
   * Inputs: session id.
   * Output: resolves once deleted.
   * Edge cases: throws if the delete fails.
   */
  removeSession(sessionId: string): Promise<void>;
  /**
   * Delete sessions older than the provided cutoff.
   * Inputs: cutoff date.
   * Output: resolves once deletes complete.
   * Edge cases: throws if the delete fails.
   */
  purgeExpired(cutoff: Date): Promise<void>;
}

export interface SessionCacheStoreConfig {
  client: 'pg' | 'better-sqlite3';
  connection: string | Knex.StaticConnectionConfig;
}

class KnexSessionCacheStore implements SessionCacheStore {
  private readonly tableName = 'session_cache';
  private readonly db: Knex;
  private readonly client: 'pg' | 'better-sqlite3';

  constructor(config: SessionCacheStoreConfig) {
    this.client = config.client;
    this.db = knexFactory({
      client: config.client,
      connection: config.connection,
      useNullAsDefault: config.client === 'better-sqlite3'
    });
  }

  async initialize(): Promise<void> {
    const exists = await this.db.schema.hasTable(this.tableName);
    //audit assumption: table should exist before reads; risk: missing table yields runtime errors; invariant: table created if absent.
    if (!exists) {
      await this.db.schema.createTable(this.tableName, table => {
        table.string('session_id').primary();
        if (this.client === 'pg') {
          //audit assumption: pg jsonb is supported; risk: incompatible driver; invariant: data column is non-null.
          table.jsonb('data').notNullable();
        } else {
          //audit assumption: sqlite stores JSON as text; risk: invalid JSON; invariant: data column is non-null.
          table.text('data').notNullable();
        }
        table.dateTime('updated_at').notNullable().index();
      });
    }
  }

  async loadSessions(): Promise<SessionCacheRow[]> {
    const rows = await this.db<{
      session_id: string;
      data: string | Record<string, unknown>;
      updated_at: Date;
    }>(this.tableName).select('session_id', 'data', 'updated_at');

    return rows.map(row => ({
      sessionId: row.session_id,
      //audit assumption: row.data is JSON; risk: stringify throws; invariant: stored as string for parsing.
      data: typeof row.data === 'string' ? row.data : JSON.stringify(row.data),
      //audit assumption: timestamp is parseable; risk: invalid date; invariant: updatedAt is Date.
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)
    }));
  }

  async persistSession(sessionId: string, data: string, updatedAt: Date): Promise<void> {
    await this.db(this.tableName)
      .insert({
        session_id: sessionId,
        data,
        updated_at: updatedAt
      })
      .onConflict('session_id')
      .merge({ data, updated_at: updatedAt });
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.db(this.tableName).where({ session_id: sessionId }).del();
  }

  async purgeExpired(cutoff: Date): Promise<void> {
    await this.db(this.tableName).where('updated_at', '<', cutoff).del();
  }
}

/**
 * Build the session cache store adapter for DB-backed sessions.
 * Inputs: store configuration with client and connection info.
 * Output: a session cache store instance.
 * Edge cases: throws if the configuration is invalid.
 */
export function createSessionCacheStore(config: SessionCacheStoreConfig): SessionCacheStore {
  return new KnexSessionCacheStore(config);
}

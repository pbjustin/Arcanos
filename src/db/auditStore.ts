import knexPkg from 'knex';
import type { Knex } from 'knex';
import { logger } from '../utils/structuredLogging.js';

const knexFactory = knexPkg as unknown as (config: Knex.Config) => Knex;

export interface AuditStoreTransaction {
  /**
   * Insert a save snapshot during an active transaction.
   * Inputs: moduleName (string), payload (stringified JSON), timestamp (epoch millis).
   * Output: resolves once the record is persisted.
   * Edge cases: throws if the insert fails or the transaction is closed.
   */
  insertSave(moduleName: string, payload: string, timestamp: number): Promise<void>;
}

export interface AuditStore {
  /**
   * Run a unit of work inside a single transaction.
   * Inputs: handler callback that receives a transactional writer.
   * Output: resolves with the handler result.
   * Edge cases: throws if the transaction cannot be opened.
   */
  runInTransaction<T>(handler: (transaction: AuditStoreTransaction) => Promise<T>): Promise<T>;
  /**
   * Insert an audit log event outside of a transactional save.
   * Inputs: event name, payload object, timestamp in epoch millis.
   * Output: resolves once the audit log is stored.
   * Edge cases: throws if the insert fails.
   */
  insertAuditLog(event: string, payload: Record<string, unknown>, timestamp: number): Promise<void>;
  /**
   * Check whether a table exists in the backing database.
   * Inputs: table name.
   * Output: resolves with true/false.
   * Edge cases: throws if the connection is unavailable.
   */
  hasTable(tableName: string): Promise<boolean>;
}

export interface AuditStoreConfig {
  connectionString?: string;
  pool?: { min: number; max: number };
}

class KnexAuditStore implements AuditStore {
  private readonly db: Knex;

  constructor(config: AuditStoreConfig) {
    //audit assumption: caller provides a valid connection string; risk: missing config prevents writes; invariant: db is usable.
    if (!config.connectionString) {
      throw new Error('Audit store requires a DATABASE_URL');
    }
    this.db = knexFactory({
      client: 'pg',
      connection: config.connectionString,
      pool: config.pool ?? { min: 2, max: 10 }
    });
  }

  async runInTransaction<T>(handler: (transaction: AuditStoreTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async trx => {
      const transactionWriter: AuditStoreTransaction = {
        insertSave: async (moduleName, payload, timestamp) => {
          await trx('saves').insert({
            module: moduleName,
            data: payload,
            timestamp
          });
        }
      };
      return handler(transactionWriter);
    });
  }

  async insertAuditLog(event: string, payload: Record<string, unknown>, timestamp: number): Promise<void> {
    await this.db('audit_logs').insert({
      event,
      //audit assumption: payload is JSON-serializable; risk: stringify throws; invariant: payload persists as string.
      payload: JSON.stringify(payload),
      timestamp
    });
  }

  async hasTable(tableName: string): Promise<boolean> {
    return this.db.schema.hasTable(tableName);
  }
}

/**
 * Build the audit store adapter used by persistence and audit flows.
 * Inputs: connection string and optional pool sizing.
 * Output: a configured audit store or null when no database is configured.
 * Edge cases: returns null if the connection string is missing.
 */
export function createAuditStore(config: AuditStoreConfig): AuditStore | null {
  if (!config.connectionString) {
    //audit assumption: audit storage is optional at boot; risk: missing logs; invariant: callers must handle null.
    logger.warn('Audit store skipped: DATABASE_URL is missing', { module: 'auditStore' });
    return null;
  }

  try {
    return new KnexAuditStore(config);
  } catch (error) {
    //audit assumption: constructor failure is recoverable; risk: audit writes unavailable; invariant: error is logged.
    logger.warn('Audit store initialization failed', {
      module: 'auditStore',
      error: error instanceof Error ? error.message : 'unknown'
    });
    return null;
  }
}

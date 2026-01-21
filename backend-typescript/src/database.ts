/**
 * Database Module
 * PostgreSQL connection and schema management
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { logger } from './logger';

export class DatabaseUnavailableError extends Error {
  /**
   * Purpose: Represent a database-unavailable condition without crashing handlers.
   * Inputs/Outputs: message string; extends Error for structured handling.
   * Edge cases: message may be empty; defaults to generic label.
   */
  constructor(message: string) {
    super(message || 'Database unavailable');
    this.name = 'DatabaseUnavailableError';
  }
}

export interface DatabaseStatus {
  ready: boolean;
  reason?: string;
}

function resolveDatabaseUrl(): string | null {
  /**
   * Purpose: Normalize the database URL from environment.
   * Inputs/Outputs: none; returns normalized URL or null when missing.
   * Edge cases: Empty/whitespace values return null.
   */
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    //audit assumption: DATABASE_URL may be unset; risk: no persistence; invariant: null returned; strategy: return null.
    return null;
  }
  const trimmedUrl = rawUrl.trim();
  if (!trimmedUrl) {
    //audit assumption: whitespace-only URL invalid; risk: no persistence; invariant: null returned; strategy: return null.
    return null;
  }
  //audit assumption: trimmed URL is usable; risk: invalid URL; invariant: string returned; strategy: return trimmed string.
  return trimmedUrl;
}

function normalizeDatabaseError(error: unknown): string {
  /**
   * Purpose: Normalize database errors into a loggable string.
   * Inputs/Outputs: unknown error; returns string message.
   * Edge cases: Non-Error values fallback to generic message.
   */
  if (error instanceof Error) {
    //audit assumption: Error message is useful; risk: empty message; invariant: string returned; strategy: use error.message.
    return error.message || 'Database error';
  }
  //audit assumption: error may not be Error; risk: lost context; invariant: fallback message; strategy: stringify type.
  return 'Database error';
}

const databaseUrl = resolveDatabaseUrl();
// Create connection pool when URL is configured
export const pool: Pool | null = databaseUrl
  ? new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  })
  : null;

if (pool) {
  // Test connection
  pool.on('connect', () => {
    logger.info('Database connection established');
  });

  pool.on('error', (err) => {
    //audit assumption: database errors can occur; risk: dropped connections; invariant: error logged; strategy: log error.
    logger.error('Unexpected database error', { error: err.message });
  });
} else {
  //audit assumption: missing DB URL disables persistence; risk: no database writes; invariant: explicit warning logged; strategy: warn.
  logger.warn('DATABASE_URL not set; database persistence disabled');
}

let databaseReady = false;
let databaseFailureReason: string | null = null;

function markDatabaseAvailable(): void {
  //audit assumption: success clears failure state; risk: stale reason; invariant: ready flag true; strategy: reset reason.
  databaseReady = true;
  databaseFailureReason = null;
}

function markDatabaseUnavailable(reason: string): void {
  //audit assumption: failure reason should be stored; risk: missing diagnostics; invariant: ready flag false; strategy: set reason.
  databaseReady = false;
  databaseFailureReason = reason;
}

function ensureDatabaseReady(actionLabel: string): boolean {
  if (!databaseReady) {
    //audit assumption: database may be unavailable; risk: failed persistence; invariant: action skipped; strategy: warn and return false.
    logger.warn('Database unavailable; skipping action', { action: actionLabel, reason: databaseFailureReason });
    return false;
  }
  return true;
}

/**
 * Purpose: Report current database status for health checks.
 * Inputs/Outputs: none; returns DatabaseStatus with readiness and reason.
 * Edge cases: reason omitted when database is ready.
 */
export function getDatabaseStatus(): DatabaseStatus {
  if (databaseReady) {
    //audit assumption: ready implies no reason; risk: stale reason; invariant: reason omitted; strategy: return ready only.
    return { ready: true };
  }
  return {
    ready: false,
    reason: databaseFailureReason || 'Database not initialized'
  };
}

/**
 * Purpose: Initialize database schema for conversations and audit logs.
 * Inputs/Outputs: none; creates tables and indexes if missing.
 * Edge cases: Throws if schema creation fails.
 */
export async function initDatabase(): Promise<boolean> {
  /**
   * Purpose: Initialize database schema for conversations and audit logs.
   * Inputs/Outputs: none; returns true when schema is ready.
   * Edge cases: Missing DATABASE_URL returns false and logs a warning.
   */
  if (!pool) {
    //audit assumption: pool missing means DB disabled; risk: no persistence; invariant: ready false; strategy: mark unavailable and return false.
    markDatabaseUnavailable('DATABASE_URL is not configured');
    return false;
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
  } catch (error) {
    //audit assumption: connection can fail; risk: no persistence; invariant: ready false; strategy: log and return false.
    const reason = normalizeDatabaseError(error);
    logger.error('Failed to connect to database', { error: reason });
    markDatabaseUnavailable(reason);
    return false;
  }

  try {
    // Create conversations table
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        user_message TEXT NOT NULL,
        ai_response TEXT NOT NULL,
        tokens_used INTEGER NOT NULL,
        cost DECIMAL(10, 6) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations (user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations (created_at);
    `);

    // Create audit_logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        event_data JSONB,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs (event_type);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);
    `);

    logger.info('Database schema initialized');
    markDatabaseAvailable();
    return true;
  } catch (error) {
    //audit assumption: schema creation can fail; risk: backend startup failure; invariant: error surfaced; strategy: log and rethrow.
    const reason = normalizeDatabaseError(error);
    logger.error('Failed to initialize database', { error: reason });
    markDatabaseUnavailable(reason);
    return false;
  } finally {
    if (client) {
      //audit assumption: client release should always run; risk: pool exhaustion; invariant: release executed; strategy: release when allocated.
      client.release();
    }
  }
}

/**
 * Purpose: Execute a parameterized SQL query.
 * Inputs/Outputs: SQL text and optional params; returns QueryResult.
 * Edge cases: Throws on query execution failure.
 */
export async function query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  if (!pool) {
    //audit assumption: pool required for query; risk: misconfigured DB; invariant: error thrown; strategy: throw unavailable error.
    throw new DatabaseUnavailableError('DATABASE_URL is not configured');
  }
  if (!databaseReady) {
    //audit assumption: database not ready; risk: query failure; invariant: error thrown; strategy: throw unavailable error.
    throw new DatabaseUnavailableError(databaseFailureReason || 'Database not initialized');
  }
  try {
    const result = await pool.query<T>(text, params);
    return result;
  } catch (error) {
    //audit assumption: query can fail; risk: data not persisted; invariant: error surfaced; strategy: log and rethrow.
    const reason = normalizeDatabaseError(error);
    logger.error('Database query error', { query: text, error: reason });
    markDatabaseUnavailable(reason);
    throw error;
  }
}

/**
 * Purpose: Persist a conversation record for a user.
 * Inputs/Outputs: userId, userMessage, aiResponse, tokensUsed, cost; writes to database.
 * Edge cases: Throws on database errors.
 */
export async function saveConversation(
  userId: string,
  userMessage: string,
  aiResponse: string,
  tokensUsed: number,
  cost: number
): Promise<void> {
  if (!ensureDatabaseReady('save conversation')) {
    //audit assumption: database unavailable; risk: lost persistence; invariant: safe return; strategy: skip write.
    return;
  }
  try {
    await query(
      'INSERT INTO conversations (user_id, user_message, ai_response, tokens_used, cost) VALUES ($1, $2, $3, $4, $5)',
      [userId, userMessage, aiResponse, tokensUsed, cost]
    );
  } catch (error) {
    //audit assumption: insert can fail; risk: lost persistence; invariant: error logged; strategy: warn and continue.
    logger.warn('Failed to save conversation', { error: normalizeDatabaseError(error) });
  }
}

/**
 * Purpose: Fetch recent conversations for a user.
 * Inputs/Outputs: userId and limit; returns array of rows.
 * Edge cases: Returns empty array if no conversations exist.
 */
export async function getRecentConversations(userId: string, limit: number = 10): Promise<any[]> {
  if (!ensureDatabaseReady('fetch recent conversations')) {
    //audit assumption: database unavailable; risk: empty history; invariant: empty list returned; strategy: return empty list.
    return [];
  }
  try {
    const result = await query(
      'SELECT * FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit]
    );
    return result.rows;
  } catch (error) {
    //audit assumption: query can fail; risk: empty history; invariant: empty list returned; strategy: warn and return empty list.
    logger.warn('Failed to fetch recent conversations', { error: normalizeDatabaseError(error) });
    return [];
  }
}

/**
 * Purpose: Persist an audit log event.
 * Inputs/Outputs: userId, eventType, eventData, ipAddress, userAgent; writes to database.
 * Edge cases: eventData is stored as JSON string.
 */
export async function logAuditEvent(
  userId: string,
  eventType: string,
  eventData: any,
  ipAddress?: string,
  userAgent?: string
): Promise<void> {
  if (!ensureDatabaseReady('log audit event')) {
    //audit assumption: database unavailable; risk: lost audit log; invariant: safe return; strategy: skip write.
    return;
  }
  try {
    await query(
      'INSERT INTO audit_logs (user_id, event_type, event_data, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [userId, eventType, JSON.stringify(eventData), ipAddress, userAgent]
    );
  } catch (error) {
    //audit assumption: insert can fail; risk: lost audit log; invariant: error logged; strategy: warn and continue.
    logger.warn('Failed to save audit event', { error: normalizeDatabaseError(error) });
  }
}

/**
 * Purpose: Fetch recent audit logs for a user.
 * Inputs/Outputs: userId and limit; returns array of rows.
 * Edge cases: Returns empty array if no logs exist.
 */
export async function getAuditLogs(userId: string, limit: number = 50): Promise<any[]> {
  if (!ensureDatabaseReady('fetch audit logs')) {
    //audit assumption: database unavailable; risk: missing audit logs; invariant: empty list returned; strategy: return empty list.
    return [];
  }
  try {
    const result = await query(
      'SELECT * FROM audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit]
    );
    return result.rows;
  } catch (error) {
    //audit assumption: query can fail; risk: missing audit logs; invariant: empty list returned; strategy: warn and return empty list.
    logger.warn('Failed to fetch audit logs', { error: normalizeDatabaseError(error) });
    return [];
  }
}

export default pool;

/**
 * Database Module
 * PostgreSQL connection and schema management
 */

import { Pool, QueryResult, QueryResultRow } from 'pg';
import { logger } from './logger';

// Create connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  logger.info('Database connection established');
});

pool.on('error', (err) => {
  //audit assumption: database errors can occur; risk: dropped connections; invariant: error logged; strategy: log error.
  logger.error('Unexpected database error', { error: err.message });
});

/**
 * Purpose: Initialize database schema for conversations and audit logs.
 * Inputs/Outputs: none; creates tables and indexes if missing.
 * Edge cases: Throws if schema creation fails.
 */
export async function initDatabase(): Promise<void> {
  const client = await pool.connect();

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
  } catch (error) {
    //audit assumption: schema creation can fail; risk: backend startup failure; invariant: error surfaced; strategy: log and rethrow.
    logger.error('Failed to initialize database', { error });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Purpose: Execute a parameterized SQL query.
 * Inputs/Outputs: SQL text and optional params; returns QueryResult.
 * Edge cases: Throws on query execution failure.
 */
export async function query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  try {
    const result = await pool.query<T>(text, params);
    return result;
  } catch (error) {
    //audit assumption: query can fail; risk: data not persisted; invariant: error surfaced; strategy: log and rethrow.
    logger.error('Database query error', { query: text, error });
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
  await query(
    'INSERT INTO conversations (user_id, user_message, ai_response, tokens_used, cost) VALUES ($1, $2, $3, $4, $5)',
    [userId, userMessage, aiResponse, tokensUsed, cost]
  );
}

/**
 * Purpose: Fetch recent conversations for a user.
 * Inputs/Outputs: userId and limit; returns array of rows.
 * Edge cases: Returns empty array if no conversations exist.
 */
export async function getRecentConversations(userId: string, limit: number = 10): Promise<any[]> {
  const result = await query(
    'SELECT * FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
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
  await query(
    'INSERT INTO audit_logs (user_id, event_type, event_data, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
    [userId, eventType, JSON.stringify(eventData), ipAddress, userAgent]
  );
}

/**
 * Purpose: Fetch recent audit logs for a user.
 * Inputs/Outputs: userId and limit; returns array of rows.
 * Edge cases: Returns empty array if no logs exist.
 */
export async function getAuditLogs(userId: string, limit: number = 50): Promise<any[]> {
  const result = await query(
    'SELECT * FROM audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
}

export default pool;

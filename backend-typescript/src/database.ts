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
  logger.error('Unexpected database error', { error: err.message });
});

/**
 * Initialize database schema
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_created_at (created_at)
      );
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_event_type (event_type),
        INDEX idx_created_at (created_at)
      );
    `);

    logger.info('Database schema initialized');
  } catch (error) {
    logger.error('Failed to initialize database', { error });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Query helper with error handling
 */
export async function query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  try {
    const result = await pool.query<T>(text, params);
    return result;
  } catch (error) {
    logger.error('Database query error', { query: text, error });
    throw error;
  }
}

/**
 * Save conversation to database
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
 * Get recent conversations for a user
 */
export async function getRecentConversations(userId: string, limit: number = 10): Promise<any[]> {
  const result = await query(
    'SELECT * FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
}

/**
 * Log audit event
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
 * Get audit logs for a user
 */
export async function getAuditLogs(userId: string, limit: number = 50): Promise<any[]> {
  const result = await query(
    'SELECT * FROM audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return result.rows;
}

export default pool;

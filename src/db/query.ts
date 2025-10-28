/**
 * Database Query Helper for ARCANOS
 * 
 * Provides enhanced query execution with caching and retry logic.
 */

import type { QueryResult } from 'pg';
import { getPool, isDatabaseConnected } from './client.js';
import { queryCache } from '../utils/cache.js';
import crypto from 'crypto';

/**
 * Creates a cache key for database queries
 */
function createQueryCacheKey(text: string, params: any[]): string {
  const content = `${text}:${JSON.stringify(params)}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Enhanced query helper with caching and optimization
 */
export async function query(text: string, params: any[] = [], attempt = 1, useCache = false): Promise<QueryResult> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured or not connected');
  }

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool not available');
  }

  // Check cache for SELECT queries
  if (useCache && text.trim().toLowerCase().startsWith('select')) {
    const cacheKey = createQueryCacheKey(text, params);
    const cachedResult = queryCache.get(cacheKey);
    if (cachedResult) {
      console.log('💾 Database cache hit for query');
      return cachedResult;
    }
  }

  const client = await pool.connect();

  try {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;

    console.log(`[🔌 DB] Query executed in ${duration}ms (rows: ${result.rowCount || 0})`);
    
    // Cache SELECT queries that return data
    if (useCache && text.trim().toLowerCase().startsWith('select') && result.rows.length > 0) {
      const cacheKey = createQueryCacheKey(text, params);
      const cacheTtl = result.rows.length < 100 ? 10 * 60 * 1000 : 5 * 60 * 1000; // Smaller results cached longer
      queryCache.set(cacheKey, result, cacheTtl);
    }

    return result;
  } catch (error) {
    console.error('[🔌 DB] Query error:', (error as Error).message);

    if (attempt < 3) {
      console.log(`[🔌 DB] Retry attempt ${attempt} for query`);
      return query(text, params, attempt + 1, useCache);
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transaction helper function
 */
export async function transaction<T>(callback: (client: any) => Promise<T>): Promise<T> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured or not connected');
  }

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool not available');
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[🔌 DB] Transaction error:', (error as Error).message);
    throw error;
  } finally {
    client.release();
  }
}

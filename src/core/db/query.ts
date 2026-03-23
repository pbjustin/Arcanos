/**
 * Database Query Helper for ARCANOS
 * 
 * Provides enhanced query execution with caching and retry logic.
 */

import type { PoolClient, QueryResult } from 'pg';
import { getPool, isDatabaseConnected } from './client.js';
import { queryCache } from "@platform/resilience/cache.js";
import crypto from 'crypto';
import { recordDependencyCall } from '@platform/observability/appMetrics.js';

/**
 * Creates a cache key for database queries
 */
function createQueryCacheKey(text: string, params: unknown[]): string {
  const content = `${text}:${JSON.stringify(params)}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

function classifySqlOperation(text: string): string {
  const normalizedText = text.trim().toLowerCase();
  if (normalizedText.startsWith('select')) {
    return 'select';
  }
  if (normalizedText.startsWith('insert')) {
    return 'insert';
  }
  if (normalizedText.startsWith('update')) {
    return 'update';
  }
  if (normalizedText.startsWith('delete')) {
    return 'delete';
  }
  if (normalizedText.startsWith('begin')) {
    return 'begin';
  }
  if (normalizedText.startsWith('commit')) {
    return 'commit';
  }
  if (normalizedText.startsWith('rollback')) {
    return 'rollback';
  }
  return 'other';
}

/**
 * Enhanced query helper with caching and optimization
 */
export async function query(text: string, params: unknown[] = [], attempt = 1, useCache = false): Promise<QueryResult> {
  const operation = classifySqlOperation(text);
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
      recordDependencyCall({
        dependency: 'postgres_cache',
        operation,
        outcome: 'hit',
        durationMs: 0,
      });
      return cachedResult;
    }
  }

  const connectStartedAtMs = Date.now();
  let client: PoolClient;
  try {
    client = await pool.connect();
    recordDependencyCall({
      dependency: 'postgres',
      operation: 'pool_connect',
      outcome: 'ok',
      durationMs: Date.now() - connectStartedAtMs,
    });
  } catch (error) {
    recordDependencyCall({
      dependency: 'postgres',
      operation: 'pool_connect',
      outcome: 'error',
      durationMs: Date.now() - connectStartedAtMs,
      error,
    });
    throw error;
  }

  try {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;

    console.log(`[🔌 DB] Query executed in ${duration}ms (rows: ${result.rowCount || 0})`);
    recordDependencyCall({
      dependency: 'postgres',
      operation,
      outcome: 'ok',
      durationMs: duration,
    });
    
    // Cache SELECT queries that return data
    if (useCache && text.trim().toLowerCase().startsWith('select') && result.rows.length > 0) {
      const cacheKey = createQueryCacheKey(text, params);
      const cacheTtl = result.rows.length < 100 ? 10 * 60 * 1000 : 5 * 60 * 1000; // Smaller results cached longer
      queryCache.set(cacheKey, result, cacheTtl);
    }

    return result;
  } catch (error) {
    console.error('[🔌 DB] Query error:', (error as Error).message);
    recordDependencyCall({
      dependency: 'postgres',
      operation,
      outcome: 'error',
      error,
    });

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
export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isDatabaseConnected()) {
    throw new Error('Database not configured or not connected');
  }

  const pool = getPool();
  if (!pool) {
    throw new Error('Database pool not available');
  }

  const connectStartedAtMs = Date.now();
  let client: PoolClient;
  try {
    client = await pool.connect();
    recordDependencyCall({
      dependency: 'postgres',
      operation: 'pool_connect',
      outcome: 'ok',
      durationMs: Date.now() - connectStartedAtMs,
    });
  } catch (error) {
    recordDependencyCall({
      dependency: 'postgres',
      operation: 'pool_connect',
      outcome: 'error',
      durationMs: Date.now() - connectStartedAtMs,
      error,
    });
    throw error;
  }
  
  try {
    const startedAtMs = Date.now();
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    recordDependencyCall({
      dependency: 'postgres',
      operation: 'transaction',
      outcome: 'ok',
      durationMs: Date.now() - startedAtMs,
    });
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[🔌 DB] Transaction error:', (error as Error).message);
    recordDependencyCall({
      dependency: 'postgres',
      operation: 'transaction',
      outcome: 'error',
      error,
    });
    throw error;
  } finally {
    client.release();
  }
}

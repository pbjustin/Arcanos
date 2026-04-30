/**
 * Database Query Helper for ARCANOS
 * 
 * Provides enhanced query execution with caching and retry logic.
 */

import type { PoolClient, QueryResult } from 'pg';
import { getPool, isDatabaseConnected } from './client.js';
import { LogLevel, dbLogger, getConfiguredLogLevel } from "@platform/logging/structuredLogging.js";
import { queryCache } from "@platform/resilience/cache.js";
import { getEnvNumber } from "@platform/runtime/env.js";
import crypto from 'crypto';
import { recordDependencyCall } from '@platform/observability/appMetrics.js';

const DEFAULT_SLOW_QUERY_LOG_MIN_MS = 250;
const SLOW_QUERY_LOG_MIN_MS = Math.max(50, getEnvNumber('DB_QUERY_LOG_MIN_MS', DEFAULT_SLOW_QUERY_LOG_MIN_MS));
const SHOULD_LOG_EVERY_QUERY = getConfiguredLogLevel() === LogLevel.DEBUG;

export interface DbQueryTraceContext {
  queryName?: string;
  source?: string;
  workerId?: string;
}

/**
 * Creates a cache key for database queries
 */
function createQueryCacheKey(text: string, params: unknown[]): string {
  const content = `${text}:${JSON.stringify(params)}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createQueryHash(text: string): string {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalizedText).digest('hex').slice(0, 12);
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

function normalizeTraceValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, 120) : undefined;
}

function normalizeQueryTraceContext(
  traceContext: DbQueryTraceContext | undefined
): Record<string, string> {
  if (!traceContext) {
    return {};
  }

  const queryName = normalizeTraceValue(traceContext.queryName);
  const source = normalizeTraceValue(traceContext.source);
  const workerId = normalizeTraceValue(traceContext.workerId);
  return {
    ...(queryName ? { queryName } : {}),
    ...(source ? { source } : {}),
    ...(workerId ? { workerId } : {})
  };
}

function getRowCount(result: QueryResult): number | null {
  return typeof result.rowCount === 'number' ? result.rowCount : null;
}

function buildSlowReasons(timings: {
  connectionAcquireMs: number;
  clientQueryRoundTripMs: number;
  appWallClockMs: number;
  thresholdMs: number;
}): string[] {
  const reasons: string[] = [];
  if (timings.connectionAcquireMs >= timings.thresholdMs) {
    reasons.push('connection_acquisition');
  }
  if (timings.clientQueryRoundTripMs >= timings.thresholdMs) {
    reasons.push('client_query_round_trip');
  }
  if (timings.appWallClockMs >= timings.thresholdMs) {
    reasons.push('app_wall_clock');
  }
  return reasons;
}

/**
 * Enhanced query helper with caching and optimization
 */
export async function query(
  text: string,
  params: unknown[] = [],
  attempt = 1,
  useCache = false,
  traceContext?: DbQueryTraceContext
): Promise<QueryResult> {
  const operation = classifySqlOperation(text);
  const queryHash = createQueryHash(text);
  const normalizedTraceContext = normalizeQueryTraceContext(traceContext);
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
      if (SHOULD_LOG_EVERY_QUERY) {
        dbLogger.debug('db.query.cache_hit', {
          ...normalizedTraceContext,
          operation,
          queryHash,
        });
      }
      recordDependencyCall({
        dependency: 'postgres_cache',
        operation,
        outcome: 'hit',
        durationMs: 0,
      });
      return cachedResult;
    }
  }

  const operationStartedAtMs = Date.now();
  const connectStartedAtMs = operationStartedAtMs;
  let connectionAcquireMs = 0;
  let client: PoolClient;
  try {
    client = await pool.connect();
    connectionAcquireMs = Date.now() - connectStartedAtMs;
    recordDependencyCall({
      dependency: 'postgres',
      operation: 'pool_connect',
      outcome: 'ok',
      durationMs: connectionAcquireMs,
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
    const queryStartedAtMs = Date.now();
    const result = await client.query(text, params);
    const completedAtMs = Date.now();
    const clientQueryRoundTripMs = completedAtMs - queryStartedAtMs;
    const appWallClockMs = completedAtMs - operationStartedAtMs;
    const slowReasons = buildSlowReasons({
      connectionAcquireMs,
      clientQueryRoundTripMs,
      appWallClockMs,
      thresholdMs: SLOW_QUERY_LOG_MIN_MS
    });
    const rowCount = getRowCount(result);
    const logContext = {
      ...normalizedTraceContext,
      operation,
      queryHash,
      durationMs: appWallClockMs,
      durationKind: 'app_wall_clock',
      measurementKind: 'client_wall_clock',
      slowThresholdMs: SLOW_QUERY_LOG_MIN_MS,
      slowReasons,
      connectionAcquireMs,
      clientQueryRoundTripMs,
      appWallClockMs,
      postgresExecutionMs: null,
      postgresExecutionKnown: false,
      postgresExecutionSource: 'not_measured_by_pg_client_query',
      rowCount,
      // Compatibility aliases for existing dashboards. Prefer the explicit fields above.
      executionMs: clientQueryRoundTripMs,
      poolWaitMs: connectionAcquireMs,
      totalMs: appWallClockMs,
    };

    if (slowReasons.length > 0) {
      dbLogger.warn('db.query.slow', logContext);
    } else if (SHOULD_LOG_EVERY_QUERY) {
      dbLogger.debug('db.query.executed', logContext);
    }
    recordDependencyCall({
      dependency: 'postgres',
      operation,
      outcome: 'ok',
      durationMs: clientQueryRoundTripMs,
    });
    
    // Cache SELECT queries that return data
    if (useCache && text.trim().toLowerCase().startsWith('select') && result.rows.length > 0) {
      const cacheKey = createQueryCacheKey(text, params);
      const cacheTtl = result.rows.length < 100 ? 10 * 60 * 1000 : 5 * 60 * 1000; // Smaller results cached longer
      queryCache.set(cacheKey, result, cacheTtl);
    }

    return result;
  } catch (error) {
    dbLogger.error('db.query.error', {
      ...normalizedTraceContext,
      operation,
      queryHash,
      attempt,
    }, {
      message: (error as Error).message,
    }, error as Error);
    recordDependencyCall({
      dependency: 'postgres',
      operation,
      outcome: 'error',
      error,
    });

    if (attempt < 3) {
      dbLogger.warn('db.query.retry', {
        ...normalizedTraceContext,
        operation,
        queryHash,
        attempt,
      }, {
        nextAttempt: attempt + 1,
      });
      return query(text, params, attempt + 1, useCache, traceContext);
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
    dbLogger.error('db.transaction.error', {
      operation: 'transaction',
    }, {
      message: (error as Error).message,
    }, error as Error);
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

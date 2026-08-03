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
import {
  matchesAuditedTransientReadQuery,
  type AuditedTransientReadQueryId
} from './transientReadRegistry.js';

const DEFAULT_SLOW_QUERY_LOG_MIN_MS = 250;
const SLOW_QUERY_LOG_MIN_MS = Math.max(50, getEnvNumber('DB_QUERY_LOG_MIN_MS', DEFAULT_SLOW_QUERY_LOG_MIN_MS));
const SHOULD_LOG_EVERY_QUERY = getConfiguredLogLevel() === LogLevel.DEBUG;
const MAX_TRANSIENT_READ_ATTEMPTS = 3;
const TRANSIENT_READ_SQLSTATES = new Set([
  '08000',
  '08001',
  '08003',
  '08006',
  '08007',
  '40001',
  '40P01',
  '55P03',
  '57P01',
  '57P02',
  '57P03'
]);

export interface DbQueryTraceContext {
  queryName?: string;
  source?: string;
  workerId?: string;
}

interface DbQueryBaseOptions {
  useCache?: boolean;
  traceContext?: DbQueryTraceContext;
}

export type DbQueryOptions = DbQueryBaseOptions & (
  | {
      retry?: undefined;
      idempotent?: never;
    }
  | {
      retry: 'transient-read';
      idempotent: true;
      auditedQueryId: AuditedTransientReadQueryId;
    }
);

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

function getSqlState(error: unknown): string | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    typeof (error as { code?: unknown }).code !== 'string'
  ) {
    return null;
  }

  const code = (error as { code: string }).code.trim().toUpperCase();
  return /^[0-9A-Z]{5}$/u.test(code) ? code : null;
}

type DbQueryErrorCategory =
  | 'transient_sqlstate'
  | 'non_transient_sqlstate'
  | 'unclassified';

function classifyDbQueryError(
  sqlState: string | null,
  allowlistedSqlState: string | null
): DbQueryErrorCategory {
  if (allowlistedSqlState) {
    return 'transient_sqlstate';
  }
  return sqlState ? 'non_transient_sqlstate' : 'unclassified';
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
  options: DbQueryOptions = {}
): Promise<QueryResult> {
  const operation = classifySqlOperation(text);
  const queryHash = createQueryHash(text);
  const normalizedTraceContext = normalizeQueryTraceContext(options.traceContext);
  const retryTransientRead = options.retry === 'transient-read';
  const useCache = options.useCache === true;

  if (
    retryTransientRead &&
    (
      options.idempotent !== true ||
      !matchesAuditedTransientReadQuery(options.auditedQueryId, text)
    )
  ) {
    throw new TypeError(
      'Database transient-read retries require an exact audited idempotent read query.'
    );
  }

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

  for (let attempt = 1; attempt <= MAX_TRANSIENT_READ_ATTEMPTS; attempt += 1) {
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
        durationMs: clientQueryRoundTripMs,
        durationKind: 'client_query_round_trip',
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
      const sqlState = getSqlState(error);
      const allowlistedSqlState =
        sqlState !== null && TRANSIENT_READ_SQLSTATES.has(sqlState)
          ? sqlState
          : null;
      const errorCategory = classifyDbQueryError(sqlState, allowlistedSqlState);
      const shouldRetry =
        retryTransientRead &&
        attempt < MAX_TRANSIENT_READ_ATTEMPTS &&
        allowlistedSqlState !== null;
      dbLogger.error('db.query.error', {
        attempt,
        maxAttempts: retryTransientRead ? MAX_TRANSIENT_READ_ATTEMPTS : 1,
        errorCategory,
        ...(allowlistedSqlState ? { sqlState: allowlistedSqlState } : {})
      });
      recordDependencyCall({
        dependency: 'postgres',
        operation,
        outcome: 'error',
      });

      if (shouldRetry) {
        dbLogger.warn('db.query.retry', {
          attempt,
          sqlState: allowlistedSqlState,
          errorCategory,
          maxAttempts: MAX_TRANSIENT_READ_ATTEMPTS,
        });
        continue;
      }

      throw error;
    } finally {
      client.release();
    }
  }

  throw new Error('Database query exhausted its retry policy.');
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
  let clientReleaseError: Error | undefined;
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
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError: unknown) {
      const normalizedRollbackError = rollbackError instanceof Error
        ? rollbackError
        : new Error('Unknown transaction rollback failure');
      clientReleaseError = normalizedRollbackError;
      dbLogger.error('db.transaction.rollback_failed', {
        operation: 'transaction',
      }, {
        message: normalizedRollbackError.message,
      }, normalizedRollbackError);
    }
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
    client.release(clientReleaseError);
  }
}

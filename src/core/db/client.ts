#!/usr/bin/env node
/**
 * Database Client Module for ARCANOS
 * 
 * Handles PostgreSQL connection pool management and initialization.
 * Provides connection pooling with optimized settings for production.
 */

import pkg from 'pg';
import type { Pool as PoolType } from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

let pool: PoolType | null = null;
let isConnected = false;
let connectionError: Error | null = null;

const RAILWAY_PRIVATE_HOST_SUFFIX = '.railway.internal';

const trackedEnvVars = [
  'DATABASE_URL',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'PGDATA',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPORT',
  'PGUSER',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER'
];

const normalizeEnvValue = (value?: string | null): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null') {
    return undefined;
  }

  return trimmed;
};

const sanitizeTrackedEnvVars = (): void => {
  trackedEnvVars.forEach(key => {
    const normalized = normalizeEnvValue(process.env[key]);
    if (normalized === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = normalized;
    }
  });
};

export interface DatabaseStatus {
  connected: boolean;
  hasPool: boolean;
  error: string | null;
}

interface DatabaseConnectionCandidate {
  connectionString: string;
  source: 'database_private_url' | 'database_url' | 'database_public_url';
  shouldUseSsl: boolean;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1';
}

function extractHostnameFromConnectionString(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname || null;
  } catch {
    return null;
  }
}

function shouldUseSslForConnectionString(connectionString: string): boolean {
  const hostname = extractHostnameFromConnectionString(connectionString);
  return Boolean(hostname && !isLoopbackHost(hostname));
}

function normalizeDatabaseConnectionString(connectionString: string): string {
  const normalizedConnectionString = connectionString.trim();
  const hostname = extractHostnameFromConnectionString(normalizedConnectionString);

  //audit Assumption: non-local PostgreSQL targets should negotiate SSL unless the URL already declares its mode; failure risk: Railway and hosted Postgres connections fail with transport errors; expected invariant: remote URLs carry an explicit sslmode; handling strategy: append `sslmode=require` only when the host is not loopback and the query string does not already define it.
  if (hostname && !isLoopbackHost(hostname) && !normalizedConnectionString.includes('sslmode=')) {
    return normalizedConnectionString.includes('?')
      ? `${normalizedConnectionString}&sslmode=require`
      : `${normalizedConnectionString}?sslmode=require`;
  }

  return normalizedConnectionString;
}

/**
 * Resolve database connection candidates from the current environment.
 *
 * Purpose:
 * - Prefer the private Railway database URL in service runtime while exposing a public fallback for local CLI usage.
 *
 * Inputs/outputs:
 * - Input: process environment variables.
 * - Output: ordered connection candidates with normalized SSL behavior.
 *
 * Edge case behavior:
 * - Returns an empty list when neither a URL nor discrete PG variables are available.
 */
export function resolveDatabaseConnectionCandidates(
  env: NodeJS.ProcessEnv = process.env
): DatabaseConnectionCandidate[] {
  const configuredDatabasePrivateUrl = normalizeEnvValue(env.DATABASE_PRIVATE_URL);
  const configuredDatabaseUrl = normalizeEnvValue(env.DATABASE_URL);
  const configuredDatabasePublicUrl = normalizeEnvValue(env.DATABASE_PUBLIC_URL);
  let synthesizedDatabaseUrl = configuredDatabaseUrl;

  //audit Assumption: legacy environments may still provide discrete PG variables instead of DATABASE_URL; failure risk: valid Postgres credentials are ignored and the service reports a false-negative outage; expected invariant: one normalized primary connection string is produced when the required PG vars exist; handling strategy: synthesize DATABASE_URL from the discrete variables only when DATABASE_URL is absent.
  if (!synthesizedDatabaseUrl) {
    const required = ['PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'] as const;
    const resolved = required.map(key => ({ key, value: normalizeEnvValue(env[key]) }));
    const missing = resolved.filter(entry => !entry.value).map(entry => entry.key);
    if (missing.length > 0) {
      return [];
    }

    const credentials = Object.fromEntries(
      resolved.map(entry => [entry.key, entry.value])
    ) as Record<typeof required[number], string>;
    synthesizedDatabaseUrl = `postgresql://${credentials.PGUSER}:${credentials.PGPASSWORD}@${credentials.PGHOST}:${credentials.PGPORT}/${credentials.PGDATABASE}`;
  }

  const candidates: DatabaseConnectionCandidate[] = [];

  //audit Assumption: Railway services benefit from a dedicated private connection string while local CLI flows need a public URL; failure risk: callers only ever try the public proxy or only ever try the private hostname; expected invariant: candidates are ordered from most preferred to safest fallback; handling strategy: prepend DATABASE_PRIVATE_URL when configured, then append the public-facing URLs without duplicates.
  if (configuredDatabasePrivateUrl) {
    candidates.push({
      connectionString: normalizeDatabaseConnectionString(configuredDatabasePrivateUrl),
      source: 'database_private_url',
      shouldUseSsl: shouldUseSslForConnectionString(configuredDatabasePrivateUrl)
    });
  }

  if (synthesizedDatabaseUrl) {
    candidates.push({
      connectionString: normalizeDatabaseConnectionString(synthesizedDatabaseUrl),
      source: 'database_url',
      shouldUseSsl: shouldUseSslForConnectionString(synthesizedDatabaseUrl)
    });
  }

  if (
    configuredDatabasePublicUrl &&
    configuredDatabasePublicUrl !== synthesizedDatabaseUrl &&
    configuredDatabasePublicUrl !== configuredDatabasePrivateUrl
  ) {
    candidates.push({
      connectionString: normalizeDatabaseConnectionString(configuredDatabasePublicUrl),
      source: 'database_public_url',
      shouldUseSsl: shouldUseSslForConnectionString(configuredDatabasePublicUrl)
    });
  }

  return candidates;
}

function shouldRetryWithPublicDatabaseUrl(
  error: unknown,
  candidate: DatabaseConnectionCandidate,
  fallbackCandidate: DatabaseConnectionCandidate | undefined
): boolean {
  const errorCode =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  const hostname = extractHostnameFromConnectionString(candidate.connectionString);

  //audit Assumption: local CLI processes cannot resolve Railway private DNS names; failure risk: DB bootstrap fails permanently even though a public proxy URL is configured; expected invariant: ENOTFOUND on a `.railway.internal` host should fall back once to the public URL; handling strategy: retry only for the private-host resolution failure and only when a public candidate exists.
  return (
    errorCode === 'ENOTFOUND' &&
    (candidate.source === 'database_private_url' || candidate.source === 'database_url') &&
    Boolean(fallbackCandidate) &&
    Boolean(hostname && hostname.endsWith(RAILWAY_PRIVATE_HOST_SUFFIX))
  );
}

async function closePoolSafely(activePool: PoolType): Promise<void> {
  try {
    await activePool.end();
  } catch (closeError) {
    console.error('[🔌 DB] Failed to close pool:', closeError);
  }
}

function registerPoolErrorHandler(activePool: PoolType, workerId: string): void {
  activePool.on('error', (err: Error) => {
    console.error('[🔌 DB] Unexpected error on idle client', err);
    isConnected = false;
    connectionError = err;

    //audit Assumption: idle client failures leave the current pool unsafe for reuse; failure risk: future queries continue using broken connections; expected invariant: the active pool is closed and global state is cleared before reconnect; handling strategy: close the failing pool, null the shared reference, and trigger lazy reinitialization.
    closePoolSafely(activePool).catch(closeError => {
      console.error('[🔌 DB] Failed to close pool after error:', closeError);
    });
    if (pool === activePool) {
      pool = null;
    }

    setTimeout(() => {
      initializeDatabase(workerId).catch(reconnectErr =>
        console.error('[🔌 DB] Reconnection attempt failed:', reconnectErr)
      );
    }, 5000);
  });
}

/**
 * Initialize database connection pool and verify connectivity
 * 
 * Sets up a PostgreSQL connection pool with optimized settings for ARCANOS:
 * - SSL configuration based on environment (localhost vs production)
 * - Connection pooling for efficient resource usage
 * - Graceful handling of missing DATABASE_URL
 * - Automatic reconnection on connection loss
 * 
 * @returns Promise<boolean> - True if database initialized successfully, false otherwise
 */
export async function initializeDatabase(workerId = ''): Promise<boolean> {
  // Ensure all expected environment variables are clean
  sanitizeTrackedEnvVars();
  const connectionCandidates = resolveDatabaseConnectionCandidates(process.env);

  if (connectionCandidates.length === 0) {
    const required = ['PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'] as const;
    const missing = required.filter(key => !normalizeEnvValue(process.env[key]));
    if (missing.length > 0 && !normalizeEnvValue(process.env.DATABASE_URL)) {
      console.error('[🔌 DB] Missing environment variables:', missing.join(', '));
    }
    return false;
  }

  console.log('[🔌 DB] Initializing PostgreSQL connection pool...');

  for (let index = 0; index < connectionCandidates.length; index += 1) {
    const connectionCandidate = connectionCandidates[index];
    const fallbackCandidate = connectionCandidates[index + 1];
    const nextPool = new Pool({
      connectionString: connectionCandidate.connectionString,
      ...(connectionCandidate.shouldUseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 10,
      min: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    try {
      registerPoolErrorHandler(nextPool, workerId);
      await nextPool.query('SELECT 1');

      pool = nextPool;
      isConnected = true;
      connectionError = null;
      process.env.DATABASE_URL = connectionCandidate.connectionString;
      console.log(
        connectionCandidate.source === 'database_public_url'
          ? 'DB connection successful via DATABASE_PUBLIC_URL'
          : 'DB connection successful'
      );

      return true;
    } catch (error) {
      await closePoolSafely(nextPool);

      if (shouldRetryWithPublicDatabaseUrl(error, connectionCandidate, fallbackCandidate)) {
        console.warn(
          '[🔌 DB] Private Railway hostname was unreachable; retrying with DATABASE_PUBLIC_URL.'
        );
        continue;
      }

      connectionError = error as Error;
      isConnected = false;
      console.error('[🔌 DB] Connection failed:', (error as Error).message);
      return false;
    }
  }

  return false;
}

/**
 * Get the database connection pool
 */
export function getPool(): PoolType | null {
  return pool;
}

/**
 * Check if database is connected
 */
export function isDatabaseConnected(): boolean {
  return isConnected;
}

/**
 * Get database status
 */
export function getStatus(): DatabaseStatus {
  return {
    connected: isConnected,
    hasPool: pool !== null,
    error: connectionError?.message || null
  };
}

/**
 * Close database connection
 */
export async function close(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    isConnected = false;
    console.log('[🔌 DB] Connection pool closed');
  }
}

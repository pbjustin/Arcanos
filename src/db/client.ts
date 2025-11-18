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

const trackedEnvVars = [
  'DATABASE_URL',
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

  let databaseUrl = normalizeEnvValue(process.env.DATABASE_URL) || '';

  // Construct DATABASE_URL if not provided
  if (!databaseUrl) {
    const required = ['PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'] as const;
    const resolved = required.map(key => ({ key, value: normalizeEnvValue(process.env[key]) }));
    const missing = resolved.filter(entry => !entry.value).map(entry => entry.key);
    if (missing.length) {
      console.error('[🔌 DB] Missing environment variables:', missing.join(', '));
      return false;
    }
    const credentials = Object.fromEntries(
      resolved.map(entry => [entry.key, entry.value])
    ) as Record<typeof required[number], string>;

    const portNumber = Number(credentials.PGPORT);
    if (!Number.isFinite(portNumber)) {
      console.error('[🔌 DB] Invalid PGPORT value:', credentials.PGPORT);
      return false;
    }

    databaseUrl = `postgresql://${credentials.PGUSER}:${credentials.PGPASSWORD}@${credentials.PGHOST}:${credentials.PGPORT}/${credentials.PGDATABASE}`;
    process.env.DATABASE_URL = databaseUrl;
  }

  // Enforce SSL when not connecting to localhost
  const host = normalizeEnvValue(process.env.PGHOST) || 'localhost';
  if (host !== 'localhost' && host !== '127.0.0.1' && !databaseUrl.includes('sslmode=')) {
    databaseUrl += databaseUrl.includes('?') ? '&sslmode=require' : '?sslmode=require';
    process.env.DATABASE_URL = databaseUrl;
  }

  console.log('[🔌 DB] Initializing PostgreSQL connection pool...');

  try {
    const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.PGHOST;
    pool = new Pool({
      connectionString: databaseUrl,
      ...(isRailway ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 10,
      min: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // Handle unexpected errors to prevent crashes and enable automatic reconnection
    pool.on('error', (err: Error) => {
      console.error('[🔌 DB] Unexpected error on idle client', err);
      isConnected = false;
      // Clean up broken pool and attempt reinitialization after short delay
      pool?.end().catch(() => {});
      pool = null;
      setTimeout(() => {
        initializeDatabase(workerId).catch(reconnectErr =>
          console.error('[🔌 DB] Reconnection attempt failed:', reconnectErr)
        );
      }, 5000);
    });

    await pool.query('SELECT 1');
    isConnected = true;
    console.log('DB connection successful');

    return true;
  } catch (error) {
    connectionError = error as Error;
    isConnected = false;
    console.error('[🔌 DB] Connection failed:', (error as Error).message);
    return false;
  }
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

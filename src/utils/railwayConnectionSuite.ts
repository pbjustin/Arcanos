import type { Request, Response } from 'express';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import Redis from 'ioredis';
import type { Redis as RedisClient, RedisOptions } from 'ioredis';
import { URL } from 'node:url';

type Nullable<T> = T | null;

type RedisConstructor = new (url: string, options?: RedisOptions) => RedisClient;

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

type ServiceHealth = {
  configured: boolean;
  healthy: boolean;
  error: string | null;
};

const log = (msg: string): void => {
  console.log(`[${new Date().toISOString()}] ${msg}`);
};

const requiredPostgresEnv = ['PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGPORT'] as const;

function resolvePostgresConnectionString(): string | null {
  const directUrl =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PG_CONNECTION_STRING ||
    null;

  if (directUrl) {
    return directUrl;
  }

  const hasAllDiscreteEnv = requiredPostgresEnv.every((key) => Boolean(process.env[key]));
  if (!hasAllDiscreteEnv) {
    return null;
  }

  const { PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE } = process.env;
  const user = encodeURIComponent(PGUSER ?? '');
  const password = encodeURIComponent(PGPASSWORD ?? '');
  const host = PGHOST ?? 'localhost';
  const port = PGPORT ?? '5432';
  const database = encodeURIComponent(PGDATABASE ?? '');
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

const enforceStrictConnectivity = Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === 'production';

let postgresConfigured = false;

function parsePoolMax(): number {
  const { PG_POOL_MAX } = process.env;
  if (!PG_POOL_MAX) {
    return 8;
  }
  const parsed = Number(PG_POOL_MAX);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log(`[POSTGRES] Invalid PG_POOL_MAX value "${PG_POOL_MAX}" — falling back to 8`);
    return 8;
  }
  return parsed;
}

function shouldUsePostgresSSL(connectionString: string | null): boolean {
  if (process.env.PGSSLMODE === 'require') {
    return true;
  }

  if (!connectionString) {
    return Boolean(process.env.RAILWAY_ENVIRONMENT);
  }

  if (/sslmode=require/.test(connectionString)) {
    return true;
  }

  try {
    const url = new URL(connectionString);
    return !['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function createPostgresPool(): Nullable<Pool> {
  const connectionString = resolvePostgresConnectionString();
  const hasAnyPostgresConfig = Boolean(connectionString) || requiredPostgresEnv.some((key) => Boolean(process.env[key]));
  const missing = requiredPostgresEnv.filter((key) => !process.env[key]);

  postgresConfigured = hasAnyPostgresConfig;

  if (!hasAnyPostgresConfig) {
    log('[POSTGRES] No connection configuration detected — skipping PostgreSQL initialization');
    return null;
  }

  if (!connectionString && missing.length > 0) {
    const message = `[POSTGRES] Missing environment variables: ${missing.join(', ')}`;
    if (enforceStrictConnectivity) {
      throw new Error(message);
    }
    log(`${message} — skipping PostgreSQL initialization`);
    return null;
  }

  const config: PoolConfig = {
    max: parsePoolMax(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(connectionString ? { connectionString } : {}),
  };

  if (shouldUsePostgresSSL(connectionString)) {
    config.ssl = { rejectUnauthorized: false };
  }

  const pool = new Pool(config);
  pool.on('connect', () => log('[POSTGRES] Connected'));
  pool.on('error', (err) => log(`[POSTGRES] Idle client error: ${err.message}`));

  return pool;
}

let postgres: Nullable<Pool> = null;
try {
  postgres = createPostgresPool();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(message);
  if (enforceStrictConnectivity) {
    throw error;
  }
}

async function verifyPostgres(): Promise<void> {
  if (!postgres) {
    if (!postgresConfigured) {
      log('[POSTGRES] Skipping connection test (not configured)');
      return;
    }

    if (enforceStrictConnectivity) {
      throw new Error('[POSTGRES] Pool unavailable during startup validation');
    }
    log('[POSTGRES] Skipping connection test (pool not initialized)');
    return;
  }

  try {
    await postgres.query('SELECT 1');
    log('[POSTGRES] Connection test successful');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[POSTGRES] Connection test failed: ${message}`);
    throw err instanceof Error ? err : new Error(message);
  }
}

let redisConfigured = false;
let redis: Nullable<RedisClient> = null;
let redisReady = false;
let redisBootTimeout: NodeJS.Timeout | null = null;

function createRedisClient(): Nullable<RedisClient> {
  const redisUrl = process.env.REDIS_URL;
  redisConfigured = Boolean(redisUrl);
  if (!redisUrl) {
    log('[REDIS] REDIS_URL not set — skipping Redis initialization');
    return null;
  }

  const RedisCtor = Redis as unknown as RedisConstructor;
  const options: RedisOptions = {
    retryStrategy: (attempt: number) => {
      const maxAttempts = 10;
      if (attempt > maxAttempts) {
        return null;
      }
      const delay = Math.min(1000 * 2 ** attempt, 15_000);
      log(`[REDIS] Retry ${attempt}, waiting ${delay}ms`);
      return delay;
    },
    enableReadyCheck: true,
    connectTimeout: 5_000,
    tls:
      redisUrl.startsWith('rediss://') &&
      process.env.REDIS_TLS_REJECT_UNAUTHORIZED === '0'
        ? { rejectUnauthorized: false }
        : undefined,
  };

  const client = new RedisCtor(redisUrl, options);

  client.on('ready', () => {
    redisReady = true;
    log('[REDIS] Ready');
  });

  client.on('error', (err: Error) => log(`[REDIS] Error: ${err.message}`));

  client.on('close', () => {
    redisReady = false;
    log('[REDIS] Connection closed');
  });

  redisBootTimeout = setTimeout(() => {
    if (!redisReady) {
      const message = '[REDIS] Boot timeout — exiting process';
      log(message);
      if (enforceStrictConnectivity) {
        process.exit(1);
      }
    }
  }, 60_000);

  client.once('ready', () => {
    if (redisBootTimeout) {
      clearTimeout(redisBootTimeout);
      redisBootTimeout = null;
    }
  });

  return client;
}

try {
  redis = createRedisClient();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(message);
  if (enforceStrictConnectivity) {
    throw error;
  }
}

async function verifyRedis(): Promise<void> {
  if (!redis) {
    if (!redisConfigured) {
      log('[REDIS] Skipping connection test (not configured)');
      return;
    }

    if (enforceStrictConnectivity) {
      throw new Error('[REDIS] Client unavailable during startup validation');
    }
    log('[REDIS] Skipping connection test (client not initialized)');
    return;
  }

  try {
    await redis.ping();
    log('✅ Redis connection test successful');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[REDIS] Connection test failed: ${message}`);
    throw err instanceof Error ? err : new Error(message);
  }
}

(async () => {
  if (!enforceStrictConnectivity) {
    log('🔍 Startup connectivity validation skipped (non-strict environment)');
    return;
  }

  try {
    log('🔍 Running startup connectivity validation...');
    await verifyPostgres();
    await verifyRedis();
    log('🚀 Environment checks passed. Booting main server...');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`❌ Startup validation failed: ${message}`);
    process.exit(1);
  }
})();

function summarizeService(configured: boolean, healthy: boolean, error: string | null): ServiceHealth {
  return { configured, healthy, error };
}

export async function railwayHealthCheck(req: Request, res: Response): Promise<void> {
  const postgresHealth: ServiceHealth = summarizeService(postgresConfigured, false, null);
  const redisHealth: ServiceHealth = summarizeService(redisConfigured, false, null);

  try {
    if (postgres) {
      await postgres.query('SELECT 1');
      postgresHealth.healthy = true;
    } else if (!postgresConfigured) {
      postgresHealth.error = 'PostgreSQL not configured';
      postgresHealth.healthy = !enforceStrictConnectivity;
    } else {
      postgresHealth.error = 'PostgreSQL configured but pool unavailable';
    }
  } catch (error) {
    postgresHealth.error = error instanceof Error ? error.message : String(error);
  }

  try {
    if (redis) {
      await redis.ping();
      redisHealth.healthy = true;
    } else if (!redisConfigured) {
      redisHealth.error = 'Redis not configured';
      redisHealth.healthy = !enforceStrictConnectivity;
    } else {
      redisHealth.error = 'Redis configured but client unavailable';
    }
  } catch (error) {
    redisHealth.error = error instanceof Error ? error.message : String(error);
  }

  const hasAnyIssues = !postgresHealth.healthy || !redisHealth.healthy;
  const hasConfiguredFailures =
    (postgresHealth.configured && !postgresHealth.healthy) ||
    (redisHealth.configured && !redisHealth.healthy);

  let status: HealthStatus = 'healthy';
  if (hasAnyIssues) {
    status = hasConfiguredFailures ? 'unhealthy' : 'degraded';
  }

  const httpStatus = hasConfiguredFailures && enforceStrictConnectivity ? 500 : 200;

  res.status(httpStatus).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      postgres: postgresHealth,
      redis: redisHealth,
    },
  });
}

export { postgres, redis, log, enforceStrictConnectivity };

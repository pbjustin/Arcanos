import type { Request, Response } from 'express';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import Redis from 'ioredis';
import type { Redis as RedisClient, RedisOptions } from 'ioredis';

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

const enforceStrictConnectivity = Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === 'production';

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

function createPostgresPool(): Nullable<Pool> {
  const missing = requiredPostgresEnv.filter((key) => !process.env[key]);
  if (missing.length > 0) {
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
  };

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

let redis: Nullable<RedisClient> = null;
let redisReady = false;
let redisBootTimeout: NodeJS.Timeout | null = null;

function createRedisClient(): Nullable<RedisClient> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    if (enforceStrictConnectivity) {
      throw new Error('[REDIS] REDIS_URL is not set');
    }
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
  const postgresHealth: ServiceHealth = summarizeService(Boolean(postgres), false, null);
  const redisHealth: ServiceHealth = summarizeService(Boolean(redis), false, null);

  try {
    if (postgres) {
      await postgres.query('SELECT 1');
      postgresHealth.healthy = true;
    } else {
      postgresHealth.error = 'PostgreSQL not configured';
      postgresHealth.healthy = !enforceStrictConnectivity;
    }
  } catch (error) {
    postgresHealth.error = error instanceof Error ? error.message : String(error);
  }

  try {
    if (redis) {
      await redis.ping();
      redisHealth.healthy = true;
    } else {
      redisHealth.error = 'Redis not configured';
      redisHealth.healthy = !enforceStrictConnectivity;
    }
  } catch (error) {
    redisHealth.error = error instanceof Error ? error.message : String(error);
  }

  let status: HealthStatus = 'healthy';
  if (!postgresHealth.healthy || !redisHealth.healthy) {
    status = enforceStrictConnectivity ? 'unhealthy' : 'degraded';
  }

  const httpStatus = status === 'healthy' ? 200 : enforceStrictConnectivity ? 500 : 200;

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

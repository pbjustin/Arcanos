import { createClient } from 'redis';
import { logger } from '@platform/logging/structuredLogging.js';
import { resolveConfiguredRedisConnection } from '@platform/runtime/redis.js';
import {
  DependencyLifecycle,
  DependencyUnavailableError,
  type DependencyLifecycleAdapter,
  type DependencyLifecycleEvent,
  type DependencyLifecycleSleep,
  type DependencyLifecycleState,
} from '@platform/runtime/dependencyLifecycle.js';

const REDIS_ATTEMPT_TIMEOUT_MS = 3_000;
const REDIS_RETRY_BASE_DELAY_MS = 250;
const REDIS_RETRY_MAX_DELAY_MS = 30_000;
const REDIS_RETRY_JITTER_MS = 250;
const REDIS_OPERATION_TIMEOUT_MS = 2_000;

export type RedisLifecycleState = DependencyLifecycleState;

export type RedisLifecycleErrorCode =
  | 'REDIS_CONNECTION_REFUSED'
  | 'REDIS_CONNECT_TIMEOUT'
  | 'REDIS_CONFIGURATION_INVALID'
  | 'REDIS_AUTH_FAILED'
  | 'REDIS_DNS_UNAVAILABLE'
  | 'REDIS_CONNECTION_LOST'
  | 'REDIS_OPERATION_TIMEOUT'
  | 'REDIS_UNAVAILABLE';

export interface RedisLifecycleSnapshot {
  state: RedisLifecycleState;
  configured: boolean;
  connected: boolean;
  attempt: number;
  recoveryCount: number;
  retryScheduled: boolean;
  lastTransitionAt: string;
  lastReadyAt: string | null;
  lastErrorCode: RedisLifecycleErrorCode | null;
}

export type RedisLifecycleClient = ReturnType<typeof createClient>;
export type RedisLifecycleListener = (snapshot: RedisLifecycleSnapshot) => void;
export type RedisLifecycleSleep = DependencyLifecycleSleep;
export type RedisLifecycleClientFactory = (
  options: Parameters<typeof createClient>[0]
) => RedisLifecycleClient;

export interface RedisLifecycleManagerOptions {
  clientFactory?: RedisLifecycleClientFactory;
  sleep?: RedisLifecycleSleep;
  random?: () => number;
  now?: () => Date;
}

export interface RedisOperationOptions {
  client?: RedisLifecycleClient;
  timeoutMs?: number;
}

function createRedisDependencyUnavailableError(): DependencyUnavailableError {
  return new DependencyUnavailableError(
    'redis',
    'REDIS_DEPENDENCY_UNAVAILABLE',
    'Redis dependency is unavailable.'
  );
}

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toUpperCase();
  }

  return typeof error === 'string' ? error.toUpperCase() : '';
}

function normalizeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

function classifyRedisLifecycleError(error: unknown): RedisLifecycleErrorCode {
  const code = normalizeErrorCode(error);
  const message = normalizeErrorText(error);

  if (code === 'WRONGPASS' || code === 'NOAUTH' || message.includes('WRONGPASS') || message.includes('NOAUTH')) {
    return 'REDIS_AUTH_FAILED';
  }

  if (code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
    return 'REDIS_CONNECTION_REFUSED';
  }

  if (code === 'REDIS_CONFIGURATION_INVALID') {
    return 'REDIS_CONFIGURATION_INVALID';
  }

  if (code === 'REDIS_OPERATION_TIMEOUT') {
    return 'REDIS_OPERATION_TIMEOUT';
  }

  if (
    code === 'ETIMEDOUT'
    || code === 'DEPENDENCY_ATTEMPT_TIMEOUT'
    || message.includes('CONNECTION TIMEOUT')
    || message.includes('TIMED OUT')
  ) {
    return 'REDIS_CONNECT_TIMEOUT';
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) {
    return 'REDIS_DNS_UNAVAILABLE';
  }

  if (
    code === 'ECONNRESET'
    || code === 'EPIPE'
    || code === 'REDIS_CONNECTION_LOST'
    || message.includes('SOCKET CLOSED')
    || message.includes('CONNECTION LOST')
  ) {
    return 'REDIS_CONNECTION_LOST';
  }

  return 'REDIS_UNAVAILABLE';
}

function projectRedisSnapshot(
  snapshot: ReturnType<DependencyLifecycle<RedisLifecycleClient, RedisLifecycleErrorCode>['getSnapshot']>
): RedisLifecycleSnapshot {
  return {
    state: snapshot.state,
    configured: snapshot.configured,
    connected: snapshot.ready,
    attempt: snapshot.attempt,
    recoveryCount: snapshot.recoveryCount,
    retryScheduled: snapshot.retryScheduled,
    lastTransitionAt: snapshot.lastTransitionAt,
    lastReadyAt: snapshot.lastReadyAt,
    lastErrorCode: snapshot.lastErrorCode
  };
}

function reportRedisLifecycleEvent(event: DependencyLifecycleEvent<RedisLifecycleErrorCode>): void {
  if (event.kind === 'ready') {
    logger.info('redis.lifecycle.ready', {
      module: 'redis-lifecycle',
      recovered: event.recovered,
      attempt: event.attempt
    });
    return;
  }

  if (event.kind === 'retry_scheduled') {
    logger.warn('redis.lifecycle.retry_scheduled', {
      module: 'redis-lifecycle',
      operation: event.operation,
      errorCode: event.errorCode,
      attempt: event.attempt,
      retryDelayMs: event.retryDelayMs
    });
    return;
  }

  if (event.kind === 'unavailable') {
    logger.warn('redis.lifecycle.connection_lost', {
      module: 'redis-lifecycle',
      errorCode: event.errorCode
    });
    return;
  }

  logger.warn('redis.lifecycle.listener_failed', {
    module: 'redis-lifecycle',
    errorCode: 'REDIS_LIFECYCLE_LISTENER_FAILED'
  });
}

/**
 * Redis adapter for the reusable dependency lifecycle.
 *
 * URL resolution, node-redis events, PING validation, and Redis-specific error
 * classification stay here; retry, state, timer, and shutdown mechanics live in
 * the dependency lifecycle runner.
 */
export class RedisLifecycleManager {
  private readonly lifecycle: DependencyLifecycle<RedisLifecycleClient, RedisLifecycleErrorCode>;
  private activeOperationCount = 0;

  constructor(options: RedisLifecycleManagerOptions = {}) {
    const clientFactory = options.clientFactory ?? ((clientOptions) => createClient(clientOptions));
    const adapter: DependencyLifecycleAdapter<RedisLifecycleClient, RedisLifecycleErrorCode> = {
      resolve: () => {
        const redisConnection = resolveConfiguredRedisConnection();
        if (!redisConnection.configured) {
          return { configured: false };
        }

        if (!redisConnection.url) {
          return {
            configured: true,
            createResource: () => {
              throw Object.assign(new Error('Redis configuration is invalid.'), {
                code: 'REDIS_CONFIGURATION_INVALID'
              });
            }
          };
        }

        const redisUrl = redisConnection.url;
        return {
          configured: true,
          createResource: () => clientFactory({
            url: redisUrl,
            disableOfflineQueue: true,
            socket: {
              connectTimeout: REDIS_ATTEMPT_TIMEOUT_MS,
              reconnectStrategy: false
            }
          })
        };
      },
      connect: async (client) => {
        if (!client.isOpen) {
          await client.connect();
        }
      },
      validate: async (client) => {
        const pingResponse = await client.ping();
        if (pingResponse !== 'PONG') {
          throw Object.assign(new Error('Unexpected Redis readiness response.'), {
            code: 'REDIS_UNEXPECTED_RESPONSE'
          });
        }
      },
      isReady: (client) => client.isReady,
      invalidate: (client) => {
        if (client.isOpen) {
          client.destroy();
        }
      },
      close: async (client) => {
        if (!client.isOpen) {
          return;
        }
        if (client.isReady && this.activeOperationCount === 0) {
          await client.close();
          return;
        }
        client.destroy();
      },
      subscribeUnavailable: (client, listener) => {
        const onError = (error: Error) => listener(error);
        const onEnd = () => listener(Object.assign(new Error('Redis connection lost.'), {
          code: 'REDIS_CONNECTION_LOST'
        }));
        client.on('error', onError);
        client.on('end', onEnd);
        return () => {
          client.off?.('error', onError);
          client.off?.('end', onEnd);
        };
      },
      classifyError: classifyRedisLifecycleError
    };

    this.lifecycle = new DependencyLifecycle({
      adapter,
      attemptTimeoutMs: REDIS_ATTEMPT_TIMEOUT_MS,
      retryBaseDelayMs: REDIS_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: REDIS_RETRY_MAX_DELAY_MS,
      retryJitterMs: REDIS_RETRY_JITTER_MS,
      sleep: options.sleep,
      random: options.random,
      now: options.now,
      onEvent: reportRedisLifecycleEvent
    });
  }

  start(): void {
    this.lifecycle.start();
  }

  stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  getReadyClient(): RedisLifecycleClient | null {
    return this.lifecycle.getReadyResource();
  }

  getSnapshot(): RedisLifecycleSnapshot {
    return projectRedisSnapshot(this.lifecycle.getSnapshot());
  }

  subscribe(listener: RedisLifecycleListener): () => void {
    return this.lifecycle.subscribe((snapshot) => {
      listener(projectRedisSnapshot(snapshot));
    });
  }

  reportUnavailable(error: unknown): void {
    this.lifecycle.reportUnavailable(error);
  }

  async executeOperation<T>(
    operation: (client: RedisLifecycleClient) => Promise<T>,
    options: RedisOperationOptions = {}
  ): Promise<T> {
    const client = options.client ?? this.getReadyClient();
    if (!client || this.getReadyClient() !== client) {
      throw createRedisDependencyUnavailableError();
    }

    const timeoutMs = options.timeoutMs ?? REDIS_OPERATION_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Redis operation timeout must be a positive finite number.');
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutError = Object.assign(new Error('Redis operation timed out.'), {
      code: 'REDIS_OPERATION_TIMEOUT'
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        this.reportUnavailable(timeoutError);
        reject(createRedisDependencyUnavailableError());
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    this.activeOperationCount += 1;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => operation(client)),
        timeoutPromise
      ]);
      if (this.getReadyClient() !== client) {
        throw createRedisDependencyUnavailableError();
      }
      return result;
    } catch (error) {
      if (this.getReadyClient() === client) {
        this.reportUnavailable(error);
      }
      if (error instanceof DependencyUnavailableError) {
        throw error;
      }
      throw createRedisDependencyUnavailableError();
    } finally {
      this.activeOperationCount = Math.max(0, this.activeOperationCount - 1);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

const redisLifecycle = new RedisLifecycleManager();

export function startRedisLifecycle(): void {
  redisLifecycle.start();
}

export function stopRedisLifecycle(): Promise<void> {
  return redisLifecycle.stop();
}

export function getReadyRedisClient(): RedisLifecycleClient | null {
  return redisLifecycle.getReadyClient();
}

export function requireReadyRedisClient(): RedisLifecycleClient {
  const client = getReadyRedisClient();
  if (!client) {
    throw new DependencyUnavailableError(
      'redis',
      'REDIS_DEPENDENCY_UNAVAILABLE',
      'Redis dependency is unavailable.'
    );
  }
  return client;
}

/** Run one Redis command with a deadline and a stable dependency failure. */
export async function executeRedisOperation<T>(
  operation: (client: RedisLifecycleClient) => Promise<T>,
  options: RedisOperationOptions = {}
): Promise<T> {
  return redisLifecycle.executeOperation(operation, options);
}

export function getRedisLifecycleSnapshot(): RedisLifecycleSnapshot {
  return redisLifecycle.getSnapshot();
}

export function subscribeRedisLifecycle(listener: RedisLifecycleListener): () => void {
  return redisLifecycle.subscribe(listener);
}

import { createClient } from 'redis';
import { logger } from '@platform/logging/structuredLogging.js';
import { resolveConfiguredRedisConnection } from '@platform/runtime/redis.js';

const REDIS_ATTEMPT_TIMEOUT_MS = 3_000;
const REDIS_RETRY_BASE_DELAY_MS = 250;
const REDIS_RETRY_MAX_DELAY_MS = 30_000;
const REDIS_RETRY_JITTER_MS = 250;

export type RedisLifecycleState = 'STARTING' | 'DEGRADED' | 'READY';

export type RedisLifecycleErrorCode =
  | 'REDIS_CONNECTION_REFUSED'
  | 'REDIS_CONNECT_TIMEOUT'
  | 'REDIS_AUTH_FAILED'
  | 'REDIS_DNS_UNAVAILABLE'
  | 'REDIS_CONNECTION_LOST'
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
export type RedisLifecycleSleep = (delayMs: number, signal: AbortSignal) => Promise<void>;
export type RedisLifecycleClientFactory = (
  options: Parameters<typeof createClient>[0]
) => RedisLifecycleClient;

export interface RedisLifecycleManagerOptions {
  clientFactory?: RedisLifecycleClientFactory;
  sleep?: RedisLifecycleSleep;
  random?: () => number;
  now?: () => Date;
}

class RedisLifecycleAbortError extends Error {
  constructor() {
    super('Redis lifecycle operation aborted.');
    this.name = 'RedisLifecycleAbortError';
  }
}

class RedisLifecycleAttemptTimeoutError extends Error {
  readonly code = 'REDIS_CONNECT_TIMEOUT';

  constructor() {
    super('Redis lifecycle connection attempt timed out.');
    this.name = 'RedisLifecycleAttemptTimeoutError';
  }
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new RedisLifecycleAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timeoutHandle.unref?.();

    const onAbort = () => {
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
      reject(new RedisLifecycleAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
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

  if (
    code === 'ETIMEDOUT'
    || code === 'REDIS_CONNECT_TIMEOUT'
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
    || message.includes('SOCKET CLOSED')
    || message.includes('CONNECTION LOST')
  ) {
    return 'REDIS_CONNECTION_LOST';
  }

  return 'REDIS_UNAVAILABLE';
}

function cloneSnapshot(snapshot: RedisLifecycleSnapshot): RedisLifecycleSnapshot {
  return { ...snapshot };
}

/**
 * Own the shared startup/telemetry/diagnostics Redis connection without making
 * listener startup wait for it.
 *
 * A single client is reused across bounded connect attempts. Reconnect scheduling is
 * owned here so shutdown can abort every pending timer deterministically.
 */
export class RedisLifecycleManager {
  private readonly clientFactory: RedisLifecycleClientFactory;
  private readonly sleep: RedisLifecycleSleep;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly listeners = new Set<RedisLifecycleListener>();
  private readonly abortController = new AbortController();
  private client: RedisLifecycleClient | null = null;
  private connectionLoop: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  private consecutiveAttempts = 0;
  private snapshot: RedisLifecycleSnapshot;

  constructor(options: RedisLifecycleManagerOptions = {}) {
    this.clientFactory = options.clientFactory ?? ((clientOptions) => createClient(clientOptions));
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.snapshot = {
      state: 'STARTING',
      configured: false,
      connected: false,
      attempt: 0,
      recoveryCount: 0,
      retryScheduled: false,
      lastTransitionAt: this.now().toISOString(),
      lastReadyAt: null,
      lastErrorCode: null
    };
  }

  /** Start connection recovery in the background. Repeated calls are no-ops. */
  start(): void {
    if (this.started || this.stopping) {
      return;
    }

    this.started = true;
    const redisConnection = resolveConfiguredRedisConnection();
    if (!redisConnection.configured || !redisConnection.url) {
      // Redis remains optional for local/stateless deployments. Production config
      // validation is responsible for enforcing a required reference where needed.
      this.updateSnapshot({
        state: 'READY',
        configured: false,
        connected: false,
        retryScheduled: false,
        lastErrorCode: null
      });
      return;
    }

    this.updateSnapshot({
      state: 'STARTING',
      configured: true,
      connected: false,
      retryScheduled: false,
      lastErrorCode: null
    });

    try {
      const client = this.clientFactory({
        url: redisConnection.url,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: REDIS_ATTEMPT_TIMEOUT_MS,
          reconnectStrategy: false
        }
      });
      this.client = client;
      client.on('error', (error: Error) => {
        this.handleClientError(client, error);
      });
      client.on('end', () => {
        this.handleClientEnd(client);
      });
      this.ensureConnectionLoop(client);
    } catch (error) {
      const errorCode = classifyRedisLifecycleError(error);
      this.updateSnapshot({
        state: 'DEGRADED',
        configured: true,
        connected: false,
        retryScheduled: false,
        lastErrorCode: errorCode
      });
      logger.warn('redis.lifecycle.client_creation_failed', {
        module: 'redis-lifecycle',
        errorCode
      });
    }
  }

  /** Stop retries and close the current client. Repeated calls share one promise. */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  /** Return the singleton client only while it is verified ready. */
  getReadyClient(): RedisLifecycleClient | null {
    const client = this.client;
    if (
      !client
      || this.stopping
      || this.snapshot.state !== 'READY'
      || !this.snapshot.connected
      || !client.isReady
    ) {
      return null;
    }

    return client;
  }

  /** Return an immutable, credential-free lifecycle projection. */
  getSnapshot(): RedisLifecycleSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  /** Subscribe to lifecycle transitions and receive the current snapshot immediately. */
  subscribe(listener: RedisLifecycleListener): () => void {
    this.listeners.add(listener);
    this.notifyListener(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private ensureConnectionLoop(client: RedisLifecycleClient): void {
    if (
      this.connectionLoop
      || this.stopping
      || this.abortController.signal.aborted
      || this.client !== client
    ) {
      return;
    }

    const loop = this.runConnectionLoop(client);
    this.connectionLoop = loop;
    void loop.finally(() => {
      if (this.connectionLoop === loop) {
        this.connectionLoop = null;
      }
      if (
        !this.stopping
        && !this.abortController.signal.aborted
        && this.client === client
        && this.snapshot.state === 'DEGRADED'
      ) {
        this.ensureConnectionLoop(client);
      }
    }).catch(() => {
      // Every operational failure is represented by the sanitized lifecycle state.
    });
  }

  private async runConnectionLoop(client: RedisLifecycleClient): Promise<void> {
    while (!this.stopping && !this.abortController.signal.aborted && this.client === client) {
      this.consecutiveAttempts += 1;
      const attempt = this.consecutiveAttempts;
      this.updateSnapshot({
        attempt,
        retryScheduled: false
      });

      try {
        if (!client.isOpen) {
          await this.runBoundedAttempt(client.connect(), client);
        }

        const pingResponse = await this.runBoundedAttempt(client.ping(), client);
        if (pingResponse !== 'PONG') {
          throw Object.assign(new Error('Unexpected Redis readiness response.'), {
            code: 'REDIS_UNEXPECTED_RESPONSE'
          });
        }

        if (this.stopping || this.abortController.signal.aborted || this.client !== client) {
          return;
        }

        const recovered = this.snapshot.state === 'DEGRADED';
        this.updateSnapshot({
          state: 'READY',
          configured: true,
          connected: true,
          retryScheduled: false,
          recoveryCount: this.snapshot.recoveryCount + (recovered ? 1 : 0),
          lastReadyAt: this.now().toISOString(),
          lastErrorCode: null
        });
        this.consecutiveAttempts = 0;
        logger.info('redis.lifecycle.ready', {
          module: 'redis-lifecycle',
          recovered,
          attempt
        });
        return;
      } catch (error) {
        if (this.stopping || this.abortController.signal.aborted || error instanceof RedisLifecycleAbortError) {
          return;
        }

        this.destroyClientConnection(client);
        const errorCode = classifyRedisLifecycleError(error);
        const retryDelayMs = this.calculateRetryDelay(attempt);
        this.updateSnapshot({
          state: 'DEGRADED',
          configured: true,
          connected: false,
          retryScheduled: true,
          lastErrorCode: errorCode
        });
        logger.warn('redis.lifecycle.retry_scheduled', {
          module: 'redis-lifecycle',
          errorCode,
          attempt,
          retryDelayMs
        });

        try {
          await this.sleep(retryDelayMs, this.abortController.signal);
        } catch (sleepError) {
          if (sleepError instanceof RedisLifecycleAbortError || this.abortController.signal.aborted) {
            return;
          }
          throw sleepError;
        }
      }
    }
  }

  private async runBoundedAttempt<T>(
    operation: Promise<T>,
    client: RedisLifecycleClient
  ): Promise<T> {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    this.abortController.signal.addEventListener('abort', abortAttempt, { once: true });

    const timeoutPromise = this.sleep(REDIS_ATTEMPT_TIMEOUT_MS, attemptController.signal)
      .then<never>(() => {
        if (this.client === client) {
          this.destroyClientConnection(client);
        }
        throw new RedisLifecycleAttemptTimeoutError();
      });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      attemptController.abort();
      this.abortController.signal.removeEventListener('abort', abortAttempt);
    }
  }

  private handleClientError(client: RedisLifecycleClient, error: unknown): void {
    if (
      this.stopping
      || this.client !== client
      || (this.connectionLoop !== null && this.snapshot.state !== 'READY')
    ) {
      return;
    }

    const errorCode = classifyRedisLifecycleError(error);
    this.updateSnapshot({
      state: 'DEGRADED',
      configured: true,
      connected: false,
      retryScheduled: false,
      lastErrorCode: errorCode
    });
    logger.warn('redis.lifecycle.connection_lost', {
      module: 'redis-lifecycle',
      errorCode
    });
    this.destroyClientConnection(client);
    this.ensureConnectionLoop(client);
  }

  private handleClientEnd(client: RedisLifecycleClient): void {
    if (
      this.stopping
      || this.client !== client
      || this.snapshot.state !== 'READY'
      || !this.snapshot.connected
    ) {
      return;
    }

    this.updateSnapshot({
      state: 'DEGRADED',
      configured: true,
      connected: false,
      retryScheduled: false,
      lastErrorCode: 'REDIS_CONNECTION_LOST'
    });
    logger.warn('redis.lifecycle.connection_lost', {
      module: 'redis-lifecycle',
      errorCode: 'REDIS_CONNECTION_LOST'
    });
    this.ensureConnectionLoop(client);
  }

  private calculateRetryDelay(attempt: number): number {
    const exponent = Math.max(0, Math.min(attempt - 1, 30));
    const exponentialDelay = Math.min(
      REDIS_RETRY_BASE_DELAY_MS * (2 ** exponent),
      REDIS_RETRY_MAX_DELAY_MS
    );
    const boundedRandom = Math.max(0, Math.min(this.random(), 0.999999999));
    const jitter = Math.floor(boundedRandom * REDIS_RETRY_JITTER_MS);
    return Math.min(exponentialDelay + jitter, REDIS_RETRY_MAX_DELAY_MS);
  }

  private destroyClientConnection(client: RedisLifecycleClient): void {
    if (this.client !== client || !client.isOpen) {
      return;
    }

    try {
      client.destroy();
    } catch {
      // Destruction is best-effort; the retry loop remains the source of truth.
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.abortController.abort();
    const client = this.client;
    this.client = null;
    const connectionLoop = this.connectionLoop;
    this.updateSnapshot({
      state: 'DEGRADED',
      connected: false,
      retryScheduled: false,
      lastErrorCode: null
    });

    if (client?.isOpen) {
      try {
        if (client.isReady) {
          await client.close();
        } else {
          client.destroy();
        }
      } catch {
        try {
          if (client.isOpen) {
            client.destroy();
          }
        } catch {
          // Redis shutdown remains best-effort under the server shutdown deadline.
        }
      }
    }

    if (connectionLoop) {
      await connectionLoop.catch(() => undefined);
    }

    this.listeners.clear();
  }

  private updateSnapshot(update: Partial<RedisLifecycleSnapshot>): void {
    const previousState = this.snapshot.state;
    const nextState = update.state ?? previousState;
    this.snapshot = {
      ...this.snapshot,
      ...update,
      lastTransitionAt: nextState === previousState
        ? this.snapshot.lastTransitionAt
        : this.now().toISOString()
    };
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      this.notifyListener(listener);
    }
  }

  private notifyListener(listener: RedisLifecycleListener): void {
    try {
      listener(this.getSnapshot());
    } catch {
      logger.warn('redis.lifecycle.listener_failed', {
        module: 'redis-lifecycle',
        errorCode: 'REDIS_LIFECYCLE_LISTENER_FAILED'
      });
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

export function getRedisLifecycleSnapshot(): RedisLifecycleSnapshot {
  return redisLifecycle.getSnapshot();
}

export function subscribeRedisLifecycle(listener: RedisLifecycleListener): () => void {
  return redisLifecycle.subscribe(listener);
}

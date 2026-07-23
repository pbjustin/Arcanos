import { createClient, ErrorReply } from 'redis';
import { logger } from '@platform/logging/structuredLogging.js';
import {
  recordDependencyCall,
  recordDependencyLifecycleEvent,
  recordDependencyOperationGateRejection,
  recordDependencyOperationInFlight,
} from '@platform/observability/appMetrics.js';
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
const REDIS_CIRCUIT_FAILURE_THRESHOLD = 1;

export type RedisLifecycleState = DependencyLifecycleState;
export type RedisCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type RedisOperationName =
  | 'diagnostics.metrics.record'
  | 'diagnostics.metrics.read'
  | 'diagnostics.metrics.reset'
  | 'incident.kill_switch.read'
  | 'incident.kill_switch.write_restrictive'
  | 'incident.kill_switch.write_relaxing'
  | 'self_heal.telemetry.load'
  | 'self_heal.telemetry.save'
  | 'safety.nonce.consume'
  | 'safety.lock.extend'
  | 'safety.key.delete'
  | 'safety.lock.acquire'
  | 'safety.lock.release'
  | 'safety.lock.heartbeat';

export type RedisLifecycleErrorCode =
  | 'REDIS_CONNECTION_REFUSED'
  | 'REDIS_CONNECT_TIMEOUT'
  | 'REDIS_CONFIGURATION_INVALID'
  | 'REDIS_AUTH_FAILED'
  | 'REDIS_DNS_UNAVAILABLE'
  | 'REDIS_CONNECTION_LOST'
  | 'REDIS_OPERATION_TIMEOUT'
  | 'REDIS_UNEXPECTED_RESPONSE'
  | 'REDIS_UNAVAILABLE';

export interface RedisLifecycleSnapshot {
  state: RedisLifecycleState;
  configured: boolean;
  connected: boolean;
  attemptInFlight: boolean;
  readyGeneration: number;
  circuitEnabled: boolean;
  circuitState: RedisCircuitState;
  circuitFailureThreshold: 1;
  attempt: number;
  recoveryCount: number;
  retryScheduled: boolean;
  lastTransitionAt: string;
  lastReadyAt: string | null;
  lastErrorCode: RedisLifecycleErrorCode | null;
  operationGate: RedisOperationGateSnapshot;
}

export interface RedisOperationGateSnapshot {
  inFlight: number;
  admittedTotal: number;
  rejectedTotal: number;
  succeededTotal: number;
  failedTotal: number;
  timedOutTotal: number;
  lastOperation: RedisOperationName | null;
  lastOutcome: 'succeeded' | 'failed' | 'timed_out' | 'rejected' | null;
  lastDurationMs: number | null;
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
  operation: RedisOperationName;
  timeoutMs?: number;
  correlationId?: string;
  requestId?: string;
  traceId?: string;
  jobId?: string;
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

  if (code === 'REDIS_UNEXPECTED_RESPONSE') {
    return 'REDIS_UNEXPECTED_RESPONSE';
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

function deriveRedisCircuitState(snapshot: {
  configured: boolean;
  ready: boolean;
  attemptInFlight: boolean;
}): RedisCircuitState {
  if (!snapshot.configured || snapshot.ready) {
    return 'CLOSED';
  }
  return snapshot.attemptInFlight ? 'HALF_OPEN' : 'OPEN';
}

function cloneOperationGateSnapshot(
  snapshot: RedisOperationGateSnapshot
): RedisOperationGateSnapshot {
  return { ...snapshot };
}

function projectRedisSnapshot(
  snapshot: ReturnType<DependencyLifecycle<RedisLifecycleClient, RedisLifecycleErrorCode>['getSnapshot']>,
  operationGate: RedisOperationGateSnapshot
): RedisLifecycleSnapshot {
  return {
    state: snapshot.state,
    configured: snapshot.configured,
    connected: snapshot.ready,
    attemptInFlight: snapshot.attemptInFlight,
    readyGeneration: snapshot.readyGeneration,
    circuitEnabled: snapshot.configured,
    circuitState: deriveRedisCircuitState(snapshot),
    circuitFailureThreshold: REDIS_CIRCUIT_FAILURE_THRESHOLD,
    attempt: snapshot.attempt,
    recoveryCount: snapshot.recoveryCount,
    retryScheduled: snapshot.retryScheduled,
    lastTransitionAt: snapshot.lastTransitionAt,
    lastReadyAt: snapshot.lastReadyAt,
    lastErrorCode: snapshot.lastErrorCode,
    operationGate: cloneOperationGateSnapshot(operationGate)
  };
}

function reportRedisLifecycleEvent(event: DependencyLifecycleEvent<RedisLifecycleErrorCode>): void {
  const circuitState = deriveRedisCircuitState({
    configured: true,
    ready: event.state === 'READY',
    attemptInFlight: event.attemptInFlight
  });
  const eventContext = {
    module: 'redis-lifecycle',
    dependency: event.dependency,
    lifecycleId: event.lifecycleId,
    eventId: event.eventId,
    correlationId: event.correlationId,
    eventSequence: event.eventSequence,
    occurredAt: event.occurredAt,
    previousState: event.previousState,
    state: event.state,
    previousAttemptInFlight: event.previousAttemptInFlight,
    attemptInFlight: event.attemptInFlight,
    previousReadyGeneration: event.previousReadyGeneration,
    readyGeneration: event.readyGeneration,
    circuitState
  };
  recordDependencyLifecycleEvent({
    dependency: event.dependency,
    event: event.kind,
    lifecycleState: event.state,
    circuitState,
    recovered: event.kind === 'ready' ? event.recovered : false
  });

  if (event.kind === 'attempt_started') {
    logger.info('redis.lifecycle.half_open_probe_started', {
      ...eventContext,
      attempt: event.attempt
    });
    return;
  }

  if (event.kind === 'ready') {
    logger.info('redis.lifecycle.ready', {
      ...eventContext,
      recovered: event.recovered,
      attempt: event.attempt
    });
    return;
  }

  if (event.kind === 'retry_scheduled') {
    logger.warn('redis.lifecycle.retry_scheduled', {
      ...eventContext,
      operation: event.operation,
      errorCode: event.errorCode,
      attempt: event.attempt,
      retryDelayMs: event.retryDelayMs
    });
    return;
  }

  if (event.kind === 'unavailable') {
    logger.warn('redis.lifecycle.connection_lost', {
      ...eventContext,
      errorCode: event.errorCode,
      retryDelayMs: event.retryDelayMs
    });
    return;
  }

  logger.warn('redis.lifecycle.listener_failed', {
    ...eventContext,
    errorCode: 'REDIS_LIFECYCLE_LISTENER_FAILED'
  });
}

function normalizeCorrelationId(options: RedisOperationOptions): string | undefined {
  const candidate = options.correlationId
    ?? options.traceId
    ?? options.requestId
    ?? options.jobId;
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const normalized = candidate.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    ? normalized
    : undefined;
}

function isRedisLogicalCommandError(error: unknown): boolean {
  if (!(error instanceof ErrorReply)) {
    return false;
  }
  const replyPrefix = error.message.trim().split(/\s+/u, 1)[0]?.toUpperCase() ?? '';
  return ['ERR', 'WRONGTYPE', 'NOSCRIPT'].includes(replyPrefix);
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
  private readonly now: () => Date;
  private activeOperationCount = 0;
  private readonly operationGate: RedisOperationGateSnapshot = {
    inFlight: 0,
    admittedTotal: 0,
    rejectedTotal: 0,
    succeededTotal: 0,
    failedTotal: 0,
    timedOutTotal: 0,
    lastOperation: null,
    lastOutcome: null,
    lastDurationMs: null
  };
  private readonly loggedGateRejections = new Set<string>();
  private loggedGateRejectionGeneration = -1;

  constructor(options: RedisLifecycleManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
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
      dependencyName: 'redis',
      attemptTimeoutMs: REDIS_ATTEMPT_TIMEOUT_MS,
      retryBaseDelayMs: REDIS_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: REDIS_RETRY_MAX_DELAY_MS,
      retryJitterMs: REDIS_RETRY_JITTER_MS,
      sleep: options.sleep,
      random: options.random,
      now: this.now,
      onEvent: reportRedisLifecycleEvent
    });
  }

  start(): void {
    this.lifecycle.start();
  }

  stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  getSnapshot(): RedisLifecycleSnapshot {
    return projectRedisSnapshot(this.lifecycle.getSnapshot(), this.operationGate);
  }

  subscribe(listener: RedisLifecycleListener): () => void {
    return this.lifecycle.subscribe((snapshot) => {
      listener(projectRedisSnapshot(snapshot, this.operationGate));
    });
  }

  async executeOperation<T>(
    operation: (client: RedisLifecycleClient) => Promise<T>,
    options: RedisOperationOptions
  ): Promise<T> {
    const operationName = options.operation;
    const correlationId = normalizeCorrelationId(options);
    const lease = this.lifecycle.getReadyResourceLease(correlationId);
    if (!lease) {
      this.recordGateRejection(operationName, correlationId);
      throw createRedisDependencyUnavailableError();
    }

    const requestedTimeoutMs = options.timeoutMs ?? REDIS_OPERATION_TIMEOUT_MS;
    if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
      throw new Error('Redis operation timeout must be a positive finite number.');
    }
    const timeoutMs = Math.min(requestedTimeoutMs, REDIS_OPERATION_TIMEOUT_MS);
    const startedAtMs = this.now().getTime();

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let operationStarted = false;
    let timedOut = false;
    const timeoutError = Object.assign(new Error('Redis operation timed out.'), {
      code: 'REDIS_OPERATION_TIMEOUT'
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        this.lifecycle.reportUnavailable(timeoutError, lease);
        reject(createRedisDependencyUnavailableError());
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (!this.lifecycle.isReadyResourceLease(lease)) {
            throw createRedisDependencyUnavailableError();
          }
          operationStarted = true;
          this.activeOperationCount += 1;
          this.operationGate.inFlight = this.activeOperationCount;
          this.operationGate.admittedTotal += 1;
          this.operationGate.lastOperation = operationName;
          recordDependencyOperationInFlight('redis', this.activeOperationCount);
          const admittedOperation = Promise.resolve().then(() => operation(lease.resource));
          void admittedOperation.then(
            () => this.recordOperationSettled(),
            () => this.recordOperationSettled()
          );
          return admittedOperation;
        }),
        timeoutPromise
      ]);
      if (!this.lifecycle.isReadyResourceLease(lease)) {
        throw createRedisDependencyUnavailableError();
      }
      const durationMs = Math.max(0, this.now().getTime() - startedAtMs);
      this.operationGate.succeededTotal += 1;
      this.operationGate.lastOperation = operationName;
      this.operationGate.lastOutcome = 'succeeded';
      this.operationGate.lastDurationMs = durationMs;
      recordDependencyCall({
        dependency: 'redis',
        operation: operationName,
        outcome: 'ok',
        durationMs
      });
      return result;
    } catch (error) {
      if (!operationStarted) {
        this.recordGateRejection(operationName, correlationId);
      } else {
        const durationMs = Math.max(0, this.now().getTime() - startedAtMs);
        this.operationGate.failedTotal += 1;
        this.operationGate.lastOperation = operationName;
        this.operationGate.lastOutcome = timedOut ? 'timed_out' : 'failed';
        this.operationGate.lastDurationMs = durationMs;
        if (timedOut) {
          this.operationGate.timedOutTotal += 1;
        }
        recordDependencyCall({
          dependency: 'redis',
          operation: operationName,
          outcome: timedOut ? 'timeout' : 'failed',
          durationMs,
          error
        });
      }
      if (
        operationStarted
        && !(error instanceof DependencyUnavailableError)
        && !timedOut
        && !isRedisLogicalCommandError(error)
      ) {
        this.lifecycle.reportUnavailable(error, lease);
      }
      if (error instanceof DependencyUnavailableError) {
        throw error;
      }
      throw createRedisDependencyUnavailableError();
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private recordOperationSettled(): void {
    this.activeOperationCount = Math.max(0, this.activeOperationCount - 1);
    this.operationGate.inFlight = this.activeOperationCount;
    recordDependencyOperationInFlight('redis', this.activeOperationCount);
  }

  private recordGateRejection(
    operation: RedisOperationName,
    correlationId?: string
  ): void {
    const snapshot = this.getSnapshot();
    this.operationGate.rejectedTotal += 1;
    this.operationGate.lastOperation = operation;
    this.operationGate.lastOutcome = 'rejected';
    this.operationGate.lastDurationMs = 0;
    const reason = snapshot.circuitState === 'HALF_OPEN'
      ? 'half_open'
      : snapshot.circuitState === 'OPEN'
        ? 'open'
        : 'stale_generation';
    recordDependencyOperationGateRejection({
      dependency: 'redis',
      operation,
      reason
    });
    recordDependencyCall({
      dependency: 'redis',
      operation,
      outcome: 'rejected',
      durationMs: 0
    });

    if (snapshot.readyGeneration !== this.loggedGateRejectionGeneration) {
      this.loggedGateRejections.clear();
      this.loggedGateRejectionGeneration = snapshot.readyGeneration;
    }
    const logKey = `${snapshot.readyGeneration}:${snapshot.circuitState}:${operation}`;
    if (this.loggedGateRejections.has(logKey)) {
      return;
    }
    this.loggedGateRejections.add(logKey);
    logger.warn('redis.operation.rejected', {
      module: 'redis-lifecycle',
      dependency: 'redis',
      operation,
      reason,
      circuitState: snapshot.circuitState,
      readyGeneration: snapshot.readyGeneration,
      errorCode: 'REDIS_DEPENDENCY_UNAVAILABLE',
      ...(correlationId ? { correlationId } : {})
    });
  }
}

const redisLifecycle = new RedisLifecycleManager();

export function startRedisLifecycle(): void {
  redisLifecycle.start();
}

export function stopRedisLifecycle(): Promise<void> {
  return redisLifecycle.stop();
}

/** Run one Redis command with a deadline and a stable dependency failure. */
export async function executeRedisOperation<T>(
  operation: (client: RedisLifecycleClient) => Promise<T>,
  options: RedisOperationOptions
): Promise<T> {
  return redisLifecycle.executeOperation(operation, options);
}

export function getRedisLifecycleSnapshot(): RedisLifecycleSnapshot {
  return redisLifecycle.getSnapshot();
}

export function subscribeRedisLifecycle(listener: RedisLifecycleListener): () => void {
  return redisLifecycle.subscribe(listener);
}

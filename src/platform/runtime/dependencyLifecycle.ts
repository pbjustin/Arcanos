export type DependencyLifecycleState = 'STARTING' | 'DEGRADED' | 'READY';

export interface DependencyLifecycleSnapshot<TErrorCode extends string = string> {
  state: DependencyLifecycleState;
  configured: boolean;
  ready: boolean;
  attemptInFlight: boolean;
  readyGeneration: number;
  attempt: number;
  recoveryCount: number;
  retryScheduled: boolean;
  lastTransitionAt: string;
  lastReadyAt: string | null;
  lastErrorCode: TErrorCode | null;
}

export type DependencyLifecycleListener<TErrorCode extends string = string> = (
  snapshot: DependencyLifecycleSnapshot<TErrorCode>
) => void;

export type DependencyLifecycleSleep = (
  delayMs: number,
  signal: AbortSignal
) => Promise<void>;

export type DependencyLifecycleResolution<TResource> =
  | { configured: false }
  | { configured: true; createResource: () => TResource };

export interface DependencyLifecycleAdapter<TResource, TErrorCode extends string> {
  resolve(): DependencyLifecycleResolution<TResource>;
  connect(resource: TResource): Promise<void>;
  validate(resource: TResource): Promise<void>;
  isReady(resource: TResource): boolean;
  invalidate(resource: TResource): void;
  close(resource: TResource): Promise<void>;
  subscribeUnavailable(
    resource: TResource,
    listener: (error: unknown) => void
  ): () => void;
  classifyError(error: unknown): TErrorCode;
}

export type DependencyLifecycleOperation = 'create' | 'connect' | 'validate' | 'runtime';

export interface DependencyLifecycleEventEnvelope {
  dependency: string;
  lifecycleId: string;
  eventId: string;
  correlationId: string;
  eventSequence: number;
  occurredAt: string;
  previousState: DependencyLifecycleState;
  state: DependencyLifecycleState;
  previousAttemptInFlight: boolean;
  attemptInFlight: boolean;
  previousReadyGeneration: number;
  readyGeneration: number;
}

export type DependencyLifecycleEventDetail<TErrorCode extends string> =
  | {
    kind: 'attempt_started';
    attempt: number;
  }
  | {
    kind: 'ready';
    attempt: number;
    recovered: boolean;
  }
  | {
    kind: 'retry_scheduled';
    operation: DependencyLifecycleOperation;
    errorCode: TErrorCode;
    attempt: number;
    retryDelayMs: number;
  }
  | {
    kind: 'unavailable';
    operation: 'runtime';
    errorCode: TErrorCode;
    retryDelayMs: number;
  }
  | {
    kind: 'listener_failed';
  };

export type DependencyLifecycleEvent<TErrorCode extends string> =
  DependencyLifecycleEventEnvelope & DependencyLifecycleEventDetail<TErrorCode>;

export interface DependencyLifecycleResourceLease<TResource> {
  readonly resource: TResource;
  readonly readyGeneration: number;
  readonly correlationId?: string;
}

export interface DependencyLifecycleOptions<TResource, TErrorCode extends string> {
  adapter: DependencyLifecycleAdapter<TResource, TErrorCode>;
  dependencyName?: string;
  lifecycleId?: string;
  attemptTimeoutMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterMs?: number;
  sleep?: DependencyLifecycleSleep;
  random?: () => number;
  now?: () => Date;
  onEvent?: (event: DependencyLifecycleEvent<TErrorCode>) => void;
}

class DependencyLifecycleAbortError extends Error {
  constructor() {
    super('Dependency lifecycle operation aborted.');
    this.name = 'DependencyLifecycleAbortError';
  }
}

class DependencyLifecycleAttemptTimeoutError extends Error {
  readonly code = 'DEPENDENCY_ATTEMPT_TIMEOUT';

  constructor() {
    super('Dependency lifecycle attempt timed out.');
    this.name = 'DependencyLifecycleAttemptTimeoutError';
  }
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DependencyLifecycleAbortError());
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
      reject(new DependencyLifecycleAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function cloneSnapshot<TErrorCode extends string>(
  snapshot: DependencyLifecycleSnapshot<TErrorCode>
): DependencyLifecycleSnapshot<TErrorCode> {
  return { ...snapshot };
}

function requirePositiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}

function requireNonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return value;
}

let nextLifecycleId = 0;

function createLifecycleId(dependencyName: string, now: Date): string {
  nextLifecycleId += 1;
  return `${dependencyName}-${now.getTime()}-${nextLifecycleId}`;
}

/**
 * Own one recoverable dependency resource and its retry lifecycle.
 *
 * Adapters retain dependency-specific configuration, validation, error
 * classification, and resource cleanup. This runner owns only the reusable
 * single-flight lifecycle mechanics.
 */
export class DependencyLifecycle<TResource, TErrorCode extends string> {
  private readonly adapter: DependencyLifecycleAdapter<TResource, TErrorCode>;
  private readonly attemptTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryJitterMs: number;
  private readonly sleep: DependencyLifecycleSleep;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly onEvent?: (event: DependencyLifecycleEvent<TErrorCode>) => void;
  private readonly dependencyName: string;
  private readonly lifecycleId: string;
  private readonly listeners = new Set<DependencyLifecycleListener<TErrorCode>>();
  private readonly abortController = new AbortController();
  private resourceFactory: (() => TResource) | null = null;
  private resource: TResource | null = null;
  private unsubscribeResource: (() => void) | null = null;
  private connectionLoop: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  private consecutiveAttempts = 0;
  private eventSequence = 0;
  private snapshot: DependencyLifecycleSnapshot<TErrorCode>;

  constructor(options: DependencyLifecycleOptions<TResource, TErrorCode>) {
    this.adapter = options.adapter;
    this.attemptTimeoutMs = requirePositiveFinite(
      options.attemptTimeoutMs,
      'attemptTimeoutMs'
    );
    this.retryBaseDelayMs = requirePositiveFinite(
      options.retryBaseDelayMs,
      'retryBaseDelayMs'
    );
    this.retryMaxDelayMs = requirePositiveFinite(
      options.retryMaxDelayMs,
      'retryMaxDelayMs'
    );
    this.retryJitterMs = requireNonNegativeFinite(
      options.retryJitterMs ?? 0,
      'retryJitterMs'
    );
    if (this.retryMaxDelayMs < this.retryBaseDelayMs) {
      throw new Error('retryMaxDelayMs must be greater than or equal to retryBaseDelayMs.');
    }
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
    this.dependencyName = options.dependencyName?.trim() || 'dependency';
    this.lifecycleId = options.lifecycleId?.trim()
      || createLifecycleId(this.dependencyName, this.now());
    this.snapshot = {
      state: 'STARTING',
      configured: false,
      ready: false,
      attemptInFlight: false,
      readyGeneration: 0,
      attempt: 0,
      recoveryCount: 0,
      retryScheduled: false,
      lastTransitionAt: this.now().toISOString(),
      lastReadyAt: null,
      lastErrorCode: null
    };
  }

  /** Start recovery in the background. Repeated calls are no-ops. */
  start(): void {
    if (this.started || this.stopping) {
      return;
    }

    this.started = true;
    const resolution = this.adapter.resolve();
    if (!resolution.configured) {
      this.updateSnapshot({
        state: 'READY',
        configured: false,
        ready: false,
        attemptInFlight: false,
        retryScheduled: false,
        lastErrorCode: null
      });
      return;
    }

    this.resourceFactory = resolution.createResource;
    this.updateSnapshot({
      state: 'STARTING',
      configured: true,
      ready: false,
      attemptInFlight: false,
      retryScheduled: false,
      lastErrorCode: null
    });
    this.ensureConnectionLoop();
  }

  /** Stop retries and close the owned resource. Repeated calls share one promise. */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  /** Return the resource only while the adapter still verifies it as ready. */
  getReadyResource(): TResource | null {
    return this.getReadyResourceLease()?.resource ?? null;
  }

  /** Capture one ready generation so late work cannot affect a recovered resource. */
  getReadyResourceLease(correlationId?: string): DependencyLifecycleResourceLease<TResource> | null {
    const resource = this.resource;
    if (
      !resource
      || this.stopping
      || this.snapshot.state !== 'READY'
      || !this.snapshot.ready
      || !this.adapter.isReady(resource)
    ) {
      return null;
    }

    return {
      resource,
      readyGeneration: this.snapshot.readyGeneration,
      ...(correlationId ? { correlationId } : {})
    };
  }

  /** Verify that a lease still belongs to the currently ready generation. */
  isReadyResourceLease(lease: DependencyLifecycleResourceLease<TResource>): boolean {
    const currentLease = this.getReadyResourceLease();
    return Boolean(
      currentLease
      && currentLease.resource === lease.resource
      && currentLease.readyGeneration === lease.readyGeneration
    );
  }

  getSnapshot(): DependencyLifecycleSnapshot<TErrorCode> {
    return cloneSnapshot(this.snapshot);
  }

  /** Invalidate a ready resource after a bounded operation detects failure. */
  reportUnavailable(
    error: unknown,
    lease?: DependencyLifecycleResourceLease<TResource>
  ): void {
    const resource = this.resource;
    if (
      !resource
      || (lease && !this.isReadyResourceLease(lease))
    ) {
      return;
    }
    this.handleUnavailable(resource, error, lease?.correlationId);
  }

  subscribe(listener: DependencyLifecycleListener<TErrorCode>): () => void {
    this.listeners.add(listener);
    this.notifyListener(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private ensureConnectionLoop(initialDelayMs = 0): void {
    if (
      this.connectionLoop
      || this.stopping
      || this.abortController.signal.aborted
      || !this.resourceFactory
    ) {
      return;
    }

    const loop = this.runConnectionLoop(initialDelayMs);
    this.connectionLoop = loop;
    void loop.finally(() => {
      if (this.connectionLoop === loop) {
        this.connectionLoop = null;
      }
      if (
        !this.stopping
        && !this.abortController.signal.aborted
        && this.snapshot.state === 'DEGRADED'
      ) {
        this.ensureConnectionLoop();
      }
    }).catch(() => {
      // Operational failures are represented by the sanitized lifecycle state.
    });
  }

  private getOrCreateResource(): TResource {
    if (this.resource) {
      return this.resource;
    }
    if (!this.resourceFactory) {
      throw new Error('Dependency resource factory is unavailable.');
    }

    const resource = this.resourceFactory();
    this.resource = resource;
    try {
      this.unsubscribeResource = this.adapter.subscribeUnavailable(resource, (error) => {
        this.handleUnavailable(resource, error);
      });
    } catch (error) {
      this.resource = null;
      try {
        this.adapter.invalidate(resource);
      } catch {
        // Resource cleanup remains best-effort when subscription setup fails.
      }
      throw error;
    }
    return resource;
  }

  private async runConnectionLoop(initialDelayMs = 0): Promise<void> {
    if (initialDelayMs > 0) {
      try {
        await this.sleep(initialDelayMs, this.abortController.signal);
      } catch (error) {
        if (
          error instanceof DependencyLifecycleAbortError
          || this.abortController.signal.aborted
        ) {
          return;
        }
        throw error;
      }
    }

    while (!this.stopping && !this.abortController.signal.aborted) {
      this.consecutiveAttempts += 1;
      const attempt = this.consecutiveAttempts;
      const beforeAttempt = this.updateSnapshot({
        attempt,
        attemptInFlight: true,
        retryScheduled: false
      });
      this.emitEvent({
        kind: 'attempt_started',
        attempt
      }, beforeAttempt);

      let operation: DependencyLifecycleOperation = 'create';
      let resource: TResource | null = null;
      try {
        resource = this.getOrCreateResource();
        operation = 'connect';
        await this.runBoundedAttempt(this.adapter.connect(resource), resource);
        operation = 'validate';
        await this.runBoundedAttempt(this.adapter.validate(resource), resource);

        if (this.stopping || this.abortController.signal.aborted || this.resource !== resource) {
          return;
        }
        if (!this.adapter.isReady(resource)) {
          throw new Error('Dependency resource became unavailable during validation.');
        }

        const recovered = this.snapshot.state === 'DEGRADED';
        const beforeReady = this.updateSnapshot({
          state: 'READY',
          configured: true,
          ready: true,
          attemptInFlight: false,
          readyGeneration: this.snapshot.readyGeneration + 1,
          retryScheduled: false,
          recoveryCount: this.snapshot.recoveryCount + (recovered ? 1 : 0),
          lastReadyAt: this.now().toISOString(),
          lastErrorCode: null
        });
        this.consecutiveAttempts = 0;
        this.emitEvent({
          kind: 'ready',
          recovered,
          attempt
        }, beforeReady);
        return;
      } catch (error) {
        if (
          this.stopping
          || this.abortController.signal.aborted
          || error instanceof DependencyLifecycleAbortError
        ) {
          return;
        }

        if (resource) {
          try {
            this.adapter.invalidate(resource);
          } catch {
            // Invalidation is best-effort; lifecycle state remains authoritative.
          }
        }
        const errorCode = this.adapter.classifyError(error);
        const retryDelayMs = this.calculateRetryDelay(attempt);
        const beforeRetry = this.updateSnapshot({
          state: 'DEGRADED',
          configured: true,
          ready: false,
          attemptInFlight: false,
          retryScheduled: true,
          lastErrorCode: errorCode
        });
        this.emitEvent({
          kind: 'retry_scheduled',
          operation,
          errorCode,
          attempt,
          retryDelayMs
        }, beforeRetry);

        try {
          await this.sleep(retryDelayMs, this.abortController.signal);
        } catch (sleepError) {
          if (
            sleepError instanceof DependencyLifecycleAbortError
            || this.abortController.signal.aborted
          ) {
            return;
          }
          throw sleepError;
        }
      }
    }
  }

  private async runBoundedAttempt<T>(operation: Promise<T>, resource: TResource): Promise<T> {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    this.abortController.signal.addEventListener('abort', abortAttempt, { once: true });

    const timeoutPromise = this.sleep(this.attemptTimeoutMs, attemptController.signal)
      .then<never>(() => {
        if (this.resource === resource) {
          try {
            this.adapter.invalidate(resource);
          } catch {
            // The timeout classification remains stable even if cleanup fails.
          }
        }
        throw new DependencyLifecycleAttemptTimeoutError();
      });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      attemptController.abort();
      this.abortController.signal.removeEventListener('abort', abortAttempt);
    }
  }

  private handleUnavailable(
    resource: TResource,
    error: unknown,
    correlationId?: string
  ): void {
    if (
      this.stopping
      || this.resource !== resource
      || this.snapshot.state !== 'READY'
    ) {
      return;
    }

    const errorCode = this.adapter.classifyError(error);
    const retryDelayMs = this.calculateRetryDelay(1);
    const beforeUnavailable = this.updateSnapshot({
      state: 'DEGRADED',
      configured: true,
      ready: false,
      attemptInFlight: false,
      retryScheduled: true,
      lastErrorCode: errorCode
    });
    this.emitEvent({
      kind: 'unavailable',
      operation: 'runtime',
      errorCode,
      retryDelayMs
    }, beforeUnavailable, correlationId);
    try {
      this.adapter.invalidate(resource);
    } catch {
      // Retry remains available even when invalidation is already complete.
    }
    this.ensureConnectionLoop(retryDelayMs);
  }

  private calculateRetryDelay(attempt: number): number {
    const exponent = Math.max(0, Math.min(attempt - 1, 30));
    const exponentialDelay = Math.min(
      this.retryBaseDelayMs * (2 ** exponent),
      this.retryMaxDelayMs
    );
    const boundedRandom = Math.max(0, Math.min(this.random(), 0.999999999));
    const jitter = Math.floor(boundedRandom * this.retryJitterMs);
    return Math.min(exponentialDelay + jitter, this.retryMaxDelayMs);
  }

  private async stopInternal(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    this.abortController.abort();
    const resource = this.resource;
    this.resource = null;
    const connectionLoop = this.connectionLoop;
    this.updateSnapshot({
      state: 'DEGRADED',
      ready: false,
      attemptInFlight: false,
      retryScheduled: false,
      lastErrorCode: null
    });

    try {
      if (resource) {
        if (connectionLoop) {
          try {
            this.adapter.invalidate(resource);
          } catch {
            // Closing still gets a chance when active-attempt cancellation fails.
          }
        }
        try {
          await this.adapter.close(resource);
        } catch {
          try {
            this.adapter.invalidate(resource);
          } catch {
            // Dependency shutdown remains best-effort under the server deadline.
          }
        }
      }

      if (connectionLoop) {
        await connectionLoop.catch(() => undefined);
      }
    } finally {
      try {
        this.unsubscribeResource?.();
      } catch {
        // Subscription cleanup cannot prevent resource closure during shutdown.
      }
      this.unsubscribeResource = null;
    }

    this.listeners.clear();
  }

  private updateSnapshot(
    update: Partial<DependencyLifecycleSnapshot<TErrorCode>>
  ): DependencyLifecycleSnapshot<TErrorCode> {
    const previousSnapshot = this.snapshot;
    const previousState = this.snapshot.state;
    const nextState = update.state ?? previousState;
    const previousAttemptInFlight = this.snapshot.attemptInFlight;
    const nextAttemptInFlight = update.attemptInFlight ?? previousAttemptInFlight;
    this.snapshot = {
      ...this.snapshot,
      ...update,
      lastTransitionAt: nextState === previousState
        && nextAttemptInFlight === previousAttemptInFlight
        ? this.snapshot.lastTransitionAt
        : this.now().toISOString()
    };
    this.notifyListeners();
    return previousSnapshot;
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      this.notifyListener(listener);
    }
  }

  private notifyListener(listener: DependencyLifecycleListener<TErrorCode>): void {
    try {
      listener(this.getSnapshot());
    } catch {
      this.emitEvent({ kind: 'listener_failed' }, this.snapshot);
    }
  }

  private emitEvent(
    event: DependencyLifecycleEventDetail<TErrorCode>,
    previousSnapshot: DependencyLifecycleSnapshot<TErrorCode>,
    correlationId = this.lifecycleId
  ): void {
    this.eventSequence += 1;
    const occurredAt = this.now().toISOString();
    const envelope: DependencyLifecycleEventEnvelope = {
      dependency: this.dependencyName,
      lifecycleId: this.lifecycleId,
      eventId: `${this.lifecycleId}:${this.eventSequence}`,
      correlationId,
      eventSequence: this.eventSequence,
      occurredAt,
      previousState: previousSnapshot.state,
      state: this.snapshot.state,
      previousAttemptInFlight: previousSnapshot.attemptInFlight,
      attemptInFlight: this.snapshot.attemptInFlight,
      previousReadyGeneration: previousSnapshot.readyGeneration,
      readyGeneration: this.snapshot.readyGeneration
    };
    try {
      this.onEvent?.({ ...envelope, ...event });
    } catch {
      // Observability callbacks must never alter dependency recovery.
    }
  }
}

/** Stable, credential-free failure for operations that require a ready dependency. */
export class DependencyUnavailableError extends Error {
  readonly dependency: string;
  readonly code: string;

  constructor(dependency: string, code: string, message: string) {
    super(message);
    this.name = 'DependencyUnavailableError';
    this.dependency = dependency;
    this.code = code;
  }
}

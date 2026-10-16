interface RepositoryReadinessOptions {
  isReady: () => boolean;
  bootstrap: () => Promise<boolean>;
  cooldownMs: number;
  onError: (error: unknown) => void;
  now?: () => number;
}

interface DatabaseRepositoryReadinessOptions<Pool> {
  getPool: () => Pool | null;
  isDatabaseConnected: () => boolean;
  isDatabaseSchemaReady: () => boolean;
  initializeDatabase: (workerId: string) => Promise<boolean>;
  initializeTables: () => Promise<boolean>;
  workerId: string;
  cooldownMs: number;
  onError: (error: unknown) => void;
  now?: () => number;
}

/**
 * Keep one repository's bootstrap, failure cooldown, and cleanup together.
 * Callbacks preserve repository-specific retries and failure reporting without
 * importing database or logging lifecycles into this module.
 * Each returned gate owns its pending attempt and cooldown; successful readiness
 * is never cached, and bootstrap success must also pass the live readiness check.
 * Failed attempts return false and start the cooldown, including at clock zero.
 * A throwing error reporter propagates its error, but still releases the attempt.
 */
export function createRepositoryReadinessGate({
  isReady,
  bootstrap,
  cooldownMs,
  onError,
  now = () => Date.now()
}: RepositoryReadinessOptions): () => Promise<boolean> {
  let pendingBootstrap: Promise<boolean> | null = null;
  let lastBootstrapFailureAtMs: number | null = null;

  return function ensureReady(): Promise<boolean> {
    //audit Assumption: readiness can change with the global pool; failure risk: cached success survives pool replacement; invariant: every fast path consults current shared readiness; handling: never cache successful readiness locally.
    if (isReady()) {
      return Promise.resolve(true);
    }

    //audit Assumption: an active recovery must take precedence over an earlier failure; failure risk: followers fail closed during bootstrap; invariant: all followers await the active promise before considering cooldown; handling: check pending first.
    if (pendingBootstrap) {
      return pendingBootstrap;
    }

    if (lastBootstrapFailureAtMs !== null && now() - lastBootstrapFailureAtMs < cooldownMs) {
      return Promise.resolve(false);
    }

    const initialization = (async () => {
      try {
        const bootstrapped = await bootstrap();
        const ready = bootstrapped && isReady();
        lastBootstrapFailureAtMs = ready ? null : now();
        return ready;
      } catch (error: unknown) {
        lastBootstrapFailureAtMs = now();
        onError(error);
        return false;
      }
    })();
    pendingBootstrap = initialization;

    //audit Assumption: bootstrap callbacks can throw before their first await; failure risk: a synchronous catch clears state before the promise is assigned, stranding a settled promise; invariant: every settled attempt releases its exact pending promise; handling: register cleanup only after assignment, on both fulfillment and rejection.
    const clearPending = () => {
      if (pendingBootstrap === initialization) {
        pendingBootstrap = null;
      }
    };
    void initialization.then(clearPending, clearPending);

    return initialization;
  };
}

/**
 * Build the standard single-attempt gate for repositories sharing schema setup.
 * Session persistence keeps its bounded retry and captured-pool cleanup callback.
 * Injected callbacks supply the current pool, connectivity, schema state, and
 * initialization. True requires schema success for the same captured pool and
 * current readiness; disconnection, replacement, or initialization failure
 * returns false without admitting repository writes.
 */
export function createDatabaseRepositoryReadinessGate<Pool>(
  options: DatabaseRepositoryReadinessOptions<Pool>
): () => Promise<boolean> {
  const isReady = () => options.isDatabaseConnected() && options.isDatabaseSchemaReady();

  return createRepositoryReadinessGate({
    isReady,
    cooldownMs: options.cooldownMs,
    onError: options.onError,
    now: options.now,
    bootstrap: async () => {
      if (!options.isDatabaseConnected()) {
        await options.initializeDatabase(options.workerId);
      }

      if (!options.isDatabaseConnected()) {
        return false;
      }

      const bootstrapPool = options.getPool();
      if (!bootstrapPool) {
        return false;
      }

      const tablesInitialized = await options.initializeTables();
      //audit Assumption: schema work can finish after the pool changes; failure risk: a stale completion permits writes to an unready replacement; invariant: readiness belongs to the captured current pool; handling: check identity and live schema readiness after initialization.
      return tablesInitialized && options.getPool() === bootstrapPool && isReady();
    }
  });
}

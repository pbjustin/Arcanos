import { describe, expect, it, jest } from '@jest/globals';

type DagRepositoryKind = 'artifact' | 'run';

interface DagRepositoryHarness {
  invokeRead: () => Promise<unknown>;
  initializeDatabaseMock: jest.Mock<(workerId: string) => Promise<boolean>>;
  initializeTablesMock: jest.Mock<() => Promise<boolean>>;
  queryMock: jest.Mock;
  state: {
    connected: boolean;
    pool: object | null;
    schemaReady: boolean;
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function loadDagRepositoryHarness(
  kind: DagRepositoryKind,
  options?: {
    connectedInitially?: boolean;
    schemaReadyInitially?: boolean;
    initializeDatabaseImpl?: (state: DagRepositoryHarness['state']) => Promise<boolean>;
    initializeTablesImpl?: (state: DagRepositoryHarness['state']) => Promise<boolean>;
  }
): Promise<DagRepositoryHarness> {
  jest.resetModules();

  const connectedInitially = options?.connectedInitially ?? false;
  const state: DagRepositoryHarness['state'] = {
    connected: connectedInitially,
    pool: connectedInitially ? {} : null,
    schemaReady: options?.schemaReadyInitially ?? false
  };
  const getPoolMock = jest.fn<() => object | null>(() => state.pool);
  const isDatabaseConnectedMock = jest.fn<() => boolean>(() => state.connected);
  const isDatabaseSchemaReadyMock = jest.fn<() => boolean>(() => state.schemaReady);
  const initializeDatabaseMock = jest.fn<(workerId: string) => Promise<boolean>>(async () => {
    if (options?.initializeDatabaseImpl) {
      return options.initializeDatabaseImpl(state);
    }

    state.connected = true;
    state.pool = {};
    return true;
  });
  const initializeTablesMock = jest.fn<() => Promise<boolean>>(async () => {
    if (options?.initializeTablesImpl) {
      return options.initializeTablesImpl(state);
    }

    state.schemaReady = true;
    return true;
  });
  const queryMock = jest.fn(async () => ({ rows: [], rowCount: 0 }));

  jest.unstable_mockModule('@core/db/client.js', () => ({
    getPool: getPoolMock,
    initializeDatabase: initializeDatabaseMock,
    isDatabaseConnected: isDatabaseConnectedMock
  }));
  jest.unstable_mockModule('@core/db/schema.js', () => ({
    initializeTables: initializeTablesMock,
    isDatabaseSchemaReady: isDatabaseSchemaReadyMock
  }));
  jest.unstable_mockModule('@core/db/query.js', () => ({
    query: queryMock
  }));

  if (kind === 'artifact') {
    const repository = await import('../src/core/db/repositories/dagArtifactRepository.js');
    return {
      invokeRead: () => repository.getDagArtifactPayloadByReference('artifact-1'),
      initializeDatabaseMock,
      initializeTablesMock,
      queryMock,
      state
    };
  }

  const repository = await import('../src/core/db/repositories/dagRunRepository.js');
  return {
    invokeRead: () => repository.getDagRunSnapshotById('run-1'),
    initializeDatabaseMock,
    initializeTablesMock,
    queryMock,
    state
  };
}

describe.each([
  ['DAG artifact repository', 'artifact', 'dag-artifacts'],
  ['DAG run repository', 'run', 'dag-runs']
] as const)('%s persistence bootstrap', (_label, kind, workerId) => {
  it('uses a centrally ready connected pool without bootstrapping again', async () => {
    const harness = await loadDagRepositoryHarness(kind, {
      connectedInitially: true,
      schemaReadyInitially: true
    });

    await harness.invokeRead();

    expect(harness.initializeDatabaseMock).not.toHaveBeenCalled();
    expect(harness.initializeTablesMock).not.toHaveBeenCalled();
    expect(harness.queryMock).toHaveBeenCalledTimes(1);
  });

  it('initializes schema without reconnecting when the current pool is connected but not ready', async () => {
    const harness = await loadDagRepositoryHarness(kind, {
      connectedInitially: true,
      schemaReadyInitially: false
    });

    await harness.invokeRead();

    expect(harness.initializeDatabaseMock).not.toHaveBeenCalled();
    expect(harness.initializeTablesMock).toHaveBeenCalledTimes(1);
    expect(harness.queryMock).toHaveBeenCalledTimes(1);
  });

  it('connects only when needed and verifies central readiness before querying', async () => {
    const harness = await loadDagRepositoryHarness(kind);

    await harness.invokeRead();

    expect(harness.initializeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(harness.initializeDatabaseMock).toHaveBeenCalledWith(workerId);
    expect(harness.initializeTablesMock).toHaveBeenCalledTimes(1);
    expect(harness.queryMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed and enters cooldown when shared schema initialization returns false', async () => {
    const harness = await loadDagRepositoryHarness(kind, {
      connectedInitially: true,
      initializeTablesImpl: async () => false
    });

    await harness.invokeRead();
    await harness.invokeRead();

    expect(harness.initializeDatabaseMock).not.toHaveBeenCalled();
    expect(harness.initializeTablesMock).toHaveBeenCalledTimes(1);
    expect(harness.queryMock).not.toHaveBeenCalled();
  });

  it('shares an active retry before reapplying the prior failure cooldown', async () => {
    let nowMs = 1_000;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const retry = deferred<boolean>();
    let initializationAttempt = 0;
    const harness = await loadDagRepositoryHarness(kind, {
      connectedInitially: true,
      initializeTablesImpl: async state => {
        initializationAttempt += 1;
        if (initializationAttempt === 1) {
          return false;
        }

        const initialized = await retry.promise;
        state.schemaReady = initialized;
        return initialized;
      }
    });

    try {
      await harness.invokeRead();
      expect(harness.initializeTablesMock).toHaveBeenCalledTimes(1);
      expect(harness.queryMock).not.toHaveBeenCalled();

      nowMs += 30_001;
      const leader = harness.invokeRead();
      await Promise.resolve();
      expect(harness.initializeTablesMock).toHaveBeenCalledTimes(2);

      nowMs = 1_001;
      const follower = harness.invokeRead();
      retry.resolve(true);

      await expect(Promise.all([leader, follower])).resolves.toEqual([
        null,
        null
      ]);
      expect(harness.initializeDatabaseMock).not.toHaveBeenCalled();
      expect(harness.initializeTablesMock).toHaveBeenCalledTimes(2);
      expect(harness.queryMock).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('rejects stale success when the current pool changes during schema initialization', async () => {
    const replacementPool = {};
    const harness = await loadDagRepositoryHarness(kind, {
      connectedInitially: true,
      initializeTablesImpl: async state => {
        state.pool = replacementPool;
        state.schemaReady = true;
        return true;
      }
    });

    await harness.invokeRead();

    expect(harness.initializeTablesMock).toHaveBeenCalledTimes(1);
    expect(harness.queryMock).not.toHaveBeenCalled();
  });
});

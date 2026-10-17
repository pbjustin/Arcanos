import { describe, expect, it, jest } from '@jest/globals';
import {
  createDatabaseRepositoryReadinessGate,
  createRepositoryReadinessGate
} from '../src/core/db/repositoryReadiness.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function databaseHarness() {
  const state = {
    nowMs: 1_000,
    connected: true,
    pool: {} as object | null,
    readyPool: null as object | null
  };
  const initializeDatabase = jest.fn(async (_workerId: string) => {
    state.pool = {};
    state.connected = true;
    return true;
  });
  const initializeTables = jest.fn(async () => {
    state.readyPool = state.pool;
    return true;
  });
  const onError = jest.fn();
  const ensureReady = createDatabaseRepositoryReadinessGate({
    getPool: () => state.pool,
    isDatabaseConnected: () => state.connected,
    isDatabaseSchemaReady: () => state.pool !== null && state.readyPool === state.pool,
    initializeDatabase,
    initializeTables,
    workerId: 'fixture-repository',
    cooldownMs: 30_000,
    now: () => state.nowMs,
    onError
  });
  return { state, initializeDatabase, initializeTables, onError, ensureReady };
}

describe('database repository readiness', () => {
  it('uses the current connected ready pool without bootstrapping', async () => {
    const harness = databaseHarness();
    harness.state.readyPool = harness.state.pool;

    await expect(harness.ensureReady()).resolves.toBe(true);
    expect(harness.initializeDatabase).not.toHaveBeenCalled();
    expect(harness.initializeTables).not.toHaveBeenCalled();
  });

  it('connects a disconnected database with the repository worker ID before schema setup', async () => {
    const harness = databaseHarness();
    harness.state.connected = false;
    harness.state.pool = null;
    harness.initializeTables.mockImplementation(async () => {
      expect(harness.state.connected).toBe(true);
      expect(harness.state.pool).not.toBeNull();
      harness.state.readyPool = harness.state.pool;
      return true;
    });

    await expect(harness.ensureReady()).resolves.toBe(true);
    expect(harness.initializeDatabase).toHaveBeenCalledWith('fixture-repository');
    expect(harness.initializeTables).toHaveBeenCalledTimes(1);
  });

  it('uses live connectivity instead of a stale database initialization result', async () => {
    const harness = databaseHarness();
    harness.state.connected = false;
    harness.initializeDatabase.mockResolvedValue(true);

    await expect(harness.ensureReady()).resolves.toBe(false);
    await expect(harness.ensureReady()).resolves.toBe(false);
    expect(harness.initializeDatabase).toHaveBeenCalledTimes(1);
    expect(harness.initializeTables).not.toHaveBeenCalled();
  });

  it('accepts current connectivity even when initialization returns a stale false result', async () => {
    const harness = databaseHarness();
    harness.state.connected = false;
    harness.initializeDatabase.mockImplementation(async () => {
      harness.state.connected = true;
      return false;
    });

    await expect(harness.ensureReady()).resolves.toBe(true);
    expect(harness.initializeTables).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a current pool even if connectivity reports true', async () => {
    const harness = databaseHarness();
    harness.state.pool = null;

    await expect(harness.ensureReady()).resolves.toBe(false);
    expect(harness.initializeTables).not.toHaveBeenCalled();
  });

  it('shares the exact active promise and does not permit readiness before schema completes', async () => {
    const harness = databaseHarness();
    const schema = deferred<boolean>();
    harness.initializeTables.mockImplementation(async () => {
      const ready = await schema.promise;
      harness.state.readyPool = harness.state.pool;
      return ready;
    });

    const leader = harness.ensureReady();
    const follower = harness.ensureReady();
    expect(follower).toBe(leader);
    expect(harness.initializeTables).toHaveBeenCalledTimes(1);
    schema.resolve(true);
    await expect(Promise.all([leader, follower])).resolves.toEqual([true, true]);
  });

  it('coalesces disconnected database initialization before schema initialization', async () => {
    const harness = databaseHarness();
    const connection = deferred<boolean>();
    harness.state.connected = false;
    harness.initializeDatabase.mockImplementation(async () => {
      await connection.promise;
      harness.state.connected = true;
      return true;
    });

    const leader = harness.ensureReady();
    const follower = harness.ensureReady();
    expect(follower).toBe(leader);
    expect(harness.initializeTables).not.toHaveBeenCalled();
    connection.resolve(true);
    await expect(leader).resolves.toBe(true);
    expect(harness.initializeDatabase).toHaveBeenCalledTimes(1);
    expect(harness.initializeTables).toHaveBeenCalledTimes(1);
  });

  it('keeps failed database initialization in cooldown until its exact deadline', async () => {
    const harness = databaseHarness();
    harness.state.connected = false;
    harness.initializeDatabase.mockResolvedValue(false);

    await expect(harness.ensureReady()).resolves.toBe(false);
    harness.state.nowMs += 29_999;
    await expect(harness.ensureReady()).resolves.toBe(false);
    expect(harness.initializeDatabase).toHaveBeenCalledTimes(1);
    harness.state.nowMs += 1;
    await expect(harness.ensureReady()).resolves.toBe(false);
    expect(harness.initializeDatabase).toHaveBeenCalledTimes(2);
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it('fails closed after a false schema result even if readiness is claimed', async () => {
    const harness = databaseHarness();
    harness.initializeTables.mockImplementation(async () => {
      harness.state.readyPool = harness.state.pool;
      return false;
    });

    await expect(harness.ensureReady()).resolves.toBe(false);
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it('fails closed when schema completion does not establish central readiness', async () => {
    const harness = databaseHarness();
    harness.initializeTables.mockResolvedValue(true);

    await expect(harness.ensureReady()).resolves.toBe(false);
    await expect(harness.ensureReady()).resolves.toBe(false);
    expect(harness.initializeTables).toHaveBeenCalledTimes(1);
  });

  it('rejects completion from a replaced pool, even when the replacement claims readiness', async () => {
    const harness = databaseHarness();
    const schema = deferred<boolean>();
    harness.initializeTables.mockReturnValue(schema.promise);

    const attempt = harness.ensureReady();
    harness.state.pool = {};
    harness.state.readyPool = harness.state.pool;
    schema.resolve(true);

    await expect(attempt).resolves.toBe(false);
  });

  it('rejects a disconnect during schema initialization', async () => {
    const harness = databaseHarness();
    harness.initializeTables.mockImplementation(async () => {
      harness.state.readyPool = harness.state.pool;
      harness.state.connected = false;
      return true;
    });

    await expect(harness.ensureReady()).resolves.toBe(false);
  });

  it('rechecks central readiness after every previously successful call and pool replacement', async () => {
    const harness = databaseHarness();
    await expect(harness.ensureReady()).resolves.toBe(true);
    harness.state.pool = {};
    await expect(harness.ensureReady()).resolves.toBe(true);

    expect(harness.initializeTables).toHaveBeenCalledTimes(2);
  });

  it.each(['database', 'schema'] as const)('reports %s exceptions once and recovers after cooldown', async stage => {
    const harness = databaseHarness();
    const failure = new Error(`${stage} fixture failure`);
    if (stage === 'database') {
      harness.state.connected = false;
      harness.initializeDatabase.mockRejectedValueOnce(failure);
    } else {
      harness.initializeTables.mockRejectedValueOnce(failure);
    }

    await expect(harness.ensureReady()).resolves.toBe(false);
    await expect(harness.ensureReady()).resolves.toBe(false);
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(harness.onError).toHaveBeenCalledWith(failure);
    harness.state.nowMs += 30_000;
    await expect(harness.ensureReady()).resolves.toBe(true);
  });

  it('shares an active recovery before considering the previous failure cooldown', async () => {
    const harness = databaseHarness();
    harness.initializeTables.mockResolvedValueOnce(false);
    await expect(harness.ensureReady()).resolves.toBe(false);
    harness.state.nowMs += 30_000;
    const schema = deferred<boolean>();
    harness.initializeTables.mockImplementationOnce(async () => {
      await schema.promise;
      harness.state.readyPool = harness.state.pool;
      return true;
    });
    const leader = harness.ensureReady();
    harness.state.nowMs = 1_001;
    const follower = harness.ensureReady();
    expect(follower).toBe(leader);
    schema.resolve(true);
    await expect(follower).resolves.toBe(true);

    // A success must clear the old failure even if the injected clock moved back.
    harness.state.pool = {};
    await expect(harness.ensureReady()).resolves.toBe(true);
    expect(harness.initializeTables).toHaveBeenCalledTimes(3);
  });
});

describe('repository readiness lifecycle', () => {
  it('revalidates readiness after a custom bootstrap claims success', async () => {
    const ensureReady = createRepositoryReadinessGate({
      isReady: () => false,
      bootstrap: async () => true,
      cooldownMs: 30_000,
      now: () => 1_000,
      onError: jest.fn()
    });

    await expect(ensureReady()).resolves.toBe(false);
  });

  it('records a failure at clock zero and clears a synchronously failed attempt', async () => {
    let nowMs = 0;
    let ready = false;
    const failure = Symbol('unusual thrown value');
    const bootstrap = jest.fn<() => Promise<boolean>>(() => { throw failure; });
    const onError = jest.fn();
    const ensureReady = createRepositoryReadinessGate({
      isReady: () => ready,
      bootstrap,
      cooldownMs: 30_000,
      now: () => nowMs,
      onError
    });

    await expect(ensureReady()).resolves.toBe(false);
    await expect(ensureReady()).resolves.toBe(false);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    nowMs = 30_000;
    bootstrap.mockImplementation(async () => { ready = true; return true; });
    await expect(ensureReady()).resolves.toBe(true);
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });

  it('cleans up even when failure reporting itself throws', async () => {
    let nowMs = 1_000;
    let ready = false;
    const reportFailure = new Error('reporting fixture failure');
    const bootstrap = jest.fn<() => Promise<boolean>>(() => { throw new Error('bootstrap'); });
    const ensureReady = createRepositoryReadinessGate({
      isReady: () => ready,
      bootstrap,
      cooldownMs: 30_000,
      now: () => nowMs,
      onError: () => { throw reportFailure; }
    });

    await expect(ensureReady()).rejects.toBe(reportFailure);
    nowMs += 30_000;
    bootstrap.mockImplementation(async () => { ready = true; return true; });
    await expect(ensureReady()).resolves.toBe(true);
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });
});

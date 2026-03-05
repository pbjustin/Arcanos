import { describe, expect, it, jest } from '@jest/globals';

type SelfReflectionRepositoryModule = typeof import('../src/core/db/repositories/selfReflectionRepository.js');

interface RepositoryHarness {
  module: SelfReflectionRepositoryModule;
  isDatabaseConnectedMock: jest.Mock<() => boolean>;
  initializeDatabaseMock: jest.Mock<(workerId: string) => Promise<boolean>>;
  initializeTablesMock: jest.Mock<() => Promise<void>>;
  queryMock: jest.Mock;
  dbState: { connected: boolean };
}

/**
 * Load self-reflection repository with isolated DB dependency mocks.
 *
 * Purpose: provide deterministic branch coverage for DB bootstrap/persistence behavior.
 * Inputs/outputs: initial connection state and init implementation -> imported module + mocks.
 * Edge cases: each call resets module cache to avoid sharing bootstrap cooldown state.
 */
async function loadRepositoryHarness(options?: {
  connectedInitially?: boolean;
  initializeDatabaseImpl?: (dbState: { connected: boolean }) => Promise<boolean>;
}): Promise<RepositoryHarness> {
  jest.resetModules();

  const dbState = { connected: options?.connectedInitially ?? false };
  const isDatabaseConnectedMock = jest.fn<() => boolean>(() => dbState.connected);
  const initializeDatabaseMock = jest.fn<(workerId: string) => Promise<boolean>>(async () => {
    if (!options?.initializeDatabaseImpl) {
      return false;
    }
    return options.initializeDatabaseImpl(dbState);
  });
  const initializeTablesMock = jest.fn<() => Promise<void>>(async () => undefined);
  const queryMock = jest.fn(async () => ({ rows: [], rowCount: 1 }));

  jest.unstable_mockModule('@core/db/client.js', () => ({
    isDatabaseConnected: isDatabaseConnectedMock,
    initializeDatabase: initializeDatabaseMock
  }));
  jest.unstable_mockModule('@core/db/schema.js', () => ({
    initializeTables: initializeTablesMock
  }));
  jest.unstable_mockModule('@core/db/query.js', () => ({
    query: queryMock
  }));

  const module = await import('../src/core/db/repositories/selfReflectionRepository.js');
  return {
    module,
    isDatabaseConnectedMock,
    initializeDatabaseMock,
    initializeTablesMock,
    queryMock,
    dbState
  };
}

describe('selfReflectionRepository persistence bootstrap', () => {
  it('bootstraps DB connectivity and persists reflection when not yet connected', async () => {
    const harness = await loadRepositoryHarness({
      connectedInitially: false,
      initializeDatabaseImpl: async dbState => {
        dbState.connected = true;
        return true;
      }
    });

    await harness.module.saveSelfReflection({
      priority: 'high',
      category: 'test',
      content: 'reflection content',
      improvements: ['one', 'two'],
      metadata: { source: 'unit-test' }
    });

    expect(harness.initializeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(harness.initializeDatabaseMock).toHaveBeenCalledWith('self-reflections');
    expect(harness.initializeTablesMock).toHaveBeenCalledTimes(1);
    expect(harness.queryMock).toHaveBeenCalledTimes(1);
  });

  it('persists directly when DB is already connected', async () => {
    const harness = await loadRepositoryHarness({
      connectedInitially: true
    });

    await harness.module.saveSelfReflection({
      priority: 'medium',
      category: 'test',
      content: 'existing connection',
      improvements: [],
      metadata: {}
    });

    expect(harness.initializeDatabaseMock).not.toHaveBeenCalled();
    expect(harness.initializeTablesMock).not.toHaveBeenCalled();
    expect(harness.queryMock).toHaveBeenCalledTimes(1);
  });

  it('throttles repeated bootstrap attempts after a failed initialization', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = await loadRepositoryHarness({
      connectedInitially: false,
      initializeDatabaseImpl: async () => false
    });

    try {
      await harness.module.saveSelfReflection({
        priority: 'low',
        category: 'failure-test',
        content: 'first attempt',
        improvements: [],
        metadata: {}
      });
      await harness.module.saveSelfReflection({
        priority: 'low',
        category: 'failure-test',
        content: 'second attempt',
        improvements: [],
        metadata: {}
      });
    } finally {
      warnSpy.mockRestore();
    }

    expect(harness.initializeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(harness.queryMock).not.toHaveBeenCalled();
  });

  it('loads recent reflections by category with normalized JSON fields', async () => {
    const harness = await loadRepositoryHarness({
      connectedInitially: true
    });

    harness.queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'r-1',
          priority: 'high',
          category: 'judged-response',
          content: 'response text',
          improvements: '["improve clarity","add examples"]',
          metadata: '{"accepted":true,"normalizedScore":0.91}',
          created_at: '2026-03-05T00:00:00.000Z'
        }
      ],
      rowCount: 1
    });

    const rows = await harness.module.loadRecentSelfReflectionsByCategory('judged-response', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'r-1',
      category: 'judged-response',
      improvements: ['improve clarity', 'add examples'],
      metadata: { accepted: true, normalizedScore: 0.91 }
    });
  });
});

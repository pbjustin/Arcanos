import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type MemoryRepositoryModule = typeof import('../src/core/db/repositories/memoryRepository.js');

interface MemoryRepositoryHarness {
  module: MemoryRepositoryModule;
  isDatabaseConnectedMock: jest.Mock<() => boolean>;
  queryMock: jest.Mock;
}

/**
 * Load the memory repository with isolated database dependency mocks.
 * Inputs/outputs: optional connected state -> imported repository module plus DB mocks.
 * Edge cases: resets module cache so TTL validation state cannot leak across tests.
 */
async function loadMemoryRepositoryHarness(connected = true): Promise<MemoryRepositoryHarness> {
  jest.resetModules();

  const isDatabaseConnectedMock = jest.fn<() => boolean>(() => connected);
  const queryMock = jest.fn(async () => ({
    rows: [],
    rowCount: 0
  }));

  jest.unstable_mockModule('@core/db/client.js', () => ({
    isDatabaseConnected: isDatabaseConnectedMock
  }));
  jest.unstable_mockModule('@core/db/query.js', () => ({
    query: queryMock
  }));

  const module = await import('../src/core/db/repositories/memoryRepository.js');
  return {
    module,
    isDatabaseConnectedMock,
    queryMock
  };
}

describe('memoryRepository TTL persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists ttlSeconds as the third query parameter when saving memory', async () => {
    const harness = await loadMemoryRepositoryHarness(true);
    harness.queryMock.mockResolvedValueOnce({
      rows: [
        {
          key: 'memory:ttl',
          updated_at: '2026-03-08T01:10:00.000Z',
          expires_at: '2026-03-08T01:11:00.000Z'
        }
      ],
      rowCount: 1
    });

    await harness.module.saveMemory('memory:ttl', { summary: 'test' }, { ttlSeconds: 60 });

    expect(harness.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('expires_at'),
      ['memory:ttl', expect.any(String), 60]
    );
    expect(JSON.parse(harness.queryMock.mock.calls[0][1][1] as string)).toEqual(
      expect.objectContaining({
        payload: { summary: 'test' },
        metadata: expect.objectContaining({
          versionId: expect.any(String),
          monotonicTimestampMs: expect.any(Number)
        })
      })
    );
  });

  it('stores null expiry when ttlSeconds is omitted', async () => {
    const harness = await loadMemoryRepositoryHarness(true);
    harness.queryMock.mockResolvedValueOnce({
      rows: [
        {
          key: 'memory:persistent',
          updated_at: '2026-03-08T01:12:00.000Z',
          expires_at: null
        }
      ],
      rowCount: 1
    });

    await harness.module.saveMemory('memory:persistent', { pinned: true });

    expect(harness.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('CASE WHEN $3::INTEGER IS NULL THEN NULL'),
      ['memory:persistent', expect.any(String), null]
    );
  });

  it('rejects invalid ttlSeconds before issuing a database query', async () => {
    const harness = await loadMemoryRepositoryHarness(true);

    await expect(
      harness.module.saveMemory('memory:invalid', { bad: true }, { ttlSeconds: 0 })
    ).rejects.toThrow('Invalid memory TTL seconds: 0');
    expect(harness.queryMock).not.toHaveBeenCalled();
  });

  it('filters expired rows out of loadMemory reads', async () => {
    const harness = await loadMemoryRepositoryHarness(true);
    harness.queryMock.mockResolvedValueOnce({
      rows: [
        {
          value: {
            metadata: {
              versionId: 'memory-2',
              monotonicTimestampMs: 10
            },
            payload: {
              answer: 42
            }
          }
        }
      ],
      rowCount: 1
    });

    const value = await harness.module.loadMemory('memory:load');

    expect(value).toEqual({ answer: 42 });
    expect(harness.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('(expires_at IS NULL OR expires_at > NOW())'),
      ['memory:load'],
      1,
      false
    );
  });
});

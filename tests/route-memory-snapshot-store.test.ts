import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  createRouteMemorySnapshotStore,
  DISPATCH_V9_SNAPSHOT_KEY
} from '../src/services/routeMemorySnapshotStore.js';
import type { DispatchMemorySnapshotV9 } from '../src/types/dispatchV9.js';

function createSnapshotFixture(
  memoryVersion: string,
  routeAttempted: string,
  expectedRoute: string
): DispatchMemorySnapshotV9 {
  return {
    schema_version: 'v9',
    bindings_version: 'bindings-v9-test',
    memory_version: memoryVersion,
    route_state: {
      [routeAttempted]: {
        expected_route: expectedRoute,
        last_validated_at: memoryVersion,
        hard_conflict: false
      }
    },
    updated_at: memoryVersion,
    updated_by: 'test'
  };
}

describe('routeMemorySnapshotStore', () => {
  let dbValue: unknown | null;
  let memoryUpdatedAt: string;
  let nowCounter: number;

  const timestamps = [
    '2026-02-06T01:00:00.000Z',
    '2026-02-06T01:00:01.000Z',
    '2026-02-06T01:00:02.000Z',
    '2026-02-06T01:00:03.000Z',
    '2026-02-06T01:00:04.000Z',
    '2026-02-06T01:00:05.000Z',
    '2026-02-06T01:00:06.000Z'
  ];

  const now = () => {
    const index = Math.min(nowCounter, timestamps.length - 1);
    nowCounter += 1;
    return new Date(timestamps[index]);
  };

  const loadMemoryEntry = jest.fn(async () => dbValue);
  const saveMemoryEntry = jest.fn(async (_key: string, value: unknown) => {
    dbValue = value;
    memoryUpdatedAt = timestamps[Math.min(nowCounter, timestamps.length - 1)];
    return { updated_at: memoryUpdatedAt } as unknown;
  });
  const queryRunner = jest.fn(async () => ({ rows: [{ updated_at: memoryUpdatedAt }] } as { rows: Array<{ updated_at: string }> }));

  beforeEach(() => {
    dbValue = null;
    memoryUpdatedAt = timestamps[0];
    nowCounter = 0;
    loadMemoryEntry.mockClear();
    saveMemoryEntry.mockClear();
    queryRunner.mockClear();
  });

  it('creates missing snapshot and supports route-state upsert roundtrip', async () => {
    const store = createRouteMemorySnapshotStore({
      snapshotKey: DISPATCH_V9_SNAPSHOT_KEY,
      bindingsVersion: 'bindings-v9-test',
      cacheTtlMs: 0,
      loadMemoryEntry,
      saveMemoryEntry,
      queryRunner,
      now
    });

    const created = await store.getSnapshot();
    expect(created.loadedFrom).toBe('created');
    expect(created.snapshot.schema_version).toBe('v9');

    await store.upsertRouteState('POST /api/ask', 'POST /api/ask', {
      updatedBy: 'middleware'
    });

    const refreshed = await store.getSnapshot({ forceRefresh: true });
    expect(refreshed.snapshot.route_state['POST /api/ask']).toEqual(
      expect.objectContaining({
        expected_route: 'POST /api/ask',
        hard_conflict: false
      })
    );
    expect(refreshed.memoryVersion).toBe(memoryUpdatedAt);
    expect(saveMemoryEntry).toHaveBeenCalled();
  });

  it('extracts memory_version from memory row updated_at metadata', async () => {
    const dbVersion = '2026-02-06T02:30:00.000Z';
    dbValue = createSnapshotFixture('2026-02-06T01:59:59.000Z', 'POST /api/ask', 'POST /api/ask');
    memoryUpdatedAt = dbVersion;

    const store = createRouteMemorySnapshotStore({
      snapshotKey: DISPATCH_V9_SNAPSHOT_KEY,
      bindingsVersion: 'bindings-v9-test',
      cacheTtlMs: 0,
      loadMemoryEntry,
      saveMemoryEntry,
      queryRunner,
      now
    });

    const record = await store.getSnapshot({ forceRefresh: true });
    expect(record.loadedFrom).toBe('db');
    expect(record.memoryVersion).toBe(dbVersion);
    expect(record.snapshot.memory_version).toBe(dbVersion);
  });

  it('recreates default snapshot when payload is missing or corrupt', async () => {
    dbValue = 'not-a-valid-snapshot';

    const store = createRouteMemorySnapshotStore({
      snapshotKey: DISPATCH_V9_SNAPSHOT_KEY,
      bindingsVersion: 'bindings-v9-test',
      cacheTtlMs: 0,
      loadMemoryEntry,
      saveMemoryEntry,
      queryRunner,
      now
    });

    const record = await store.getSnapshot({ forceRefresh: true });
    expect(record.loadedFrom).toBe('created');
    expect(record.snapshot.schema_version).toBe('v9');
    expect(record.snapshot.route_state).toEqual({});
    expect(saveMemoryEntry).toHaveBeenCalledTimes(1);
  });
});


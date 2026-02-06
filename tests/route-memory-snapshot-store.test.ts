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

  // Use stable past dates as test fixtures representing sequential "now" values
  const baseTimestamp = new Date('2000-01-01T00:00:00.000Z');
  const timestamps = Array.from({ length: 7 }, (_v, i) =>
    new Date(baseTimestamp.getTime() + i * 1000).toISOString()
  );

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
    const dbVersion = '2000-01-01T01:30:00.000Z';
    dbValue = createSnapshotFixture('2000-01-01T00:59:59.000Z', 'POST /api/ask', 'POST /api/ask');
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
  it('evicts oldest routes when MAX_ROUTES limit is reached', async () => {
    // Build a snapshot with route_state at the limit
    const MAX_ROUTES = 5000;
    const routeState: Record<string, { expected_route: string; last_validated_at: string; hard_conflict: boolean }> = {};
    for (let i = 0; i < MAX_ROUTES; i++) {
      const route = `POST /api/route-${i}`;
      routeState[route] = {
        expected_route: route,
        last_validated_at: new Date(baseTimestamp.getTime() + i * 100).toISOString(),
        hard_conflict: false
      };
    }

    dbValue = {
      schema_version: 'v9',
      bindings_version: 'bindings-v9-test',
      memory_version: timestamps[0],
      route_state: routeState,
      updated_at: timestamps[0],
      updated_by: 'test'
    };

    const store = createRouteMemorySnapshotStore({
      snapshotKey: DISPATCH_V9_SNAPSHOT_KEY,
      bindingsVersion: 'bindings-v9-test',
      cacheTtlMs: 0,
      loadMemoryEntry,
      saveMemoryEntry,
      queryRunner,
      now
    });

    // Upsert a new route beyond the limit — should trigger eviction
    const result = await store.upsertRouteState('POST /api/new-route', 'POST /api/new-route', {
      updatedBy: 'test'
    });

    // The new route should exist in the snapshot
    expect(result.snapshot.route_state['POST /api/new-route']).toBeDefined();
    // Oldest routes should have been evicted (500 evicted, 1 added = 4501 total)
    const routeCount = Object.keys(result.snapshot.route_state).length;
    expect(routeCount).toBeLessThanOrEqual(MAX_ROUTES - 500 + 1);
    // The oldest route (route-0) should have been evicted
    expect(result.snapshot.route_state['POST /api/route-0']).toBeUndefined();
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


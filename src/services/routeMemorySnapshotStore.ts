import config from '../config/index.js';
import { DISPATCH_BINDINGS_VERSION } from '../config/dispatchPatterns.js';
import { loadMemory, query, saveMemory } from '../db/index.js';
import { logger } from '../utils/structuredLogging.js';
import type {
  DispatchMemorySnapshotV9,
  DispatchRouteStateV9
} from '../types/dispatchV9.js';

export const DISPATCH_V9_SNAPSHOT_KEY = 'dispatch:v9:snapshot:global';

export interface RouteMemorySnapshotRecord {
  snapshot: DispatchMemorySnapshotV9;
  memoryVersion: string;
  loadedFrom: 'cache' | 'db' | 'created';
}

interface RouteMemorySnapshotStoreDependencies {
  snapshotKey: string;
  bindingsVersion: string;
  cacheTtlMs: number;
  loadMemoryEntry: typeof loadMemory;
  saveMemoryEntry: typeof saveMemory;
  queryRunner: typeof query;
  now: () => Date;
}

interface SnapshotCacheEntry {
  expiresAt: number;
  record: RouteMemorySnapshotRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIsoDate(value: unknown, fallbackIso: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return fallbackIso;
}

function normalizeRouteState(raw: unknown): Record<string, DispatchRouteStateV9> {
  if (!isRecord(raw)) {
    return {};
  }

  const routeState: Record<string, DispatchRouteStateV9> = {};

  for (const [routeKey, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      continue;
    }
    const expectedRoute = typeof value.expected_route === 'string' ? value.expected_route : routeKey;
    const lastValidatedAt = toIsoDate(value.last_validated_at, new Date().toISOString());
    const hardConflict = Boolean(value.hard_conflict);
    routeState[routeKey] = {
      expected_route: expectedRoute,
      last_validated_at: lastValidatedAt,
      hard_conflict: hardConflict
    };
  }

  return routeState;
}

function createDefaultSnapshot(bindingsVersion: string, nowIso: string, updatedBy = 'middleware'): DispatchMemorySnapshotV9 {
  return {
    schema_version: 'v9',
    bindings_version: bindingsVersion,
    memory_version: nowIso,
    route_state: {},
    updated_at: nowIso,
    updated_by: updatedBy
  };
}

function normalizeSnapshot(
  raw: unknown,
  bindingsVersion: string,
  nowIso: string
): DispatchMemorySnapshotV9 | null {
  if (!isRecord(raw)) {
    return null;
  }

  const schemaVersion = raw.schema_version;
  if (schemaVersion !== 'v9') {
    return null;
  }

  const normalized: DispatchMemorySnapshotV9 = {
    schema_version: 'v9',
    bindings_version:
      typeof raw.bindings_version === 'string' && raw.bindings_version.length > 0
        ? raw.bindings_version
        : bindingsVersion,
    memory_version: toIsoDate(raw.memory_version, nowIso),
    route_state: normalizeRouteState(raw.route_state),
    updated_at: toIsoDate(raw.updated_at, nowIso),
    updated_by: typeof raw.updated_by === 'string' && raw.updated_by.length > 0 ? raw.updated_by : 'middleware'
  };

  return normalized;
}

async function readMemoryUpdatedAt(
  snapshotKey: string,
  queryRunner: typeof query,
  fallbackIso: string
): Promise<string> {
  const result = await queryRunner(
    'SELECT updated_at FROM memory WHERE key = $1 LIMIT 1',
    [snapshotKey]
  );

  const row = result.rows[0] as { updated_at?: unknown } | undefined;
  return toIsoDate(row?.updated_at, fallbackIso);
}

/**
 * Purpose: Create a DB-backed route memory snapshot store with TTL cache.
 * Inputs/Outputs: dependency adapters for db operations; returns snapshot store API.
 * Edge cases: missing/invalid snapshots are recreated with defaults.
 */
export function createRouteMemorySnapshotStore(overrides: Partial<RouteMemorySnapshotStoreDependencies> = {}) {
  const deps: RouteMemorySnapshotStoreDependencies = {
    snapshotKey: overrides.snapshotKey || DISPATCH_V9_SNAPSHOT_KEY,
    bindingsVersion: overrides.bindingsVersion || DISPATCH_BINDINGS_VERSION,
    cacheTtlMs:
      typeof overrides.cacheTtlMs === 'number'
        ? overrides.cacheTtlMs
        : config.dispatchV9.snapshotCacheTtlMs,
    loadMemoryEntry: overrides.loadMemoryEntry || loadMemory,
    saveMemoryEntry: overrides.saveMemoryEntry || saveMemory,
    queryRunner: overrides.queryRunner || query,
    now: overrides.now || (() => new Date())
  };

  const storeLogger = logger.child({ module: 'dispatch-v9.snapshot-store' });
  let cache: SnapshotCacheEntry | null = null;

  const setCache = (record: RouteMemorySnapshotRecord): void => {
    const ttl = Math.max(0, deps.cacheTtlMs);
    cache = {
      record,
      expiresAt: deps.now().getTime() + ttl
    };
  };

  const persistSnapshot = async (
    snapshot: DispatchMemorySnapshotV9,
    updatedBy: string
  ): Promise<RouteMemorySnapshotRecord> => {
    const nowIso = deps.now().toISOString();
    const persistedSnapshot: DispatchMemorySnapshotV9 = {
      ...snapshot,
      bindings_version: deps.bindingsVersion,
      updated_at: nowIso,
      updated_by: updatedBy
    };

    await deps.saveMemoryEntry(deps.snapshotKey, persistedSnapshot);
    // Use the save timestamp as the memory version to avoid race conditions
    // between separate save and read operations
    const memoryVersion = nowIso;
    const normalizedSnapshot: DispatchMemorySnapshotV9 = {
      ...persistedSnapshot,
      memory_version: memoryVersion
    };

    const record: RouteMemorySnapshotRecord = {
      snapshot: normalizedSnapshot,
      memoryVersion,
      loadedFrom: 'db'
    };
    setCache(record);
    return record;
  };

  return {
    /**
     * Purpose: Load route memory snapshot with optional forced DB refresh.
     * Inputs/Outputs: optional forceRefresh flag; returns snapshot record.
     * Edge cases: corrupt snapshots are replaced with defaults.
     */
    async getSnapshot(options: { forceRefresh?: boolean } = {}): Promise<RouteMemorySnapshotRecord> {
      const forceRefresh = Boolean(options.forceRefresh);
      const nowIso = deps.now().toISOString();

      //audit Assumption: cache is safe for short-lived snapshot reads; risk: stale reads; invariant: force refresh bypasses cache; handling: TTL check.
      if (!forceRefresh && cache && cache.expiresAt > deps.now().getTime()) {
        return {
          ...cache.record,
          loadedFrom: 'cache'
        };
      }

      const rawSnapshot = await deps.loadMemoryEntry(deps.snapshotKey);

      //audit Assumption: missing snapshot should bootstrap default state; risk: ungoverned routes; invariant: snapshot exists after call; handling: create default.
      if (rawSnapshot == null) {
        const defaultSnapshot = createDefaultSnapshot(deps.bindingsVersion, nowIso, 'middleware');
        const created = await persistSnapshot(defaultSnapshot, 'middleware');
        return {
          ...created,
          loadedFrom: 'created'
        };
      }

      const normalized = normalizeSnapshot(rawSnapshot, deps.bindingsVersion, nowIso);
      //audit Assumption: malformed snapshots cannot be trusted; risk: invalid policy decisions; invariant: fallback snapshot is valid; handling: recreate.
      if (!normalized) {
        storeLogger.warn('Invalid dispatch snapshot detected; recreating default snapshot', {
          operation: 'getSnapshot',
          snapshotKey: deps.snapshotKey
        });
        const recreated = await persistSnapshot(
          createDefaultSnapshot(deps.bindingsVersion, nowIso, 'middleware'),
          'middleware'
        );
        return {
          ...recreated,
          loadedFrom: 'created'
        };
      }

      //audit Assumption: binding version drift should refresh snapshot metadata; risk: stale binding semantics; invariant: bindings version aligned; handling: persist normalized update.
      if (normalized.bindings_version !== deps.bindingsVersion) {
        const migrated = await persistSnapshot(
          {
            ...normalized,
            bindings_version: deps.bindingsVersion
          },
          'middleware'
        );
        return migrated;
      }

      const memoryVersion = await readMemoryUpdatedAt(deps.snapshotKey, deps.queryRunner, nowIso);
      const snapshot = {
        ...normalized,
        memory_version: memoryVersion
      };
      const record: RouteMemorySnapshotRecord = {
        snapshot,
        memoryVersion,
        loadedFrom: 'db'
      };
      setCache(record);
      return record;
    },

    /**
     * Purpose: Upsert route-level validation state in the global snapshot.
     * Inputs/Outputs: route attempt key + expected route; returns updated snapshot record.
     * Edge cases: creates route state when missing.
     */
    async upsertRouteState(
      routeAttempted: string,
      expectedRoute: string,
      options: { hardConflict?: boolean; updatedBy?: string } = {}
    ): Promise<RouteMemorySnapshotRecord> {
      const current = await this.getSnapshot({ forceRefresh: true });
      const MAX_ROUTES = 5000;
      if (!current.snapshot.route_state[routeAttempted] && Object.keys(current.snapshot.route_state).length >= MAX_ROUTES) {
        return current;
      }
      const nowIso = deps.now().toISOString();

      const existingState = current.snapshot.route_state[routeAttempted];
      const nextState: DispatchRouteStateV9 = {
        expected_route: expectedRoute,
        last_validated_at: nowIso,
        hard_conflict: options.hardConflict ?? existingState?.hard_conflict ?? false
      };

      const nextSnapshot: DispatchMemorySnapshotV9 = {
        ...current.snapshot,
        route_state: {
          ...current.snapshot.route_state,
          [routeAttempted]: nextState
        },
        updated_at: nowIso,
        updated_by: options.updatedBy || 'middleware'
      };

      return persistSnapshot(nextSnapshot, options.updatedBy || 'middleware');
    },

    /**
     * Purpose: Replace the complete snapshot document.
     * Inputs/Outputs: snapshot payload + optional updater id; returns persisted record.
     * Edge cases: bindings version is normalized to active config.
     */
    async replaceSnapshot(
      snapshot: DispatchMemorySnapshotV9,
      updatedBy: string = 'middleware'
    ): Promise<RouteMemorySnapshotRecord> {
      return persistSnapshot(snapshot, updatedBy);
    },

    /**
     * Purpose: Clear in-process snapshot cache.
     * Inputs/Outputs: no inputs; no return value.
     * Edge cases: no-op when cache is already empty.
     */
    clearCache(): void {
      cache = null;
    }
  };
}

export const routeMemorySnapshotStore = createRouteMemorySnapshotStore();


import { config } from "@platform/runtime/config.js";
import { DISPATCH_BINDINGS_VERSION } from "@platform/runtime/dispatchPatterns.js";
import { loadMemory, query, saveMemory } from "@core/db/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import type {
  DispatchMemorySnapshotV9,
  DispatchRouteStateV9
} from "@shared/types/dispatchV9.js";
import { createVersionStamp } from "@services/safety/monotonicClock.js";

export const DISPATCH_V9_SNAPSHOT_KEY = 'dispatch:v9:snapshot:global';
export const DISPATCH_V9_TRUSTED_SNAPSHOT_KEY = 'dispatch:v9:snapshot:trusted';

export interface RouteMemorySnapshotRecord {
  snapshot: DispatchMemorySnapshotV9;
  memoryVersion: string;
  loadedFrom: 'cache' | 'db' | 'created';
}

interface RouteMemorySnapshotStoreDependencies {
  snapshotKey: string;
  trustedSnapshotKey: string;
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
  const stamp = createVersionStamp('dispatch-snapshot');
  return {
    schema_version: 'v9',
    bindings_version: bindingsVersion,
    version_id: stamp.versionId,
    monotonic_ts_ms: stamp.monotonicTimestampMs,
    memory_version: nowIso,
    trusted_snapshot_id: undefined,
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
  const fallbackStamp = createVersionStamp('dispatch-snapshot-normalized');

  const normalized: DispatchMemorySnapshotV9 = {
    schema_version: 'v9',
    bindings_version:
      typeof raw.bindings_version === 'string' && raw.bindings_version.length > 0
        ? raw.bindings_version
        : bindingsVersion,
    version_id:
      typeof raw.version_id === 'string' && raw.version_id.length > 0
        ? raw.version_id
        : fallbackStamp.versionId,
    monotonic_ts_ms:
      typeof raw.monotonic_ts_ms === 'number' && Number.isFinite(raw.monotonic_ts_ms)
        ? Math.floor(raw.monotonic_ts_ms)
        : fallbackStamp.monotonicTimestampMs,
    memory_version: toIsoDate(raw.memory_version, nowIso),
    trusted_snapshot_id:
      typeof raw.trusted_snapshot_id === 'string' && raw.trusted_snapshot_id.length > 0
        ? raw.trusted_snapshot_id
        : undefined,
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
    trustedSnapshotKey: overrides.trustedSnapshotKey || DISPATCH_V9_TRUSTED_SNAPSHOT_KEY,
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
  // NOTE: This cache is process-local and not shared across worker processes or cluster instances.
  // In multi-process deployments, each worker maintains its own independent cache.
  let cache: SnapshotCacheEntry | null = null;
  let trustedSnapshotCache: DispatchMemorySnapshotV9 | null = null;

  const setCache = (record: RouteMemorySnapshotRecord): void => {
    const ttl = Math.max(0, deps.cacheTtlMs);
    cache = {
      record,
      expiresAt: deps.now().getTime() + ttl
    };
  };

  const persistSnapshot = async (
    snapshot: DispatchMemorySnapshotV9,
    updatedBy: string,
    options: { markTrusted?: boolean; trustedSnapshotId?: string } = {}
  ): Promise<RouteMemorySnapshotRecord> => {
    const nowIso = deps.now().toISOString();
    const stamp = createVersionStamp('dispatch-snapshot');
    const trustedSnapshotId = options.markTrusted
      ? stamp.versionId
      : options.trustedSnapshotId ?? snapshot.trusted_snapshot_id;
    const persistedSnapshot: DispatchMemorySnapshotV9 = {
      ...snapshot,
      bindings_version: deps.bindingsVersion,
      version_id: stamp.versionId,
      monotonic_ts_ms: stamp.monotonicTimestampMs,
      trusted_snapshot_id: trustedSnapshotId,
      updated_at: nowIso,
      updated_by: updatedBy
    };

    await deps.saveMemoryEntry(deps.snapshotKey, persistedSnapshot);

    // Read back the actual updated_at from the database to ensure memory_version
    // reflects the true persisted timestamp, avoiding race conditions
    let memoryVersion = nowIso;
    try {
      const dbUpdatedAt = await readMemoryUpdatedAt(deps.snapshotKey, deps.queryRunner, nowIso);
      memoryVersion = dbUpdatedAt;
    } catch {
      storeLogger.warn('Failed to read back updated_at after save; using local timestamp', {
        operation: 'persistSnapshot',
        snapshotKey: deps.snapshotKey
      });
    }
    const normalizedSnapshot: DispatchMemorySnapshotV9 = {
      ...persistedSnapshot,
      memory_version: memoryVersion
    };

    const record: RouteMemorySnapshotRecord = {
      snapshot: normalizedSnapshot,
      memoryVersion,
      loadedFrom: 'db'
    };
    if (options.markTrusted) {
      trustedSnapshotCache = normalizedSnapshot;
      try {
        await deps.saveMemoryEntry(deps.trustedSnapshotKey, normalizedSnapshot);
      } catch (error) {
        storeLogger.warn('Failed to persist trusted dispatch snapshot cache', {
          operation: 'persistSnapshot',
          trustedSnapshotKey: deps.trustedSnapshotKey
        }, undefined, error instanceof Error ? error : undefined);
      }
    }
    setCache(record);
    return record;
  };

  const loadTrustedSnapshot = async (): Promise<DispatchMemorySnapshotV9 | null> => {
    if (trustedSnapshotCache) {
      return trustedSnapshotCache;
    }

    const rawTrustedSnapshot = await deps.loadMemoryEntry(deps.trustedSnapshotKey);
    if (!rawTrustedSnapshot) {
      return null;
    }

    const normalized = normalizeSnapshot(
      rawTrustedSnapshot,
      deps.bindingsVersion,
      deps.now().toISOString()
    );
    //audit Assumption: trusted snapshot file may be stale or malformed; risk: rollback to invalid state; invariant: rollback uses normalized v9 snapshot only; handling: discard invalid trusted snapshot.
    if (!normalized) {
      storeLogger.warn('Trusted dispatch snapshot malformed; clearing trusted cache reference', {
        operation: 'loadTrustedSnapshot',
        trustedSnapshotKey: deps.trustedSnapshotKey
      });
      return null;
    }

    trustedSnapshotCache = normalized;
    return trustedSnapshotCache;
  };

  const persistTrustedSnapshotCheckpoint = async (
    snapshot: DispatchMemorySnapshotV9
  ): Promise<void> => {
    trustedSnapshotCache = {
      ...snapshot,
      trusted_snapshot_id: snapshot.version_id
    };
    await deps.saveMemoryEntry(deps.trustedSnapshotKey, trustedSnapshotCache);
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
        const created = await persistSnapshot(defaultSnapshot, 'middleware', {
          markTrusted: true
        });
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
          'middleware',
          { markTrusted: true }
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
          'middleware',
          { markTrusted: true }
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

      if (!trustedSnapshotCache) {
        try {
          await persistTrustedSnapshotCheckpoint(snapshot);
        } catch (error) {
          storeLogger.warn('Failed to initialize trusted snapshot cache', {
            operation: 'getSnapshot',
            trustedSnapshotKey: deps.trustedSnapshotKey
          }, undefined, error instanceof Error ? error : undefined);
        }
      }

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
      const MAX_ROUTES = Number(process.env.ROUTE_MEMORY_MAX_ROUTES ?? '5000') || 5000;
      const EVICTION_COUNT = 500;
      const routeState = current.snapshot.route_state;

      // When limit is reached and this is a new route, evict the oldest entries
      // to prevent an attacker from exhausting the limit and blocking all new routes
      if (!routeState[routeAttempted] && Object.keys(routeState).length >= MAX_ROUTES) {
        const sortedEntries = Object.entries(routeState)
          .sort(([, a], [, b]) => {
            const timeA = Date.parse(a.last_validated_at) || 0;
            const timeB = Date.parse(b.last_validated_at) || 0;
            return timeA - timeB;
          });

        const keysToEvict = sortedEntries.slice(0, EVICTION_COUNT).map(([key]) => key);
        for (const key of keysToEvict) {
          delete routeState[key];
        }

        storeLogger.warn('Route state limit reached; evicted oldest entries', {
          operation: 'upsertRouteState',
          evictedCount: keysToEvict.length,
          remainingCount: Object.keys(routeState).length
        });
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

      return persistSnapshot(nextSnapshot, options.updatedBy || 'middleware', {
        markTrusted: true
      });
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
      return persistSnapshot(snapshot, updatedBy, { markTrusted: true });
    },

    /**
     * Purpose: Persist a trusted snapshot checkpoint for rollback recovery.
     * Inputs/Outputs: snapshot payload; no return value.
     * Edge cases: overwrites previous trusted checkpoint.
     */
    async rememberTrustedSnapshot(
      snapshot: DispatchMemorySnapshotV9
    ): Promise<void> {
      await persistTrustedSnapshotCheckpoint(snapshot);
    },

    /**
     * Purpose: Return the in-process cached primary snapshot record.
     * Inputs/Outputs: no inputs; returns snapshot record or null.
     * Edge cases: null when cache has not been initialized.
     */
    getCachedSnapshot(): RouteMemorySnapshotRecord | null {
      if (!cache) {
        return null;
      }
      return {
        ...cache.record,
        loadedFrom: 'cache'
      };
    },

    /**
     * Purpose: Return the in-process cached trusted snapshot payload.
     * Inputs/Outputs: no inputs; returns trusted snapshot or null.
     * Edge cases: null when trusted snapshot has not been persisted yet.
     */
    getCachedTrustedSnapshot(): DispatchMemorySnapshotV9 | null {
      return trustedSnapshotCache ? { ...trustedSnapshotCache } : null;
    },

    /**
     * Purpose: Roll back active snapshot to last trusted snapshot checkpoint.
     * Inputs/Outputs: optional updatedBy actor; returns persisted rollback record or null.
     * Edge cases: returns null when trusted checkpoint is unavailable.
     */
    async rollbackToTrustedSnapshot(updatedBy: string = 'middleware'): Promise<RouteMemorySnapshotRecord | null> {
      const trustedSnapshot = await loadTrustedSnapshot();
      //audit Assumption: rollback requires previously trusted checkpoint; risk: undefined rollback target; invariant: null return when no trusted checkpoint exists; handling: caller must fail closed.
      if (!trustedSnapshot) {
        return null;
      }

      return persistSnapshot(
        {
          ...trustedSnapshot,
          trusted_snapshot_id: trustedSnapshot.version_id
        },
        updatedBy,
        {
          markTrusted: true
        }
      );
    },

    /**
     * Purpose: Clear in-process snapshot cache.
     * Inputs/Outputs: no inputs; no return value.
     * Edge cases: no-op when cache is already empty.
     */
    clearCache(): void {
      cache = null;
      trustedSnapshotCache = null;
    }
  };
}

export const routeMemorySnapshotStore = createRouteMemorySnapshotStore();


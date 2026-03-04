import type { logger } from '@platform/logging/structuredLogging.js';
import type { recordTraceEvent } from '@platform/logging/telemetry.js';
import type {
  DispatchDecisionV9,
  DispatchMemorySnapshotV9,
  DispatchPatternBindingV9
} from '@shared/types/dispatchV9.js';

export interface MemoryConsistencyGateDependencies {
  enabled: boolean;
  shadowOnly: boolean;
  bindings: DispatchPatternBindingV9[];
  bindingsVersion: string;
  policyTimeoutMs: number;
  defaultRerouteTarget: string;
  readonlyBindingId: string;
  now: () => Date;
  recordTrace: typeof recordTraceEvent;
  dispatchLogger: typeof logger;
  snapshotStore: {
    getSnapshot: (options?: { forceRefresh?: boolean }) => Promise<{
      snapshot: DispatchMemorySnapshotV9;
      memoryVersion: string;
      loadedFrom: 'cache' | 'db' | 'created';
    }>;
    upsertRouteState: (
      routeAttempted: string,
      expectedRoute: string,
      options?: { hardConflict?: boolean; updatedBy?: string }
    ) => Promise<unknown>;
    getCachedSnapshot?: () => {
      snapshot: DispatchMemorySnapshotV9;
      memoryVersion: string;
      loadedFrom: 'cache' | 'db' | 'created';
    } | null;
    getCachedTrustedSnapshot?: () => DispatchMemorySnapshotV9 | null;
    rememberTrustedSnapshot?: (snapshot: DispatchMemorySnapshotV9) => Promise<void>;
    rollbackToTrustedSnapshot?: (updatedBy?: string) => Promise<{
      snapshot: DispatchMemorySnapshotV9;
      memoryVersion: string;
      loadedFrom: 'cache' | 'db' | 'created';
    } | null>;
  };
}

export interface RequestStateSnapshot {
  method: string;
  url: string;
  body: unknown;
  dispatchDecision?: DispatchDecisionV9;
  memoryVersion?: string;
  dispatchRerouted?: boolean;
  dispatchConflictCode?: string;
}

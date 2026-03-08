export type TrinityRunStatus = 'running' | 'completed' | 'failed';

export interface TrinityRunRecord {
  runId: string;
  status: TrinityRunStatus;
  activeNodes: string[];
  completedNodes: string[];
  failedNodes: string[];
  artifacts: string[];
  updatedAtIso: string;
}

export interface TrinityOrchestratorOptions {
  terminalRunRetentionMs?: number;
  maxTrackedEntriesPerCollection?: number;
  readNowMs?: () => number;
}

interface InternalTrinityRunRecord {
  runId: string;
  status: TrinityRunStatus;
  activeNodes: Set<string>;
  completedNodes: Set<string>;
  failedNodes: Set<string>;
  artifacts: Set<string>;
  updatedAtIso: string;
  terminalSinceMs: number | null;
}

const DEFAULT_TERMINAL_RUN_RETENTION_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TRACKED_ENTRIES_PER_COLLECTION = 10_000;

/**
 * Tracks DAG run state for resume and failure recovery workflows.
 *
 * Purpose:
 * - Persist and mutate run-level state snapshots needed by recovery orchestration.
 *
 * Inputs/outputs:
 * - Input: run identifiers plus node/artifact transition events.
 * - Output: latest immutable-like record snapshots per run.
 *
 * Edge case behavior:
 * - Repeated node completion/failure updates are idempotent (deduplicated).
 * - Terminal runs are retained temporarily and then retired to bound memory growth.
 */
export class TrinityOrchestrator {
  private readonly runsById: Map<string, InternalTrinityRunRecord> = new Map();
  private readonly terminalRunRetentionMs: number;
  private readonly maxTrackedEntriesPerCollection: number;
  private readonly readNowMs: () => number;

  constructor(options: TrinityOrchestratorOptions = {}) {
    this.terminalRunRetentionMs = options.terminalRunRetentionMs ?? DEFAULT_TERMINAL_RUN_RETENTION_MS;
    this.maxTrackedEntriesPerCollection =
      options.maxTrackedEntriesPerCollection ?? DEFAULT_MAX_TRACKED_ENTRIES_PER_COLLECTION;
    this.readNowMs = options.readNowMs ?? (() => Date.now());
  }

  /**
   * Start a new run state record.
   */
  startRun(runId: string): TrinityRunRecord {
    const nowMs = this.readNowMs();
    this.retireExpiredRuns(nowMs);

    //audit Assumption: run identifiers must stay unique while a run record is active; failure risk: duplicate IDs overwrite recovery state and hide in-flight work; expected invariant: one live record per runId; handling strategy: reject duplicates before persisting the new record.
    if (this.runsById.has(runId)) {
      throw new Error(`Run "${runId}" already exists.`);
    }

    const startedRecord: InternalTrinityRunRecord = {
      runId,
      status: 'running',
      activeNodes: new Set(),
      completedNodes: new Set(),
      failedNodes: new Set(),
      artifacts: new Set(),
      updatedAtIso: this.createIsoTimestamp(nowMs),
      terminalSinceMs: null
    };

    this.runsById.set(runId, startedRecord);
    return this.toPublicRecord(startedRecord);
  }

  /**
   * Mark one node as active for a run.
   */
  markNodeActive(runId: string, nodeId: string): TrinityRunRecord {
    return this.updateRun(runId, (existingRecord, nowMs) => {
      const nextActiveNodes = new Set(existingRecord.activeNodes);

      //audit Assumption: repeated active-node events can occur during retries; failure risk: duplicate entries inflate active-node counters; expected invariant: activeNodes remains unique and capacity-bounded; handling strategy: add via bounded set semantics and preserve existing state when the node already exists.
      this.addBoundedEntry(nextActiveNodes, nodeId, runId, 'activeNodes');

      return {
        ...existingRecord,
        activeNodes: nextActiveNodes,
        updatedAtIso: this.createIsoTimestamp(nowMs)
      };
    });
  }

  /**
   * Mark one node as completed and remove it from active nodes.
   */
  markNodeCompleted(runId: string, nodeId: string): TrinityRunRecord {
    return this.updateRun(runId, (existingRecord, nowMs) => {
      const nextActiveNodes = new Set(existingRecord.activeNodes);
      nextActiveNodes.delete(nodeId);

      const nextCompletedNodes = new Set(existingRecord.completedNodes);
      const nextFailedNodes = new Set(existingRecord.failedNodes);
      nextFailedNodes.delete(nodeId);

      //audit Assumption: completion events may be replayed or arrive after a stale failure event; failure risk: contradictory node terminal state corrupts recovery summaries; expected invariant: one node belongs to at most one terminal collection; handling strategy: remove the opposite terminal marker before recording completion.
      this.addBoundedEntry(nextCompletedNodes, nodeId, runId, 'completedNodes');

      return {
        ...existingRecord,
        activeNodes: nextActiveNodes,
        completedNodes: nextCompletedNodes,
        failedNodes: nextFailedNodes,
        updatedAtIso: this.createIsoTimestamp(nowMs)
      };
    });
  }

  /**
   * Mark one node as failed and keep run in a failed terminal status.
   */
  markNodeFailed(runId: string, nodeId: string): TrinityRunRecord {
    return this.updateRun(runId, (existingRecord, nowMs) => {
      const nextActiveNodes = new Set(existingRecord.activeNodes);
      nextActiveNodes.delete(nodeId);

      const nextCompletedNodes = new Set(existingRecord.completedNodes);
      nextCompletedNodes.delete(nodeId);

      const nextFailedNodes = new Set(existingRecord.failedNodes);

      //audit Assumption: failure events can be duplicated or arrive after stale completion events; failure risk: duplicated failures overcount blast radius and leave contradictory terminal state; expected invariant: one node belongs to at most one terminal collection; handling strategy: remove completion markers before recording failure.
      this.addBoundedEntry(nextFailedNodes, nodeId, runId, 'failedNodes');

      return {
        ...existingRecord,
        status: 'failed',
        activeNodes: nextActiveNodes,
        completedNodes: nextCompletedNodes,
        failedNodes: nextFailedNodes,
        updatedAtIso: this.createIsoTimestamp(nowMs),
        terminalSinceMs: existingRecord.terminalSinceMs ?? nowMs
      };
    });
  }

  /**
   * Attach one artifact identifier to a run state record.
   */
  attachArtifact(runId: string, artifactReference: string): TrinityRunRecord {
    return this.updateRun(runId, (existingRecord, nowMs) => {
      const nextArtifacts = new Set(existingRecord.artifacts);

      //audit Assumption: artifact publication may be retried after storage timeouts; failure risk: duplicates or unbounded unique artifacts bloat persisted run state; expected invariant: artifacts stay unique and capacity-bounded; handling strategy: add with explicit bounds enforcement and keep the prior set when already present.
      this.addBoundedEntry(nextArtifacts, artifactReference, runId, 'artifacts');

      return {
        ...existingRecord,
        artifacts: nextArtifacts,
        updatedAtIso: this.createIsoTimestamp(nowMs)
      };
    });
  }

  /**
   * Mark a run completed when no failures are present.
   */
  markRunCompleted(runId: string): TrinityRunRecord {
    return this.updateRun(runId, (existingRecord, nowMs) => {
      //audit Assumption: failed runs must not be promoted to completed without explicit recovery path; failure risk: data integrity regression and false-positive success metrics; expected invariant: failed status is terminal for this in-memory implementation; handling strategy: throw to force caller-managed recovery.
      if (existingRecord.status === 'failed') {
        throw new Error(`Cannot complete failed run "${runId}" without recovery.`);
      }

      return {
        ...existingRecord,
        status: 'completed',
        updatedAtIso: this.createIsoTimestamp(nowMs),
        terminalSinceMs: existingRecord.terminalSinceMs ?? nowMs
      };
    });
  }

  /**
   * Retrieve run state by id.
   */
  getRun(runId: string): TrinityRunRecord | null {
    this.retireExpiredRuns();
    const selectedRecord = this.runsById.get(runId);
    return selectedRecord ? this.toPublicRecord(selectedRecord) : null;
  }

  /**
   * Remove terminal runs whose retention window has elapsed.
   */
  retireExpiredRuns(nowMs: number = this.readNowMs()): number {
    let retiredRunCount = 0;

    for (const [runId, record] of this.runsById.entries()) {
      //audit Assumption: only terminal runs are safe to evict automatically; failure risk: deleting active records breaks in-flight recovery; expected invariant: running records remain addressable while terminal records are temporary; handling strategy: remove only terminal records whose retention deadline has passed.
      if (record.status === 'running' || record.terminalSinceMs === null) {
        continue;
      }

      if (nowMs - record.terminalSinceMs < this.terminalRunRetentionMs) {
        continue;
      }

      this.runsById.delete(runId);
      retiredRunCount += 1;
    }

    return retiredRunCount;
  }

  private updateRun(
    runId: string,
    updater: (record: InternalTrinityRunRecord, nowMs: number) => InternalTrinityRunRecord
  ): TrinityRunRecord {
    const nowMs = this.readNowMs();
    this.retireExpiredRuns(nowMs);
    const existingRecord = this.getOrThrow(runId);
    const nextRecord = updater(existingRecord, nowMs);
    this.runsById.set(runId, nextRecord);
    return this.toPublicRecord(nextRecord);
  }

  private addBoundedEntry(
    collection: Set<string>,
    entry: string,
    runId: string,
    collectionName: 'activeNodes' | 'completedNodes' | 'failedNodes' | 'artifacts'
  ): void {
    if (collection.has(entry)) {
      return;
    }

    //audit Assumption: unbounded per-run collections allow hostile or malformed event streams to consume memory; failure risk: one run exhausts process memory even if terminal retention exists; expected invariant: each tracked collection has a finite upper bound; handling strategy: reject new unique entries once the configured safety limit is reached.
    if (collection.size >= this.maxTrackedEntriesPerCollection) {
      throw new Error(
        `Run "${runId}" exceeded the ${collectionName} safety limit of ${this.maxTrackedEntriesPerCollection}.`
      );
    }

    collection.add(entry);
  }

  private toPublicRecord(record: InternalTrinityRunRecord): TrinityRunRecord {
    return {
      runId: record.runId,
      status: record.status,
      activeNodes: [...record.activeNodes],
      completedNodes: [...record.completedNodes],
      failedNodes: [...record.failedNodes],
      artifacts: [...record.artifacts],
      updatedAtIso: record.updatedAtIso
    };
  }

  private createIsoTimestamp(nowMs: number): string {
    return new Date(nowMs).toISOString();
  }

  private getOrThrow(runId: string): InternalTrinityRunRecord {
    const selectedRecord = this.runsById.get(runId);

    //audit Assumption: callers should initialize run state before node transitions; failure risk: orphan transition events create undefined behavior; expected invariant: every mutation references an existing run; handling strategy: throw explicit not-found error.
    if (!selectedRecord) {
      throw new Error(`Run "${runId}" does not exist.`);
    }

    return selectedRecord;
  }
}

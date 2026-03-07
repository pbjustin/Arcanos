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
 */
export class TrinityOrchestrator {
  private readonly runsById: Map<string, TrinityRunRecord> = new Map();

  /**
   * Start a new run state record.
   */
  startRun(runId: string): TrinityRunRecord {
    const startedRecord: TrinityRunRecord = {
      runId,
      status: 'running',
      activeNodes: [],
      completedNodes: [],
      failedNodes: [],
      artifacts: [],
      updatedAtIso: new Date().toISOString()
    };

    this.runsById.set(runId, startedRecord);
    return startedRecord;
  }

  /**
   * Mark one node as active for a run.
   */
  markNodeActive(runId: string, nodeId: string): TrinityRunRecord {
    const existingRecord = this.getOrThrow(runId);

    //audit Assumption: repeated active-node events can occur during retries; failure risk: duplicate entries inflate active-node counters; expected invariant: activeNodes remains a unique set-like list; handling strategy: append only when missing.
    if (!existingRecord.activeNodes.includes(nodeId)) {
      existingRecord.activeNodes.push(nodeId);
      existingRecord.updatedAtIso = new Date().toISOString();
    }

    return existingRecord;
  }

  /**
   * Mark one node as completed and remove it from active nodes.
   */
  markNodeCompleted(runId: string, nodeId: string): TrinityRunRecord {
    const existingRecord = this.getOrThrow(runId);
    existingRecord.activeNodes = existingRecord.activeNodes.filter(activeNodeId => activeNodeId !== nodeId);

    //audit Assumption: completion events may be replayed by at-least-once delivery systems; failure risk: duplicate completion records break deterministic summaries; expected invariant: completedNodes list is deduplicated; handling strategy: append only on first observation.
    if (!existingRecord.completedNodes.includes(nodeId)) {
      existingRecord.completedNodes.push(nodeId);
    }

    existingRecord.updatedAtIso = new Date().toISOString();
    return existingRecord;
  }

  /**
   * Mark one node as failed and keep run in a failed terminal status.
   */
  markNodeFailed(runId: string, nodeId: string): TrinityRunRecord {
    const existingRecord = this.getOrThrow(runId);
    existingRecord.activeNodes = existingRecord.activeNodes.filter(activeNodeId => activeNodeId !== nodeId);

    //audit Assumption: failure events can be duplicated by retries and observer replays; failure risk: duplicated failures overcount blast radius; expected invariant: failedNodes is deduplicated; handling strategy: append only when node is newly failed.
    if (!existingRecord.failedNodes.includes(nodeId)) {
      existingRecord.failedNodes.push(nodeId);
    }

    existingRecord.status = 'failed';
    existingRecord.updatedAtIso = new Date().toISOString();
    return existingRecord;
  }

  /**
   * Attach one artifact identifier to a run state record.
   */
  attachArtifact(runId: string, artifactReference: string): TrinityRunRecord {
    const existingRecord = this.getOrThrow(runId);

    //audit Assumption: artifact publication may be retried after storage timeouts; failure risk: duplicates bloat persisted run state; expected invariant: artifacts list is unique; handling strategy: deduplicate by string equality.
    if (!existingRecord.artifacts.includes(artifactReference)) {
      existingRecord.artifacts.push(artifactReference);
      existingRecord.updatedAtIso = new Date().toISOString();
    }

    return existingRecord;
  }

  /**
   * Mark a run completed when no failures are present.
   */
  markRunCompleted(runId: string): TrinityRunRecord {
    const existingRecord = this.getOrThrow(runId);

    //audit Assumption: failed runs must not be promoted to completed without explicit recovery path; failure risk: data integrity regression and false-positive success metrics; expected invariant: failed status is terminal for this in-memory implementation; handling strategy: throw to force caller-managed recovery.
    if (existingRecord.status === 'failed') {
      throw new Error(`Cannot complete failed run "${runId}" without recovery.`);
    }

    existingRecord.status = 'completed';
    existingRecord.updatedAtIso = new Date().toISOString();
    return existingRecord;
  }

  /**
   * Retrieve run state by id.
   */
  getRun(runId: string): TrinityRunRecord | null {
    return this.runsById.get(runId) ?? null;
  }

  private getOrThrow(runId: string): TrinityRunRecord {
    const selectedRecord = this.runsById.get(runId);

    //audit Assumption: callers should initialize run state before node transitions; failure risk: orphan transition events create undefined behavior; expected invariant: every mutation references an existing run; handling strategy: throw explicit not-found error.
    if (!selectedRecord) {
      throw new Error(`Run "${runId}" does not exist.`);
    }

    return selectedRecord;
  }
}

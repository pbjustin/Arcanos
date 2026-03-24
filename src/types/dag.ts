export type DagRunStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export const DAG_LATEST_DEBUG_MARKER = 'NEW_DAG_LOGIC_ACTIVE';

export interface DagLatestRunSummary {
  runId: string;
  status: DagRunStatus;
  nodeCount: number;
  durationMs: number | null;
  timings: {
    lookupMs: number;
    nodesMs?: number;
    eventsMs?: number;
    metricsMs?: number;
    verificationMs?: number;
    totalMs: number;
  };
  topLevelMetrics: {
    eventCount?: number;
    completedNodes?: number;
    failedNodes?: number;
    verificationStatus?: string;
  };
  available: {
    nodes: boolean;
    events: boolean;
    metrics: boolean;
    verification: boolean;
    fullTrace: boolean;
  };
}

export interface DagLatestRunToolOutput extends DagLatestRunSummary {
  __debug: typeof DAG_LATEST_DEBUG_MARKER;
  found: boolean;
}

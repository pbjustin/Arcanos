export type QueueLane = 'priority' | 'standard';

export interface JobSchedulingMetadata {
  jobId: string;
  gptId: string;
  priority: number;
  lane: QueueLane;
  createdAt: Date;
  attempts: number;
  maxRetries: number;
}

export interface LeaseState {
  workerId: string;
  leaseExpiresAt: Date;
}

export interface RetryState {
  attempts: number;
  lastError?: string;
  nextRetryAt?: Date;
}

export interface DagNodeTiming {
  nodeId: string;
  durationMs: number;
  retries: number;
  provider?: string;
  timestamp: Date;
}

export interface SchedulerPolicy {
  priorityQueueEnabled: boolean;
  priorityQueueWeight: number;
  priorityLaneMaxPriority: number;
}

export interface SchedulerState {
  priorityClaimsSinceStandard: number;
}

export interface SchedulerClaimOptions {
  workerId?: string;
  leaseMs?: number;
  priorityQueueEnabled?: boolean;
  priorityQueueWeight?: number;
  priorityLaneMaxPriority?: number;
}

export type SchedulerBackendKind = 'postgres' | 'redis';

export interface SchedulerClaimDecision {
  lane: QueueLane;
  reason:
    | 'priority_queue_disabled'
    | 'priority_weight_available'
    | 'standard_weight_due';
  priorityQueueWeight: number;
  priorityClaimsSinceStandard: number;
}

export interface SchedulerClaimResult<TJob = unknown> {
  adapter: SchedulerBackendKind;
  lane: QueueLane | null;
  job: TJob | null;
}

export interface QueueSchedulerAdapter<TJob = unknown> {
  readonly adapter: SchedulerBackendKind;
  claimNext(options?: SchedulerClaimOptions): Promise<SchedulerClaimResult<TJob>>;
}

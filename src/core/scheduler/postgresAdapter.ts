import type { JobData } from '@core/db/schema.js';
import {
  claimNextPendingJob,
  getJobQueueSummary,
  type JobQueueSummary
} from '@core/db/repositories/jobRepository.js';
import { PRIORITY_QUEUE_LANE_MAX_PRIORITY } from '@shared/gpt/priorityGpt.js';
import { classifyQueueLane } from './scheduler.js';
import type {
  JobSchedulingMetadata,
  LeaseState,
  QueueSchedulerAdapter,
  RetryState,
  SchedulerClaimOptions,
  SchedulerClaimResult
} from './types.js';

export interface PostgresSchedulerRepository {
  claimNextPendingJob(options?: SchedulerClaimOptions): Promise<JobData | null>;
  getJobQueueSummary(): Promise<JobQueueSummary | null>;
}

const defaultRepository: PostgresSchedulerRepository = {
  claimNextPendingJob,
  getJobQueueSummary
};

function coerceDate(value: string | Date | null | undefined, fallback: Date): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return fallback;
}

function readGptId(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }

  const gptId = (input as { gptId?: unknown }).gptId;
  return typeof gptId === 'string' ? gptId.trim() : '';
}

export function toJobSchedulingMetadata(
  job: JobData,
  options: { priorityLaneMaxPriority?: number } = {}
): JobSchedulingMetadata {
  const priority = job.priority ?? Number.MAX_SAFE_INTEGER;

  return {
    jobId: job.id,
    gptId: job.job_type === 'gpt' ? readGptId(job.input) : '',
    priority,
    lane: classifyQueueLane({
      priority,
      priorityLaneMaxPriority: options.priorityLaneMaxPriority ?? PRIORITY_QUEUE_LANE_MAX_PRIORITY
    }),
    createdAt: coerceDate(job.created_at, new Date(0)),
    attempts: job.retry_count ?? 0,
    maxRetries: job.max_retries ?? 0
  };
}

export function toLeaseState(job: JobData): LeaseState | null {
  if (!job.last_worker_id || !job.lease_expires_at) {
    return null;
  }

  return {
    workerId: job.last_worker_id,
    leaseExpiresAt: coerceDate(job.lease_expires_at, new Date(0))
  };
}

export function toRetryState(job: JobData): RetryState {
  return {
    attempts: job.retry_count ?? 0,
    ...(job.error_message ? { lastError: job.error_message } : {}),
    ...(job.next_run_at ? { nextRetryAt: coerceDate(job.next_run_at, new Date(0)) } : {})
  };
}

export class PostgresQueueSchedulerAdapter implements QueueSchedulerAdapter<JobData> {
  readonly adapter = 'postgres' as const;

  constructor(private readonly repository: PostgresSchedulerRepository = defaultRepository) {}

  async claimNext(
    options: SchedulerClaimOptions = {}
  ): Promise<SchedulerClaimResult<JobData>> {
    const job = await this.repository.claimNextPendingJob(options);

    return {
      adapter: this.adapter,
      job,
      lane: job ? toJobSchedulingMetadata(job, {
        priorityLaneMaxPriority: options.priorityLaneMaxPriority
      }).lane : null
    };
  }

  async getQueueSummary(): Promise<JobQueueSummary | null> {
    return this.repository.getJobQueueSummary();
  }
}

export function createPostgresQueueSchedulerAdapter(
  repository: PostgresSchedulerRepository = defaultRepository
): PostgresQueueSchedulerAdapter {
  return new PostgresQueueSchedulerAdapter(repository);
}

export const postgresQueueSchedulerAdapter = createPostgresQueueSchedulerAdapter();

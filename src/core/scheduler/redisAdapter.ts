import type {
  QueueSchedulerAdapter,
  SchedulerClaimOptions,
  SchedulerClaimResult
} from './types.js';

export interface RedisQueueSchedulerAdapterOptions {
  redisUrl?: string;
  keyPrefix?: string;
}

export class RedisQueueSchedulerAdapter<TJob = unknown> implements QueueSchedulerAdapter<TJob> {
  readonly adapter = 'redis' as const;

  constructor(readonly options: RedisQueueSchedulerAdapterOptions = {}) {}

  async claimNext(_options: SchedulerClaimOptions = {}): Promise<SchedulerClaimResult<TJob>> {
    throw new Error(
      'RedisQueueSchedulerAdapter is a future adapter stub. The active scheduler remains Postgres-backed.'
    );
  }
}

export function createRedisQueueSchedulerAdapter<TJob = unknown>(
  options: RedisQueueSchedulerAdapterOptions = {}
): RedisQueueSchedulerAdapter<TJob> {
  return new RedisQueueSchedulerAdapter<TJob>(options);
}

import type { WorkerJob, WorkerPoolName } from './autoscalingTypes.js';

const DOMAIN_TO_POOL: Record<WorkerJob['metadata']['domain'], WorkerPoolName> = {
  main: 'main_runtime_pool',
  async: 'async_queue_pool',
  audit: 'audit_safe_pool',
  creative: 'creative_domain_pool'
};

/**
 * In-memory domain queue router for autoscaling pool isolation.
 *
 * Purpose:
 * - Route jobs from a primary ingress queue into domain-specific pool queues.
 *
 * Inputs/outputs:
 * - Input: one worker job payload with routing metadata.
 * - Output: selected pool name where the job was enqueued.
 *
 * Edge case behavior:
 * - Empty pools are initialized lazily before first enqueue.
 */
export class WorkerQueueService {
  private readonly poolQueues: Map<WorkerPoolName, WorkerJob[]> = new Map();

  constructor() {
    this.poolQueues.set('main_runtime_pool', []);
    this.poolQueues.set('async_queue_pool', []);
    this.poolQueues.set('audit_safe_pool', []);
    this.poolQueues.set('creative_domain_pool', []);
  }

  /**
   * Enqueue a job into a domain-isolated pool queue.
   */
  enqueue(job: WorkerJob): WorkerPoolName {
    const targetPool = DOMAIN_TO_POOL[job.metadata.domain];
    const selectedQueue = this.poolQueues.get(targetPool);

    //audit Assumption: all known pools are pre-registered in constructor; failure risk: routing silently drops jobs if pool map is corrupted; expected invariant: selectedQueue exists for every targetPool; handling strategy: throw an explicit error for defensive fail-fast behavior.
    if (!selectedQueue) {
      throw new Error(`Queue for pool "${targetPool}" is not initialized.`);
    }

    selectedQueue.push(job);
    return targetPool;
  }

  /**
   * Return queue depth for a given pool.
   */
  getQueueDepth(poolName: WorkerPoolName): number {
    return this.poolQueues.get(poolName)?.length ?? 0;
  }

  /**
   * Return oldest job age in seconds for a given pool.
   */
  getOldestJobAgeSeconds(poolName: WorkerPoolName, nowMs: number = Date.now()): number {
    const queue = this.poolQueues.get(poolName) ?? [];

    //audit Assumption: an empty queue has no lag signal; failure risk: scaler falsely interprets undefined lag as high-latency emergency; expected invariant: empty queues report 0s lag; handling strategy: return 0 for empty queues.
    if (queue.length === 0) {
      return 0;
    }

    //audit Assumption: this in-memory queue is strict FIFO because enqueue uses push and dequeue uses shift; failure risk: scanning timestamps can misreport age if caller-supplied timestamps are skewed; expected invariant: the queue head is the oldest still-waiting job; handling strategy: compute lag from queue[0] in O(1).
    const oldestQueuedJob = queue[0];

    return Math.max(0, Math.floor((nowMs - oldestQueuedJob.enqueuedAtMs) / 1000));
  }

  /**
   * Dequeue one job from a pool queue.
   */
  dequeue(poolName: WorkerPoolName): WorkerJob | null {
    const selectedQueue = this.poolQueues.get(poolName) ?? [];
    return selectedQueue.shift() ?? null;
  }
}

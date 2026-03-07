import type { WorkerPoolName } from './autoscalingTypes.js';

export interface WorkerLifecycleAdapter {
  spawn(pool: WorkerPoolName, count: number): Promise<void>;
  terminate(pool: WorkerPoolName, count: number): Promise<void>;
}

/**
 * Worker pool lifecycle manager for scaling pool sizes up/down.
 *
 * Purpose:
 * - Keep actual worker counts synchronized with scaler target counts.
 *
 * Inputs/outputs:
 * - Input: pool name and desired worker count.
 * - Output: updates in-memory pool counts after lifecycle adapter actions.
 *
 * Edge case behavior:
 * - Ignores no-op scale calls where target equals current count.
 */
export class WorkerManager {
  private readonly poolSizes: Map<WorkerPoolName, number> = new Map();

  constructor(private readonly lifecycleAdapter: WorkerLifecycleAdapter) {
    this.poolSizes.set('main_runtime_pool', 1);
    this.poolSizes.set('async_queue_pool', 1);
    this.poolSizes.set('audit_safe_pool', 1);
    this.poolSizes.set('creative_domain_pool', 1);
  }

  /**
   * Read current worker count for a pool.
   */
  count(poolName: WorkerPoolName): number {
    return this.poolSizes.get(poolName) ?? 0;
  }

  /**
   * Scale one pool to the requested target worker count.
   */
  async scale(poolName: WorkerPoolName, targetWorkerCount: number): Promise<void> {
    const currentWorkerCount = this.count(poolName);

    //audit Assumption: scale requests should always be positive integers; failure risk: invalid target causes negative diff and unsafe termination math; expected invariant: targetWorkerCount >= 1; handling strategy: reject invalid target with a structured error.
    if (!Number.isInteger(targetWorkerCount) || targetWorkerCount < 1) {
      throw new Error(`Invalid target worker count for ${poolName}: ${targetWorkerCount}`);
    }

    //audit Assumption: equal target/current means system is already converged; failure risk: unnecessary lifecycle churn increases instability; expected invariant: no-op scale does nothing; handling strategy: return early.
    if (targetWorkerCount === currentWorkerCount) {
      return;
    }

    if (targetWorkerCount > currentWorkerCount) {
      const workersToSpawn = targetWorkerCount - currentWorkerCount;
      await this.lifecycleAdapter.spawn(poolName, workersToSpawn);
      this.poolSizes.set(poolName, targetWorkerCount);
      return;
    }

    const workersToTerminate = currentWorkerCount - targetWorkerCount;
    await this.lifecycleAdapter.terminate(poolName, workersToTerminate);
    this.poolSizes.set(poolName, targetWorkerCount);
  }
}

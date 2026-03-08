import type { MetricsAgent } from './metricsAgent.js';
import type { WorkerManager } from './manager.js';
import { evaluateScaling } from './scaler.js';

export interface AutoscalingLoopDependencies {
  metricsAgent: MetricsAgent;
  workerManager: WorkerManager;
  onError?: (error: unknown) => void;
}

function ensureUniqueScalingActionsByPool(
  scalingActions: ReturnType<typeof evaluateScaling>
): ReturnType<typeof evaluateScaling> {
  const actionsByPool = new Map<string, ReturnType<typeof evaluateScaling>[number]>();

  for (const scalingAction of scalingActions) {
    //audit Assumption: each pool should receive at most one target per tick; failure risk: parallel same-pool actions race inside WorkerManager and leave counts inconsistent; expected invariant: one action per pool per tick; handling strategy: fail fast on duplicate pool entries before executing actions concurrently.
    if (actionsByPool.has(scalingAction.pool)) {
      throw new Error(`Duplicate scaling action generated for pool "${scalingAction.pool}".`);
    }

    actionsByPool.set(scalingAction.pool, scalingAction);
  }

  return [...actionsByPool.values()];
}

/**
 * Start the periodic autoscaling loop.
 *
 * Purpose:
 * - Continuously evaluate telemetry and apply scaler actions to worker pools.
 *
 * Inputs/outputs:
 * - Input: metrics agent, worker manager, interval in milliseconds.
 * - Output: timer handle that can be canceled by caller.
 *
 * Edge case behavior:
 * - Errors inside one tick are surfaced through `onError` and do not stop future ticks.
 */
export function startAutoscalingLoop(
  dependencies: AutoscalingLoopDependencies,
  intervalMs: number = 5_000
): NodeJS.Timeout {
  let currentTickPromise: Promise<void> | null = null;

  const executeScalingTick = async (): Promise<void> => {
    try {
      const currentMetrics = dependencies.metricsAgent.collectMetrics();
      const scalingActions = ensureUniqueScalingActionsByPool(evaluateScaling(currentMetrics));

      //audit Assumption: pool lifecycle operations are independent across distinct pools; failure risk: serial execution slows reaction time during multi-pool pressure events; expected invariant: each tick can apply one target per pool concurrently; handling strategy: execute distinct pool scale calls in parallel after duplicate-pool validation.
      await Promise.all(
        scalingActions.map(action => dependencies.workerManager.scale(action.pool, action.scaleTo))
      );
    } catch (error) {
      //audit Assumption: transient metrics or scaling failures should not permanently stop autoscaling; failure risk: one exception disables all future scale decisions; expected invariant: loop continues after each failed tick; handling strategy: report through callback and continue next interval tick.
      dependencies.onError?.(error);
    }
  };

  const runSerializedTick = (): Promise<void> => {
    //audit Assumption: overlapping ticks can compute scale targets from stale worker counts; failure risk: duplicate scale operations overshoot or thrash pool sizes; expected invariant: at most one autoscaling tick runs at a time; handling strategy: reuse the in-flight promise and skip interval-triggered overlap.
    if (currentTickPromise) {
      return currentTickPromise;
    }

    currentTickPromise = executeScalingTick().finally(() => {
      currentTickPromise = null;
    });

    return currentTickPromise;
  };

  void runSerializedTick();
  return setInterval(() => {
    if (currentTickPromise) {
      return;
    }

    void runSerializedTick();
  }, intervalMs);
}

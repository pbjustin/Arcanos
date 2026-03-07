import type { MetricsAgent } from './metricsAgent.js';
import type { WorkerManager } from './manager.js';
import { evaluateScaling } from './scaler.js';

export interface AutoscalingLoopDependencies {
  metricsAgent: MetricsAgent;
  workerManager: WorkerManager;
  onError?: (error: unknown) => void;
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
  const executeScalingTick = async (): Promise<void> => {
    try {
      const currentMetrics = dependencies.metricsAgent.collectMetrics();
      const scalingActions = evaluateScaling(currentMetrics);

      for (const action of scalingActions) {
        await dependencies.workerManager.scale(action.pool, action.scaleTo);
      }
    } catch (error) {
      //audit Assumption: transient metrics or scaling failures should not permanently stop autoscaling; failure risk: one exception disables all future scale decisions; expected invariant: loop continues after each failed tick; handling strategy: report through callback and continue next interval tick.
      dependencies.onError?.(error);
    }
  };

  void executeScalingTick();
  return setInterval(() => {
    void executeScalingTick();
  }, intervalMs);
}

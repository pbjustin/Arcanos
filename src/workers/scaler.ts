import type { AutoscalingMetricsSnapshot, ScalingAction } from './autoscalingTypes.js';

function evaluateDomainSurge(
  baselineTraffic: number,
  currentTraffic: number
): boolean {
  //audit Assumption: zero or missing baseline means no reliable surge reference; failure risk: divide-by-zero and false surge positives; expected invariant: surge detection needs baseline > 0; handling strategy: treat non-positive baseline as no-surge.
  if (baselineTraffic <= 0) {
    return false;
  }

  return currentTraffic > baselineTraffic * 3;
}

/**
 * Evaluate scaling actions from current telemetry snapshot.
 *
 * Purpose:
 * - Convert queue depth, latency, CPU pressure, and domain surges into concrete scale targets.
 *
 * Inputs/outputs:
 * - Input: one metrics snapshot for all worker pools.
 * - Output: deterministic list of scale actions.
 *
 * Edge case behavior:
 * - Returns an empty action list when no trigger conditions are met.
 */
export function evaluateScaling(metrics: AutoscalingMetricsSnapshot): ScalingAction[] {
  const scalingActions: ScalingAction[] = [];

  //audit Assumption: async backlog is the strongest leading signal of DAG pressure; failure risk: stale async jobs accumulate and breach SLA; expected invariant: high depth or lag triggers async scale-up; handling strategy: push async scale action based on severity tiers.
  if (metrics.async.depth > 50 || metrics.async.oldestJobAgeSeconds > 120) {
    scalingActions.push({
      pool: 'async_queue_pool',
      scaleTo: metrics.async.depth > 100 ? 5 : 3,
      reason: metrics.async.depth > 50 ? 'queue_backlog' : 'job_latency'
    });
  }

  //audit Assumption: main runtime pool should respond to CPU pressure quickly; failure risk: infra tasks starve and API latency spikes; expected invariant: CPU > 85% adds at least one worker; handling strategy: increment pool size by one relative to current.
  if (metrics.main.cpuRatio > 0.85) {
    scalingActions.push({
      pool: 'main_runtime_pool',
      scaleTo: metrics.main.workers + 1,
      reason: 'cpu_pressure'
    });
  }

  const domainToPool = {
    audit: 'audit_safe_pool',
    creative: 'creative_domain_pool'
  } as const;

  for (const domain of Object.keys(domainToPool) as Array<keyof typeof domainToPool>) {
    const baselineTraffic = metrics.baselineTrafficByDomain[domain];
    const currentTraffic = metrics.currentTrafficByDomain[domain];

    //audit Assumption: sustained 3x traffic spikes deserve proactive horizontal scaling; failure risk: domain-specific queues balloon before generic backlog triggers fire; expected invariant: surge domains receive one extra worker; handling strategy: add domain-specific scale action when surge is detected.
    if (evaluateDomainSurge(baselineTraffic, currentTraffic)) {
      scalingActions.push({
        pool: domainToPool[domain],
        scaleTo: 2,
        reason: 'domain_surge'
      });
    }
  }

  return scalingActions;
}

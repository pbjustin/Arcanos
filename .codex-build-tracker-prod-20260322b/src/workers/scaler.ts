import type { AutoscalingMetricsSnapshot, ScalingAction } from './autoscalingTypes.js';

function readPositiveNumberFromEnvironment(
  variableName: string,
  fallbackValue: number
): number {
  const rawValue = process.env[variableName];
  const parsedValue = Number(rawValue);

  //audit Assumption: autoscaling thresholds must remain finite positive numbers to keep scaler decisions deterministic; failure risk: malformed env overrides disable or spam scale actions; expected invariant: each threshold resolves to a positive finite number; handling strategy: ignore invalid overrides and keep the fallback.
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return parsedValue;
}

const ASYNC_QUEUE_BACKLOG_THRESHOLD = 50;
const ASYNC_QUEUE_SEVERE_BACKLOG_THRESHOLD = 100;
const ASYNC_JOB_LATENCY_THRESHOLD_SECONDS = 120;
const ASYNC_QUEUE_SCALE_TARGET = 3;
const ASYNC_QUEUE_SEVERE_SCALE_TARGET = 5;
const MAIN_CPU_PRESSURE_THRESHOLD = readPositiveNumberFromEnvironment('AUTOSCALING_MAIN_CPU_THRESHOLD', 0.8);
const MAIN_MEMORY_PRESSURE_THRESHOLD = readPositiveNumberFromEnvironment('AUTOSCALING_MAIN_MEMORY_PRESSURE_THRESHOLD', 0.8);
const MAIN_API_LATENCY_THRESHOLD_MS = readPositiveNumberFromEnvironment('AUTOSCALING_MAIN_API_LATENCY_THRESHOLD_MS', 300);
const DOMAIN_SURGE_MULTIPLIER = readPositiveNumberFromEnvironment('AUTOSCALING_DOMAIN_SURGE_MULTIPLIER', 3);
const DOMAIN_SURGE_SCALE_TARGET = 2;

function evaluateDomainSurge(
  baselineTraffic: number,
  currentTraffic: number
): boolean {
  //audit Assumption: zero or missing baseline means no reliable surge reference; failure risk: divide-by-zero and false surge positives; expected invariant: surge detection needs baseline > 0; handling strategy: treat non-positive baseline as no-surge.
  if (baselineTraffic <= 0) {
    return false;
  }

  return currentTraffic > baselineTraffic * DOMAIN_SURGE_MULTIPLIER;
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
  if (
    metrics.async.depth > ASYNC_QUEUE_BACKLOG_THRESHOLD ||
    metrics.async.oldestJobAgeSeconds > ASYNC_JOB_LATENCY_THRESHOLD_SECONDS
  ) {
    scalingActions.push({
      pool: 'async_queue_pool',
      scaleTo:
        metrics.async.depth > ASYNC_QUEUE_SEVERE_BACKLOG_THRESHOLD
          ? ASYNC_QUEUE_SEVERE_SCALE_TARGET
          : ASYNC_QUEUE_SCALE_TARGET,
      reason: metrics.async.depth > ASYNC_QUEUE_BACKLOG_THRESHOLD ? 'queue_backlog' : 'job_latency'
    });
  }

  const mainPoolScaleReason: ScalingAction['reason'] | null =
    metrics.main.cpuRatio > MAIN_CPU_PRESSURE_THRESHOLD
      ? 'cpu_pressure'
      : metrics.main.memoryPressureRatio > MAIN_MEMORY_PRESSURE_THRESHOLD
        ? 'memory_pressure'
        : metrics.main.apiLatencyMs > MAIN_API_LATENCY_THRESHOLD_MS
          ? 'api_latency'
          : null;

  //audit Assumption: main runtime saturation can surface through CPU, memory pressure, or API latency before queue backlog alone catches up; failure risk: Trinity latency spikes persist while the main runtime remains underscaled; expected invariant: any leading saturation signal triggers one incremental scale-up; handling strategy: collapse the strongest active signal into one main-pool action per tick.
  if (mainPoolScaleReason) {
    scalingActions.push({
      pool: 'main_runtime_pool',
      scaleTo: metrics.main.workers + 1,
      reason: mainPoolScaleReason
    });
  }

  const domainToPool = {
    audit: 'audit_safe_pool',
    creative: 'creative_domain_pool'
  } as const;

  for (const domain of Object.keys(domainToPool) as Array<keyof typeof domainToPool>) {
    const baselineTraffic = metrics.baselineTrafficByDomain[domain];
    const currentTraffic = metrics.currentTrafficByDomain[domain];

    //audit Assumption: sustained traffic growth versus the historical baseline deserves proactive horizontal scaling; failure risk: domain-specific queues balloon before generic backlog triggers fire; expected invariant: surge domains receive one extra worker; handling strategy: compare current traffic to the historical baseline and scale the matching pool when the multiplier is exceeded.
    if (evaluateDomainSurge(baselineTraffic, currentTraffic)) {
      scalingActions.push({
        pool: domainToPool[domain],
        scaleTo: DOMAIN_SURGE_SCALE_TARGET,
        reason: 'domain_surge'
      });
    }
  }

  return scalingActions;
}

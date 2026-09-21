import { healthMetrics } from '../platform/logging/logger.js';
import {
  createDagMetricsRecorderCore,
  type DagMetricsRecorder
} from '../shared/dag/dagMetricsCore.js';

export type { DagMetricsRecorder, DagMetricsSnapshot } from '../shared/dag/dagMetricsCore.js';

/**
 * Create a DAG metrics recorder backed by in-memory counters and shared health metrics.
 *
 * Purpose:
 * - Provide lightweight orchestration telemetry without introducing another metrics backend.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: a metrics recorder safe for repeated DAG runs in the same process.
 *
 * Edge case behavior:
 * - Reuses process-local state only; metrics reset when the process restarts.
 */
export function createDagMetricsRecorder(): DagMetricsRecorder {
  return createDagMetricsRecorderCore((metricName, value) => healthMetrics.record(metricName, value));
}

export const dagMetrics: DagMetricsRecorder = createDagMetricsRecorder();

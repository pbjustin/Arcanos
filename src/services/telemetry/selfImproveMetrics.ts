/**
 * Self-Improve Metrics Collector
 */
import { recordTraceEvent, markOperation } from "@platform/logging/telemetry.js";

export type SelfImproveMetric =
  | 'self_improve.triggered'
  | 'self_improve.noop'
  | 'self_improve.soft_update'
  | 'self_improve.patch_proposal'
  | 'self_improve.patch_structured'
  | 'self_improve.patch_structured_error'
  | 'self_improve.pr_gate'
  | 'self_improve.pr_created'
  | 'self_improve.escalate'
  | 'self_improve.rollback'
  | 'self_improve.frozen';

export function metric(event: SelfImproveMetric, props: Record<string, unknown> = {}) {
  markOperation(event);
  recordTraceEvent('self_improve', { event, ...props });
}

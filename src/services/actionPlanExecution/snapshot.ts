import type { ActionRecord } from '@shared/types/actionPlan.js';
import {
  canonicalizeJson,
  fingerprintCanonicalValue,
  type CanonicalJsonValue,
} from './canonical.js';
import { ACTION_PLAN_EXECUTION_ERRORS, ActionPlanExecutionError } from './errors.js';

export const ACTION_PLAN_SNAPSHOT_SCHEMA_VERSION = 1;
export const ACTION_PLAN_SNAPSHOT_SCHEMA_NAME = 'action-execution-snapshot-v1';
export const ACTION_PLAN_SNAPSHOT_MAX_BYTES = 32 * 1024;
export const ACTION_PLAN_SNAPSHOT_MAX_DEPTH = 8;

export interface ActionExecutionSnapshot {
  snapshot_version: typeof ACTION_PLAN_SNAPSHOT_SCHEMA_NAME;
  plan_id: string;
  action_id: string;
  agent_id: string;
  capability: string;
  params: CanonicalJsonValue;
  timeout_ms: number;
  sort_order: number;
  plan_execution_generation: number;
  executor_kind: 'python-daemon';
  assigned_executor_principal_id: string;
  agent_capability_fingerprint: string;
  rollback_action?: CanonicalJsonValue;
}

interface SnapshotOptions {
  planExecutionGeneration: number;
  executorKind: 'python-daemon';
  assignedExecutorPrincipalId: string;
  agentCapabilities: readonly string[];
  sensitiveValues?: readonly string[];
  maxBytes?: number;
  maxDepth?: number;
}

function toCanonicalJsonValue(
  value: unknown,
  sensitiveValues: ReadonlySet<string>,
  maxDepth: number,
  depth = 0,
): CanonicalJsonValue {
  if (depth > maxDepth) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.snapshotUnavailable);
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (sensitiveValues.has(value)) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.snapshotUnavailable);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.snapshotUnavailable);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => toCanonicalJsonValue(item, sensitiveValues, maxDepth, depth + 1));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized = Object.create(null) as Record<string, CanonicalJsonValue>;
    for (const key of Object.keys(record).sort()) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.snapshotUnavailable);
      }
      const entry = record[key];
      if (entry === undefined) {
        continue;
      }
      normalized[key] = toCanonicalJsonValue(entry, sensitiveValues, maxDepth, depth + 1);
    }
    return normalized;
  }
  throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.snapshotUnavailable);
}

export function buildActionExecutionSnapshot(
  action: ActionRecord,
  options: SnapshotOptions,
): ActionExecutionSnapshot {
  const sensitiveValues = new Set(
    (options.sensitiveValues ?? []).filter(value => typeof value === 'string' && value.length > 0),
  );
  const maxDepth = options.maxDepth ?? ACTION_PLAN_SNAPSHOT_MAX_DEPTH;
  const maxBytes = options.maxBytes ?? ACTION_PLAN_SNAPSHOT_MAX_BYTES;
  const params = toCanonicalJsonValue(action.params, sensitiveValues, maxDepth);
  const rollbackAction = action.rollbackAction === null || action.rollbackAction === undefined
    ? undefined
    : toCanonicalJsonValue(action.rollbackAction, sensitiveValues, maxDepth);
  const snapshot: ActionExecutionSnapshot = {
    snapshot_version: ACTION_PLAN_SNAPSHOT_SCHEMA_NAME,
    plan_id: action.planId,
    action_id: action.id,
    agent_id: action.agentId,
    capability: action.capability,
    params,
    timeout_ms: action.timeoutMs,
    sort_order: action.sortOrder,
    plan_execution_generation: options.planExecutionGeneration,
    executor_kind: options.executorKind,
    assigned_executor_principal_id: options.assignedExecutorPrincipalId,
    agent_capability_fingerprint: fingerprintCanonicalValue('action-plan-agent-capability-v1', {
      agent_id: action.agentId,
      capabilities: [...new Set(options.agentCapabilities)].sort(),
    }),
    ...(rollbackAction === undefined ? {} : { rollback_action: rollbackAction }),
  };

  if (Buffer.byteLength(canonicalizeJson(snapshot as unknown as CanonicalJsonValue), 'utf8') > maxBytes) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.snapshotUnavailable);
  }
  return snapshot;
}

export function actionExecutionSnapshotMatches(
  action: ActionRecord,
  expected: ActionExecutionSnapshot,
  options: SnapshotOptions,
): boolean {
  try {
    return canonicalizeJson(
      buildActionExecutionSnapshot(action, options) as unknown as CanonicalJsonValue,
    ) === canonicalizeJson(expected as unknown as CanonicalJsonValue);
  } catch {
    return false;
  }
}

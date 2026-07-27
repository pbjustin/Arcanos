import { redactString } from '@shared/redaction.js';

import type {
  AfolErrorCategory,
  AfolPersistedDecisionRecord,
  AfolPersistedErrorRecord,
  DecisionRecord,
  HealthSnapshot,
  RouteName,
} from './types.js';

export const AFOL_REDACTED_PROMPT = '[REDACTED_PROMPT]';
export const AFOL_REDACTED_INTENT = '[REDACTED_INTENT]';
export const AFOL_REDACTED_OUTPUT = '[REDACTED_OUTPUT]';
export const AFOL_ROUTE_FAILURE_MESSAGE = 'AFOL route execution could not be completed.';

const AFOL_DECISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const AFOL_LOG_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

interface AfolAnalyticsSnapshot {
  totals: {
    decisions: number;
    successful: number;
    rejected: number;
  };
  perRoute: Record<RouteName, number>;
  latency: {
    averageMs: number;
    lastMs: number;
  };
  recent: Array<
    AfolPersistedDecisionRecord |
    ReturnType<typeof projectAfolDecisionForInspection>
  >;
  lastUpdated: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function asFiniteNonNegativeInteger(value: unknown): number {
  return Math.floor(asFiniteNonNegativeNumber(value));
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asRouteName(value: unknown): RouteName {
  return value === 'primary' || value === 'backup' || value === 'reject'
    ? value
    : 'reject';
}

function fixedRouteReason(route: RouteName): string {
  if (route === 'primary') {
    return 'Primary healthy';
  }
  if (route === 'backup') {
    return 'Fallback engaged';
  }
  return 'No viable route';
}

function fixedPolicyRationale(
  primaryAvailable: boolean,
  backupAvailable: boolean
): string {
  if (primaryAvailable) {
    return 'Primary path stable';
  }
  if (backupAvailable) {
    return 'Switching to fallback route';
  }
  return 'No healthy routes available';
}

function projectTimestamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : 'invalid';
}

function projectOptionalTimestamp(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : projectTimestamp(value);
}

function projectDecisionId(value: unknown): string {
  return typeof value === 'string' && AFOL_DECISION_ID_PATTERN.test(value)
    ? value
    : 'redacted';
}

function projectPersistedDecision(
  value: Record<string, unknown>
): AfolPersistedDecisionRecord {
  return {
    kind: 'decision',
    id: projectDecisionId(value.id),
    timestamp: projectTimestamp(value.timestamp),
    ok: asBoolean(value.ok),
    route: asRouteName(value.route),
    latencyMs: asFiniteNonNegativeNumber(value.latencyMs),
    cached: asBoolean(value.cached),
    degraded: asBoolean(value.degraded),
  };
}

function projectErrorCategory(value: unknown): AfolErrorCategory {
  if (
    value === 'decision_failed' ||
    value === 'persistence_failed' ||
    value === 'internal_failure'
  ) {
    return value;
  }
  return 'internal_failure';
}

function projectPersistedError(
  value: Record<string, unknown>
): AfolPersistedErrorRecord {
  return {
    kind: 'error',
    timestamp: projectTimestamp(value.timestamp),
    category: projectErrorCategory(value.category),
  };
}

function projectModel(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    return undefined;
  }
  return redactString(value);
}

function projectModelAnswer(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return redactString(value);
}

function projectDecisionMetadata(
  value: unknown,
  route: RouteName
): Record<string, unknown> {
  const metadata = isRecord(value) ? value : {};
  return {
    routeReason: fixedRouteReason(route),
    ...(Object.hasOwn(metadata, 'intent')
      ? { intent: AFOL_REDACTED_INTENT }
      : {}),
    ...(typeof metadata.degraded === 'boolean'
      ? { degraded: metadata.degraded }
      : {}),
  };
}

export function projectAfolDecisionForHttp(
  value: DecisionRecord | unknown
): {
  id: string;
  ok: boolean;
  policy: {
    allow: boolean;
    primaryAvailable: boolean;
    backupAvailable: boolean;
    rationale: string;
  };
  route: {
    name: RouteName;
    reason: string;
  };
  response: {
    route: RouteName;
    input: string;
    output?: string;
    model?: string;
    cached?: boolean;
    error?: string;
    metadata: Record<string, unknown>;
  };
  meta: {
    latencyMs: number;
    timestamp: string;
  };
} {
  const decision = isRecord(value) ? value : {};
  const policy = isRecord(decision.policy) ? decision.policy : {};
  const routeRecord = isRecord(decision.route) ? decision.route : {};
  const response = isRecord(decision.response) ? decision.response : {};
  const meta = isRecord(decision.meta) ? decision.meta : {};
  const route = asRouteName(routeRecord.name ?? response.route);
  const primaryAvailable = asBoolean(policy.primaryAvailable);
  const backupAvailable = asBoolean(policy.backupAvailable);
  const output = projectModelAnswer(response.output);
  const model = projectModel(response.model);

  return {
    id: projectDecisionId(decision.id),
    ok: asBoolean(decision.ok),
    policy: {
      allow: asBoolean(policy.allow),
      primaryAvailable,
      backupAvailable,
      rationale: fixedPolicyRationale(primaryAvailable, backupAvailable),
    },
    route: {
      name: route,
      reason: fixedRouteReason(route),
    },
    response: {
      route,
      input: AFOL_REDACTED_PROMPT,
      ...(output === undefined ? {} : { output }),
      ...(model === undefined ? {} : { model }),
      ...(typeof response.cached === 'boolean'
        ? { cached: response.cached }
        : {}),
      ...(Object.hasOwn(response, 'error')
        ? { error: AFOL_ROUTE_FAILURE_MESSAGE }
        : {}),
      metadata: projectDecisionMetadata(response.metadata, route),
    },
    meta: {
      latencyMs: asFiniteNonNegativeNumber(meta.latencyMs),
      timestamp: projectTimestamp(meta.timestamp),
    },
  };
}

export function projectAfolDecisionForInspection(
  value: DecisionRecord | unknown
): ReturnType<typeof projectAfolDecisionForHttp> {
  const projected = projectAfolDecisionForHttp(value);
  const decision = isRecord(value) ? value : {};
  const response = isRecord(decision.response) ? decision.response : {};
  return {
    ...projected,
    response: {
      ...projected.response,
      ...(Object.hasOwn(response, 'output')
        ? { output: AFOL_REDACTED_OUTPUT }
        : {}),
    },
  };
}

function projectLogContext(value: unknown): string | undefined {
  if (typeof value !== 'string' || !AFOL_LOG_CONTEXT_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

export function projectAfolLogsForHttp(
  entries: readonly unknown[]
): unknown[] {
  const projectedEntries: unknown[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.kind === 'decision') {
      projectedEntries.push(projectPersistedDecision(entry));
      continue;
    }
    if (entry.kind === 'error') {
      projectedEntries.push(projectPersistedError(entry));
      continue;
    }
    const context = projectLogContext(entry.context);
    projectedEntries.push({
      timestamp: projectTimestamp(entry.timestamp),
      ...(Object.hasOwn(entry, 'input')
        ? { input: AFOL_REDACTED_PROMPT }
        : {}),
      ...(Object.hasOwn(entry, 'decision')
        ? { decision: projectAfolDecisionForInspection(entry.decision) }
        : {}),
      ...(context === undefined ? {} : { context }),
      ...(Object.hasOwn(entry, 'error')
        ? { error: AFOL_ROUTE_FAILURE_MESSAGE }
        : {}),
    });
  }
  return projectedEntries;
}

export function projectAfolAnalyticsForHttp(
  value: unknown
): AfolAnalyticsSnapshot {
  const snapshot = isRecord(value) ? value : {};
  const totals = isRecord(snapshot.totals) ? snapshot.totals : {};
  const perRoute = isRecord(snapshot.perRoute) ? snapshot.perRoute : {};
  const latency = isRecord(snapshot.latency) ? snapshot.latency : {};
  const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
  const projectedRecent: AfolAnalyticsSnapshot['recent'] = [];
  for (const record of recent) {
    if (isRecord(record) && record.kind === 'decision') {
      projectedRecent.push(projectPersistedDecision(record));
      continue;
    }
    if (isRecord(record) && record.kind === 'error') {
      continue;
    }
    projectedRecent.push(projectAfolDecisionForInspection(record));
  }

  return {
    totals: {
      decisions: asFiniteNonNegativeInteger(totals.decisions),
      successful: asFiniteNonNegativeInteger(totals.successful),
      rejected: asFiniteNonNegativeInteger(totals.rejected),
    },
    perRoute: {
      primary: asFiniteNonNegativeInteger(perRoute.primary),
      backup: asFiniteNonNegativeInteger(perRoute.backup),
      reject: asFiniteNonNegativeInteger(perRoute.reject),
    },
    latency: {
      averageMs: asFiniteNonNegativeNumber(latency.averageMs),
      lastMs: asFiniteNonNegativeNumber(latency.lastMs),
    },
    recent: projectedRecent,
    lastUpdated: projectOptionalTimestamp(snapshot.lastUpdated),
  };
}

function projectServiceHealth(value: unknown): { ok: boolean; latency: number } {
  const health = isRecord(value) ? value : {};
  return {
    ok: asBoolean(health.ok),
    latency: asFiniteNonNegativeNumber(health.latency),
  };
}

export function projectAfolHealthForHttp(
  snapshot: HealthSnapshot
): HealthSnapshot {
  return {
    redis: projectServiceHealth(snapshot.redis),
    postgres: projectServiceHealth(snapshot.postgres),
    api: projectServiceHealth(snapshot.api),
  };
}

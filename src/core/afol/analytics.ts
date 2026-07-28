import path from 'node:path';

import { recordTraceEvent } from '@platform/logging/telemetry.js';
import { getEnv, getEnvNumber } from '@platform/runtime/env.js';

import {
  clampAfolPersistenceRecordLimit,
  projectAfolPersistenceRecord,
  resolveSafePersistenceTarget,
  writeFileAtomically,
} from './persistence.js';
import type {
  AfolPersistedDecisionRecord,
  RouteName,
} from './types.js';

interface AnalyticsState {
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
  recent: AfolPersistedDecisionRecord[];
  lastUpdated: string | null;
}

const DEFAULT_RECENT_LIMIT = 50;

const configuredAnalyticsPath = getEnv('AFOL_ANALYTICS_PATH');
const defaultAnalyticsPath = path.resolve(
  configuredAnalyticsPath ?? path.join('logs', 'afol-analytics.json')
);
const defaultRecentLimit = clampAfolPersistenceRecordLimit(
  getEnvNumber('AFOL_ANALYTICS_RECENT_LIMIT', DEFAULT_RECENT_LIMIT),
  DEFAULT_RECENT_LIMIT
);

let analyticsFilePath = defaultAnalyticsPath;
let recentLimit = defaultRecentLimit;
let analyticsQueue: Promise<void> = Promise.resolve();

function createEmptyState(): AnalyticsState {
  return {
    totals: {
      decisions: 0,
      successful: 0,
      rejected: 0,
    },
    perRoute: {
      primary: 0,
      backup: 0,
      reject: 0,
    },
    latency: {
      averageMs: 0,
      lastMs: 0,
    },
    recent: [],
    lastUpdated: null,
  };
}

let state = createEmptyState();

function enqueueAnalyticsOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const result = analyticsQueue.then(operation, operation);
  analyticsQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function strictDecisionCopy(
  value: AfolPersistedDecisionRecord
): AfolPersistedDecisionRecord | null {
  const projected = projectAfolPersistenceRecord(value);
  return projected?.kind === 'decision' ? projected : null;
}

function cloneState(value: AnalyticsState): AnalyticsState {
  return {
    totals: { ...value.totals },
    perRoute: { ...value.perRoute },
    latency: { ...value.latency },
    recent: value.recent.flatMap((record) => {
      const copy = strictDecisionCopy(record);
      return copy ? [copy] : [];
    }),
    lastUpdated: value.lastUpdated,
  };
}

function buildCandidateState(
  current: AnalyticsState,
  decision: AfolPersistedDecisionRecord
): AnalyticsState {
  const decisions = current.totals.decisions + 1;
  const averageMs = decisions === 1
    ? decision.latencyMs
    : Math.round(
      (
        current.latency.averageMs * current.totals.decisions +
        decision.latencyMs
      ) / decisions
    );
  const recent = [
    ...current.recent,
    decision,
  ].slice(-recentLimit);

  return {
    totals: {
      decisions,
      successful:
        current.totals.successful + (decision.ok ? 1 : 0),
      rejected:
        current.totals.rejected + (decision.ok ? 0 : 1),
    },
    perRoute: {
      ...current.perRoute,
      [decision.route]: current.perRoute[decision.route] + 1,
    },
    latency: {
      averageMs,
      lastMs: decision.latencyMs,
    },
    recent,
    lastUpdated: new Date().toISOString(),
  };
}

async function writeAnalyticsState(
  candidate: AnalyticsState
): Promise<void> {
  await writeFileAtomically(
    analyticsFilePath,
    `${JSON.stringify(candidate, null, 2)}\n`
  );
}

export function configureAnalytics(
  options: { filePath?: string; recentLimit?: number } = {}
): Promise<void> {
  return enqueueAnalyticsOperation(async () => {
    const nextPath = options.filePath
      ? path.resolve(options.filePath)
      : defaultAnalyticsPath;
    const canonicalPath = await resolveSafePersistenceTarget(nextPath, {
      createParent: true,
    });
    analyticsFilePath = canonicalPath;
    recentLimit = options.recentLimit === undefined
      ? defaultRecentLimit
      : clampAfolPersistenceRecordLimit(
        options.recentLimit,
        DEFAULT_RECENT_LIMIT
      );
  });
}

/**
 * Persist a metadata-only analytics candidate and publish it in memory only
 * after the atomic replacement succeeds.
 */
export function persistDecision(
  value: AfolPersistedDecisionRecord
): Promise<boolean> {
  const decision = strictDecisionCopy(value);
  if (!decision) {
    recordTraceEvent('afol.analytics.persist_failed', {
      category: 'invalid_record',
    });
    return Promise.resolve(false);
  }

  return enqueueAnalyticsOperation(async () => {
    const candidate = buildCandidateState(state, decision);
    try {
      await writeAnalyticsState(candidate);
    } catch {
      recordTraceEvent('afol.analytics.persist_failed', {
        category: 'io_failure',
      });
      return false;
    }

    state = candidate;
    recordTraceEvent('afol.analytics.persisted', {
      decisionId: decision.id,
      route: decision.route,
      ok: decision.ok,
    });
    return true;
  });
}

export function getAnalyticsSnapshot(): Promise<AnalyticsState> {
  return enqueueAnalyticsOperation(async () => cloneState(state));
}

/**
 * Reset through the same write queue. The existing file is atomically replaced
 * with an empty snapshot rather than deleted.
 */
export function resetAnalytics(): Promise<boolean> {
  return enqueueAnalyticsOperation(async () => {
    const candidate = createEmptyState();
    try {
      await writeAnalyticsState(candidate);
    } catch {
      recordTraceEvent('afol.analytics.reset_failed', {
        category: 'io_failure',
      });
      return false;
    }
    state = candidate;
    return true;
  });
}

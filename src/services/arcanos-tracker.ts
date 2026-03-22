import type {
  CancelDagRunResponseData,
  DagRunError,
  DagEventsData,
  DagLineageData,
  DagMetricsData,
  DagRunData,
  DagRunSummary,
  DagTreeData,
  DagVerificationData,
  NodeDetailData
} from '../shared/types/arcanos-verification-contract.types.js';
import type { DagRunWaitResult, WaitForDagRunUpdateOptions } from './arcanosDagRunService.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { arcanosDagRunService } from './arcanosDagRunService.js';
import type { ModuleDef } from './moduleLoader.js';

type TrackerQueryView =
  | 'overview'
  | 'run'
  | 'wait'
  | 'tree'
  | 'node'
  | 'events'
  | 'metrics'
  | 'errors'
  | 'lineage'
  | 'verification';

interface ArcanosTrackerPayload {
  runId?: string;
  dagRunId?: string;
  id?: string;
  nodeId?: string;
  updatedAfter?: string;
  waitForUpdateMs?: number;
  view?: string;
  operation?: string;
  mode?: string;
}

interface TrackerOverviewResult {
  run: DagRunSummary;
  metrics: DagMetricsData;
  verification: DagVerificationData;
}

const TRACKER_VIEW_ALIASES: Record<string, TrackerQueryView> = {
  overview: 'overview',
  summary: 'run',
  status: 'run',
  run: 'run',
  getrun: 'run',
  wait: 'wait',
  waitforrunupdate: 'wait',
  tree: 'tree',
  getruntree: 'tree',
  node: 'node',
  getnode: 'node',
  events: 'events',
  getrunevents: 'events',
  metrics: 'metrics',
  getrunmetrics: 'metrics',
  errors: 'errors',
  getrunerrors: 'errors',
  lineage: 'lineage',
  getrunlineage: 'lineage',
  verification: 'verification',
  getrunverification: 'verification'
};

const ArcanosTracker: ModuleDef = {
  name: 'ARCANOS:TRACKER',
  description: 'Trinity DAG run tracker for status, metrics, verification, and cancellation.',
  gptIds: ['arcanos-tracker', 'tracker'],
  defaultAction: 'query',
  defaultTimeoutMs: 60000,
  actions: {
    async query(payload: unknown) {
      const normalizedPayload = normalizeTrackerPayload(payload);
      const runId = requireTrackerRunId(normalizedPayload);
      const view = resolveTrackerView(normalizedPayload);

      logger.info('arcanos.tracker.query', {
        module: 'arcanos-tracker',
        runId,
        view
      });

      switch (view) {
        case 'overview':
          return getTrackerOverview(runId);
        case 'run':
          return getRequiredRun(runId);
        case 'wait':
          return getRequiredWaitResult(runId, normalizedPayload);
        case 'tree':
          return getRequiredRunTree(runId);
        case 'node':
          return getRequiredNode(runId, requireTrackerNodeId(normalizedPayload));
        case 'events':
          return getRequiredRunEvents(runId);
        case 'metrics':
          return getRequiredRunMetrics(runId);
        case 'errors':
          return getRequiredRunErrors(runId);
        case 'lineage':
          return getRequiredRunLineage(runId);
        case 'verification':
          return getRequiredRunVerification(runId);
      }
    },
    async getRun(payload: unknown) {
      return getRequiredRun(requireTrackerRunId(normalizeTrackerPayload(payload)));
    },
    async waitForRunUpdate(payload: unknown) {
      const normalizedPayload = normalizeTrackerPayload(payload);
      return getRequiredWaitResult(requireTrackerRunId(normalizedPayload), normalizedPayload);
    },
    async getRunTree(payload: unknown) {
      return getRequiredRunTree(requireTrackerRunId(normalizeTrackerPayload(payload)));
    },
    async getNode(payload: unknown) {
      const normalizedPayload = normalizeTrackerPayload(payload);
      return getRequiredNode(
        requireTrackerRunId(normalizedPayload),
        requireTrackerNodeId(normalizedPayload)
      );
    },
    async getRunEvents(payload: unknown) {
      return getRequiredRunEvents(requireTrackerRunId(normalizeTrackerPayload(payload)));
    },
    async getRunMetrics(payload: unknown) {
      return getRequiredRunMetrics(requireTrackerRunId(normalizeTrackerPayload(payload)));
    },
    async getRunErrors(payload: unknown) {
      return getRequiredRunErrors(requireTrackerRunId(normalizeTrackerPayload(payload)));
    },
    async getRunLineage(payload: unknown) {
      return getRequiredRunLineage(requireTrackerRunId(normalizeTrackerPayload(payload)));
    },
    async getRunVerification(payload: unknown) {
      return getRequiredRunVerification(requireTrackerRunId(normalizeTrackerPayload(payload)));
    },
    async cancelRun(payload: unknown) {
      const normalizedPayload = normalizeTrackerPayload(payload);
      const runId = requireTrackerRunId(normalizedPayload);
      const cancelledRun = arcanosDagRunService.cancelRun(runId);

      if (!cancelledRun) {
        throw new Error(`ARCANOS:TRACKER cancelRun could not find run "${runId}".`);
      }

      logger.info('arcanos.tracker.run.cancelled', {
        module: 'arcanos-tracker',
        runId,
        cancelledNodes: cancelledRun.cancelledNodes
      });

      return cancelledRun;
    }
  }
};

export default ArcanosTracker;

function normalizeTrackerPayload(payload: unknown): ArcanosTrackerPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return typeof payload === 'string' ? { runId: payload } : {};
  }

  return payload as ArcanosTrackerPayload;
}

function resolveTrackerView(payload: ArcanosTrackerPayload): TrackerQueryView {
  const rawValue = [
    payload.view,
    payload.operation,
    payload.mode
  ].find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);

  if (!rawValue) {
    return 'overview';
  }

  const normalizedView = rawValue.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const resolvedView = TRACKER_VIEW_ALIASES[normalizedView];
  if (resolvedView) {
    return resolvedView;
  }

  throw new Error(`ARCANOS:TRACKER query does not support view "${rawValue}".`);
}

function requireTrackerRunId(payload: ArcanosTrackerPayload): string {
  for (const candidate of [payload.runId, payload.dagRunId, payload.id]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  throw new Error('ARCANOS:TRACKER requires a runId.');
}

function requireTrackerNodeId(payload: ArcanosTrackerPayload): string {
  if (typeof payload.nodeId === 'string' && payload.nodeId.trim().length > 0) {
    return payload.nodeId.trim();
  }

  throw new Error('ARCANOS:TRACKER getNode requires a nodeId.');
}

async function getTrackerOverview(runId: string): Promise<TrackerOverviewResult> {
  const [run, metrics, verification] = await Promise.all([
    getRequiredRun(runId),
    getRequiredRunMetrics(runId),
    getRequiredRunVerification(runId)
  ]);

  return {
    run: run.run,
    metrics,
    verification
  };
}

async function getRequiredRun(runId: string): Promise<DagRunData> {
  const run = await arcanosDagRunService.getRun(runId);
  if (!run) {
    throw new Error(`ARCANOS:TRACKER could not find run "${runId}".`);
  }

  return { run };
}

async function getRequiredWaitResult(
  runId: string,
  payload: ArcanosTrackerPayload
): Promise<DagRunWaitResult> {
  const waitResult = await arcanosDagRunService.waitForRunUpdate(runId, extractWaitOptions(payload));
  if (!waitResult) {
    throw new Error(`ARCANOS:TRACKER could not find run "${runId}".`);
  }

  return waitResult;
}

async function getRequiredRunTree(runId: string): Promise<DagTreeData> {
  const tree = await arcanosDagRunService.getRunTree(runId);
  if (!tree) {
    throw new Error(`ARCANOS:TRACKER could not find run "${runId}".`);
  }

  return tree;
}

async function getRequiredNode(runId: string, nodeId: string): Promise<NodeDetailData> {
  const node = await arcanosDagRunService.getNode(runId, nodeId);
  if (!node) {
    throw new Error(`ARCANOS:TRACKER could not find node "${nodeId}" for run "${runId}".`);
  }

  return { node };
}

async function getRequiredRunEvents(runId: string): Promise<DagEventsData> {
  const events = await arcanosDagRunService.getRunEvents(runId);
  if (!events) {
    throw new Error(`ARCANOS:TRACKER could not find run "${runId}".`);
  }

  return events;
}

async function getRequiredRunMetrics(runId: string): Promise<DagMetricsData> {
  const metrics = await arcanosDagRunService.getRunMetrics(runId);
  if (!metrics) {
    throw new Error(`ARCANOS:TRACKER could not find run "${runId}".`);
  }

  return metrics;
}

async function getRequiredRunErrors(
  runId: string
): Promise<{ runId: string; errors: DagRunError[] }> {
  const errors = await arcanosDagRunService.getRunErrors(runId);
  if (!errors) {
    throw new Error(`ARCANOS:TRACKER could not find run "${runId}".`);
  }

  return errors;
}

async function getRequiredRunLineage(runId: string): Promise<DagLineageData> {
  const lineage = await arcanosDagRunService.getRunLineage(runId);
  if (!lineage) {
    throw new Error(`ARCANOS:TRACKER could not find run "${runId}".`);
  }

  return lineage;
}

async function getRequiredRunVerification(runId: string): Promise<DagVerificationData> {
  const verification = await arcanosDagRunService.getRunVerification(runId);
  if (!verification) {
    throw new Error(`ARCANOS:TRACKER could not find run "${runId}".`);
  }

  return verification;
}

function extractWaitOptions(payload: ArcanosTrackerPayload): WaitForDagRunUpdateOptions {
  const options: WaitForDagRunUpdateOptions = {};

  if (typeof payload.updatedAfter === 'string' && payload.updatedAfter.trim().length > 0) {
    options.updatedAfter = payload.updatedAfter.trim();
  }

  if (typeof payload.waitForUpdateMs === 'number' && Number.isInteger(payload.waitForUpdateMs) && payload.waitForUpdateMs >= 0) {
    options.waitForUpdateMs = payload.waitForUpdateMs;
  }

  return options;
}

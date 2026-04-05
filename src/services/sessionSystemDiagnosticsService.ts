/**
 * Machine-verifiable diagnostics for the canonical ARCANOS session system.
 */

import type { Application } from 'express';
import { getStatus as getDatabaseStatus } from '@core/db/client.js';
import {
  getLatestJob,
  getJobQueueSummary,
  type JobFailureBreakdown,
  type JobFailureReasonSummary
} from '@core/db/repositories/jobRepository.js';
import { getSessionStorageMetrics } from '@core/db/repositories/sessionRepository.js';
import { getCanonicalPublicRouteTable } from './runtimeRouteTableService.js';

type DiagnosticStatus = 'live' | 'offline' | 'degraded';

function resolveBuildIdentifier(): string {
  return (
    process.env.RAILWAY_DEPLOYMENT_ID?.trim() ||
    process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    process.env.npm_package_version?.trim() ||
    'unknown'
  );
}

function resolveMachineStatus(conditions: Array<boolean>): DiagnosticStatus {
  return conditions.every(Boolean) ? 'live' : conditions.some(Boolean) ? 'degraded' : 'offline';
}

/**
 * Build the canonical session-system diagnostic snapshot.
 *
 * Purpose:
 * - Expose storage, queue, and route-contract facts without narrative diagnostics.
 *
 * Inputs/outputs:
 * - Input: Express app instance.
 * - Output: JSON-safe status snapshot for `/api/diagnostics/session-system`.
 *
 * Edge case behavior:
 * - Degrades to `offline` when both storage and DB connectivity are unavailable.
 */
export async function getSessionSystemDiagnostics(app: Application): Promise<{
  status: DiagnosticStatus;
  storage: 'postgres';
  routes: string[];
  queueConnected: boolean;
  buildId: string;
  timestamp: string;
}> {
  const [storageMetrics, queueSummary] = await Promise.all([
    getSessionStorageMetrics(),
    getJobQueueSummary()
  ]);
  const routes = getCanonicalPublicRouteTable(app);
  const queueConnected = Boolean(queueSummary);

  return {
    status: resolveMachineStatus([
      storageMetrics.databaseConnected,
      routes.length > 0,
      queueConnected
    ]),
    storage: 'postgres',
    routes,
    queueConnected,
    buildId: resolveBuildIdentifier(),
    timestamp: new Date().toISOString()
  };
}

/**
 * Build queue diagnostics for the canonical session system.
 *
 * Purpose:
 * - Surface worker state and last-job facts in machine-verifiable JSON.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: queue health snapshot for `/api/diagnostics/queues`.
 *
 * Edge case behavior:
 * - Returns zeroed counters and `null` job fields when the queue database is unavailable.
 */
export async function getQueueDiagnostics(): Promise<{
  status: DiagnosticStatus;
  workerRunning: boolean;
  queueDepth: number;
  failureRate: number;
  historicalFailureRate: number;
  failureRateWindowMs: number;
  windowCompletedJobs: number;
  windowFailedJobs: number;
  windowTerminalJobs: number;
  failureBreakdown: JobFailureBreakdown;
  recentFailureReasons: JobFailureReasonSummary[];
  lastJobId: string | null;
  lastJobStatus: string | null;
  lastJobFinishedAt: string | null;
  timestamp: string;
}> {
  const [queueSummary, latestJob] = await Promise.all([
    getJobQueueSummary(),
    getLatestJob()
  ]);

  const workerRunning = Boolean(queueSummary);
  const queueDepth = queueSummary ? queueSummary.pending + queueSummary.running + queueSummary.delayed : 0;
  const totalTerminalJobs = (queueSummary?.completed ?? 0) + (queueSummary?.failed ?? 0);
  const windowCompletedJobs = queueSummary?.recentCompleted ?? 0;
  const windowFailedJobs = queueSummary?.recentFailed ?? 0;
  const windowTerminalJobs = queueSummary?.recentTotalTerminal ?? (windowCompletedJobs + windowFailedJobs);
  const failureRateWindowMs = queueSummary?.recentTerminalWindowMs ?? 0;
  const failureRate =
    windowTerminalJobs > 0
      ? Number((windowFailedJobs / windowTerminalJobs).toFixed(4))
      : 0;
  const historicalFailureRate =
    totalTerminalJobs > 0
      ? Number(((queueSummary?.failed ?? 0) / totalTerminalJobs).toFixed(4))
      : 0;
  const finishedAt =
    latestJob && typeof latestJob.completed_at !== 'undefined' && latestJob.completed_at !== null
      ? new Date(String(latestJob.completed_at)).toISOString()
      : null;
  const queueHealthy =
    workerRunning &&
    (queueSummary?.stalledRunning ?? 0) === 0 &&
    failureRate < 0.05;

  return {
    status: resolveMachineStatus([queueHealthy, workerRunning]),
    workerRunning,
    queueDepth,
    failureRate,
    historicalFailureRate,
    failureRateWindowMs,
    windowCompletedJobs,
    windowFailedJobs,
    windowTerminalJobs,
    failureBreakdown: queueSummary?.failureBreakdown ?? {
      retryable: 0,
      permanent: 0,
      retryScheduled: 0,
      retryExhausted: 0,
      authentication: 0,
      network: 0,
      provider: 0,
      rateLimited: 0,
      timeout: 0,
      validation: 0,
      unknown: 0
    },
    recentFailureReasons: queueSummary?.recentFailureReasons ?? [],
    lastJobId: latestJob?.id ?? null,
    lastJobStatus: latestJob?.status ?? null,
    lastJobFinishedAt: finishedAt,
    timestamp: new Date().toISOString()
  };
}

/**
 * Build storage diagnostics for the canonical session system.
 *
 * Purpose:
 * - Expose direct PostgreSQL-backed session/version counts and connectivity state.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: storage snapshot for `/api/diagnostics/storage`.
 *
 * Edge case behavior:
 * - Returns `offline` when the repository cannot reach PostgreSQL.
 */
export async function getStorageDiagnostics(): Promise<{
  status: DiagnosticStatus;
  storage: 'postgres';
  databaseConnected: boolean;
  sessionCount: number;
  sessionVersionCount: number;
  buildId: string;
  timestamp: string;
}> {
  const [storageMetrics] = await Promise.all([getSessionStorageMetrics()]);
  const databaseStatus = getDatabaseStatus();

  return {
    status: resolveMachineStatus([storageMetrics.databaseConnected]),
    storage: 'postgres',
    databaseConnected: databaseStatus.connected && storageMetrics.databaseConnected,
    sessionCount: storageMetrics.sessionCount,
    sessionVersionCount: storageMetrics.versionCount,
    buildId: resolveBuildIdentifier(),
    timestamp: storageMetrics.timestamp
  };
}

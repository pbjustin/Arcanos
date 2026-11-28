import { getJobQueueSummary, type JobQueueSummary } from '@core/db/repositories/jobRepository.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { getWorkerAutonomyHealthReport } from '@services/workerAutonomyService.js';

export type CoreDiagnosticArea = 'runtime' | 'workers' | 'queue' | 'overview';

function projectQueue(summary: JobQueueSummary | null) {
  if (!summary) return { status: 'unavailable' } as const;
  return {
    status: 'available',
    pending: summary.pending,
    running: summary.running,
    completed: summary.completed,
    retainedFailed: summary.failed,
    delayed: summary.delayed,
    stalledRunning: summary.stalledRunning,
    oldestPendingAgeMs: summary.oldestPendingJobAgeMs
  } as const;
}

function readRuntime() {
  const { status, uptime } = runtimeDiagnosticsService.getHealthSnapshot();
  return { status, uptimeSeconds: uptime };
}

/** Project aggregate operational health at the private Core MCP boundary. */
export async function inspectChatGptCoreDiagnostics(area: CoreDiagnosticArea) {
  if (area === 'runtime') return { area, runtime: readRuntime() };
  if (area === 'queue') return { area, queue: projectQueue(await getJobQueueSummary()) };

  const report = await getWorkerAutonomyHealthReport();
  const workers = {
    status: report.overallStatus,
    observed: report.workers.length
  };
  if (area === 'workers') return { area, workers };
  return { area, runtime: readRuntime(), workers, queue: projectQueue(report.queueSummary) };
}

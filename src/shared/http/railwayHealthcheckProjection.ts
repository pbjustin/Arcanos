import type { HealthCheckReport } from '@platform/logging/diagnostics.js';

export const RAILWAY_HEALTHCHECK_UNAVAILABLE_CODE =
  'RAILWAY_HEALTHCHECK_UNAVAILABLE';
export const RAILWAY_HEALTHCHECK_UNAVAILABLE_MESSAGE =
  'Railway healthcheck unavailable.';

export interface PublicRailwayHealthcheckPayload {
  status: HealthCheckReport['status'];
  code: 'RAILWAY_HEALTHCHECK_OK' | 'RAILWAY_HEALTHCHECK_DEGRADED';
  components: {
    workers: {
      expected: boolean;
      directoryExists: boolean;
      healthy: boolean;
      fileCount: number;
    };
    memory: {
      heapMB: string;
      rssMB: string;
      externalMB: string;
      arrayBuffersMB: string;
    };
  };
  summary: 'Railway healthcheck is healthy.' | 'Railway healthcheck is degraded.';
}

function projectMegabytes(value: string): string {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? numericValue.toFixed(2)
    : '0.00';
}

/**
 * Project the internal diagnostics report to the credential-free Railway
 * compatibility surface. Free-form reasons, paths, and filenames stay
 * server-side.
 */
export function projectPublicRailwayHealthcheck(
  report: HealthCheckReport,
): PublicRailwayHealthcheckPayload {
  const healthy = report.status === 'ok';
  return {
    status: healthy ? 'ok' : 'degraded',
    code: healthy ? 'RAILWAY_HEALTHCHECK_OK' : 'RAILWAY_HEALTHCHECK_DEGRADED',
    components: {
      workers: {
        expected: report.components.workers.expected,
        directoryExists: report.components.workers.directoryExists,
        healthy: report.components.workers.healthy,
        fileCount: report.components.workers.files.length,
      },
      memory: {
        heapMB: projectMegabytes(report.components.memory.heapMB),
        rssMB: projectMegabytes(report.components.memory.rssMB),
        externalMB: projectMegabytes(report.components.memory.externalMB),
        arrayBuffersMB: projectMegabytes(report.components.memory.arrayBuffersMB),
      },
    },
    summary: healthy
      ? 'Railway healthcheck is healthy.'
      : 'Railway healthcheck is degraded.',
  };
}

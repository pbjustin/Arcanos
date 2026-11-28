import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getJobQueueSummary = jest.fn<() => Promise<unknown>>();
const getWorkerAutonomyHealthReport = jest.fn<() => Promise<unknown>>();
const getHealthSnapshot = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({ getJobQueueSummary }));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({ getWorkerAutonomyHealthReport }));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: { getHealthSnapshot }
}));

const { inspectChatGptCoreDiagnostics } = await import('../src/services/chatgptCoreDiagnostics.js');

describe('Core MCP operational diagnostics', () => {
  const privateValue = 'synthetic-internal-detail';
  const queue = {
    pending: 4, running: 2, completed: 12, failed: 3, delayed: 1, stalledRunning: 1,
    oldestPendingJobAgeMs: 1500, recentFailureReasons: [{ reason: privateValue }]
  };

  beforeEach(() => {
    getJobQueueSummary.mockReset().mockResolvedValue(queue);
    getWorkerAutonomyHealthReport.mockReset().mockResolvedValue({
      overallStatus: 'degraded', queueSummary: queue,
      workers: [{ workerId: privateValue, currentJobId: privateValue }], alerts: [privateValue]
    });
    getHealthSnapshot.mockReset().mockReturnValue({ status: 'ok', uptime: 30, memory: privateValue });
  });

  it('returns only aggregate fields and reuses the observed queue in an overview', async () => {
    const result = await inspectChatGptCoreDiagnostics('overview');
    expect(result).toEqual({
      area: 'overview',
      runtime: { status: 'ok', uptimeSeconds: 30 },
      workers: { status: 'degraded', observed: 1 },
      queue: {
        status: 'available', pending: 4, running: 2, completed: 12, retainedFailed: 3, delayed: 1,
        stalledRunning: 1, oldestPendingAgeMs: 1500
      }
    });
    expect(getJobQueueSummary).not.toHaveBeenCalled();
  });

  it('runs only the requested read and distinguishes lost queue access from an empty queue', async () => {
    getJobQueueSummary.mockResolvedValueOnce(null);
    await expect(inspectChatGptCoreDiagnostics('queue')).resolves.toEqual({
      area: 'queue', queue: { status: 'unavailable' }
    });
    expect(getWorkerAutonomyHealthReport).not.toHaveBeenCalled();
    expect(getHealthSnapshot).not.toHaveBeenCalled();

    await expect(inspectChatGptCoreDiagnostics('workers')).resolves.toEqual({
      area: 'workers', workers: { status: 'degraded', observed: 1 }
    });
    expect(getJobQueueSummary).toHaveBeenCalledTimes(1);
    expect(getHealthSnapshot).not.toHaveBeenCalled();

    await expect(inspectChatGptCoreDiagnostics('runtime')).resolves.toEqual({
      area: 'runtime', runtime: { status: 'ok', uptimeSeconds: 30 }
    });
    expect(getWorkerAutonomyHealthReport).toHaveBeenCalledTimes(1);
  });
});

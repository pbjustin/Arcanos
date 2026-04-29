import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const getJobByIdMock = jest.fn();
const recordJobHeartbeatMock = jest.fn();
const updateJobMock = jest.fn();
const routeGptRequestMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
const noopStructuredLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => noopStructuredLogger)
};
const recordGptJobEventMock = jest.fn();
const recordGptJobTimingMock = jest.fn();

jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({
  getJobById: getJobByIdMock,
  recordJobHeartbeat: recordJobHeartbeatMock,
  updateJob: updateJobMock
}));

jest.unstable_mockModule('@routes/_core/gptDispatch.js', () => ({
  routeGptRequest: routeGptRequestMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    })),
    warn: loggerWarnMock,
    error: loggerErrorMock
  },
  aiLogger: noopStructuredLogger
}));

jest.unstable_mockModule('@platform/observability/appMetrics.js', () => ({
  recordGptJobEvent: recordGptJobEventMock,
  recordGptJobTiming: recordGptJobTimingMock
}));

const {
  startReservedPriorityGptDirectExecution
} = await import('../src/services/priorityGptDirectExecutionService.js');

function createJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-priority-direct-cancel',
    job_type: 'gpt',
    status: 'running',
    input: {},
    output: null,
    error_message: null,
    cancel_requested_at: null,
    cancel_reason: null,
    ...overrides
  };
}

async function waitForMockCall(
  predicate: () => boolean,
  label: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  }

  throw new Error(`Timed out waiting for ${label}`);
}

describe('priorityGptDirectExecutionService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    getJobByIdMock.mockReset();
    recordJobHeartbeatMock.mockReset();
    updateJobMock.mockReset();
    routeGptRequestMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    recordGptJobEventMock.mockReset();
    recordGptJobTimingMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('cancels a running priority direct GPT job from heartbeat without completing it', async () => {
    const slot = { release: jest.fn() };
    getJobByIdMock.mockResolvedValue(createJob());
    recordJobHeartbeatMock.mockResolvedValue(
      createJob({
        cancel_requested_at: new Date('2026-04-29T10:00:00.000Z'),
        cancel_reason: 'Stop priority direct job'
      })
    );
    updateJobMock.mockResolvedValue(createJob({ status: 'cancelled' }));
    routeGptRequestMock.mockImplementation((input: { parentAbortSignal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        input.parentAbortSignal?.addEventListener(
          'abort',
          () => reject(input.parentAbortSignal?.reason ?? new Error('aborted')),
          { once: true }
        );
      });
    });

    startReservedPriorityGptDirectExecution({
      jobId: 'job-priority-direct-cancel',
      workerId: 'api-priority-worker',
      rawInput: {
        gptId: 'arcanos-build',
        body: { prompt: 'Keep working until cancelled.' },
        requestId: 'req-priority-direct-cancel'
      },
      slot
    });

    await waitForMockCall(
      () => routeGptRequestMock.mock.calls.length === 1,
      'priority direct route start'
    );

    expect(routeGptRequestMock.mock.calls[0]?.[0]).toMatchObject({
      runtimeExecutionMode: 'background'
    });
    expect(routeGptRequestMock.mock.calls[0]?.[0]?.parentAbortSignal).toBeDefined();

    await jest.advanceTimersByTimeAsync(5_000);
    await waitForMockCall(
      () => updateJobMock.mock.calls.some((call) => call[1] === 'cancelled'),
      'priority direct cancellation update'
    );

    const statuses = updateJobMock.mock.calls.map((call) => call[1]);
    expect(statuses).toContain('cancelled');
    expect(statuses).not.toContain('completed');

    const cancelledCall = updateJobMock.mock.calls.find((call) => call[1] === 'cancelled');
    expect(cancelledCall?.[2]).toBeNull();
    expect(cancelledCall?.[3]).toBe('Stop priority direct job');
    expect(cancelledCall?.[5]).toMatchObject({
      cancelReason: 'Stop priority direct job'
    });
    expect(slot.release).toHaveBeenCalledTimes(1);
    expect(recordGptJobEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'completed' })
    );
  });
});

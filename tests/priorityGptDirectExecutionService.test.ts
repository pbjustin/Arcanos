import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const recordJobHeartbeatMock = jest.fn();
const updateClaimedJobTerminalMock = jest.fn();
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
  createClaimedJobFence: (workerId: string, claimGeneration: string) => {
    if (!/^(0|[1-9]\d*)$/u.test(claimGeneration)) {
      throw new TypeError('invalid claim generation');
    }
    return {
      workerId,
      claimGeneration
    };
  },
  recordJobHeartbeat: recordJobHeartbeatMock,
  updateClaimedJobTerminal: updateClaimedJobTerminalMock
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
  recordAiBudgetExceeded: jest.fn(),
  recordAiOperation: jest.fn(),
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
    claim_generation: '1',
    input: {},
    output: null,
    error_message: null,
    cancel_requested_at: null,
    cancel_reason: null,
    ...overrides
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });

  return {
    promise,
    resolve: resolveDeferred
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
    recordJobHeartbeatMock.mockReset();
    recordJobHeartbeatMock.mockResolvedValue(createJob());
    updateClaimedJobTerminalMock.mockReset();
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
    recordJobHeartbeatMock
      .mockResolvedValueOnce(createJob())
      .mockResolvedValueOnce(
        createJob({
          cancel_requested_at: new Date('2026-04-29T10:00:00.000Z'),
          cancel_reason: 'Stop priority direct job'
        })
      );
    updateClaimedJobTerminalMock.mockResolvedValue(createJob({ status: 'cancelled' }));
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
      claimGeneration: '1',
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
      () => updateClaimedJobTerminalMock.mock.calls.some((call) => call[1] === 'cancelled'),
      'priority direct cancellation update'
    );

    const statuses = updateClaimedJobTerminalMock.mock.calls.map((call) => call[1]);
    expect(statuses).toContain('cancelled');
    expect(statuses).not.toContain('completed');

    const cancelledCall = updateClaimedJobTerminalMock.mock.calls.find(
      (call) => call[1] === 'cancelled'
    );
    expect(cancelledCall?.[2]).toMatchObject({
      fence: {
        workerId: 'api-priority-worker',
        claimGeneration: '1'
      },
      output: null,
      errorMessage: 'Stop priority direct job',
      metadata: {
        cancelReason: 'Stop priority direct job'
      }
    });
    expect(slot.release).toHaveBeenCalledTimes(1);
    expect(recordGptJobEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'completed' })
    );
  });

  it('does not start provider execution when the preflight heartbeat loses the job lease', async () => {
    const slot = { release: jest.fn() };
    recordJobHeartbeatMock.mockResolvedValue(null);

    startReservedPriorityGptDirectExecution({
      jobId: 'job-priority-direct-lease-lost',
      claimGeneration: '1',
      workerId: 'api-priority-worker',
      rawInput: {
        gptId: 'arcanos-build',
        body: { prompt: 'Keep working until lease is lost.' },
        requestId: 'req-priority-direct-lease-lost'
      },
      slot
    });

    await waitForMockCall(
      () => slot.release.mock.calls.length === 1,
      'priority direct preflight lease-loss stop'
    );

    expect(recordJobHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(recordJobHeartbeatMock).toHaveBeenCalledWith(
      'job-priority-direct-lease-lost',
      {
        fence: {
          workerId: 'api-priority-worker',
          claimGeneration: '1'
        },
        leaseMs: expect.any(Number)
      }
    );
    expect(routeGptRequestMock).not.toHaveBeenCalled();
    expect(updateClaimedJobTerminalMock).not.toHaveBeenCalled();
    expect(recordGptJobEventMock).not.toHaveBeenCalled();
    expect(recordGptJobTimingMock).not.toHaveBeenCalled();
    expect(slot.release).toHaveBeenCalledTimes(1);
  });

  it('does not record completion metrics when the terminal fence is lost', async () => {
    const slot = { release: jest.fn() };
    routeGptRequestMock.mockResolvedValue({
      ok: true,
      result: { text: 'done' }
    });
    updateClaimedJobTerminalMock.mockResolvedValue(null);

    startReservedPriorityGptDirectExecution({
      jobId: 'job-priority-direct-terminal-fence',
      claimGeneration: '1',
      workerId: 'api-priority-worker',
      rawInput: {
        gptId: 'arcanos-build',
        body: { prompt: 'Complete only with the live fence.' },
        requestId: 'req-priority-direct-terminal-fence'
      },
      slot
    });

    await waitForMockCall(
      () => slot.release.mock.calls.length === 1,
      'priority direct terminal fence loss'
    );

    expect(updateClaimedJobTerminalMock).toHaveBeenCalledWith(
      'job-priority-direct-terminal-fence',
      'completed',
      expect.objectContaining({
        fence: {
          workerId: 'api-priority-worker',
          claimGeneration: '1'
        }
      })
    );
    expect(recordGptJobEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'completed' })
    );
    expect(recordGptJobTimingMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' })
    );
  });

  it('releases the reserved slot when the supplied generation is invalid', async () => {
    const slot = { release: jest.fn() };

    startReservedPriorityGptDirectExecution({
      jobId: 'job-priority-direct-invalid-fence',
      claimGeneration: '-1',
      workerId: 'api-priority-worker',
      rawInput: {
        gptId: 'arcanos-build',
        body: { prompt: 'Do not start with an invalid fence.' }
      },
      slot
    });

    await waitForMockCall(
      () => loggerErrorMock.mock.calls.length === 1,
      'invalid priority direct fence rejection'
    );

    expect(slot.release).toHaveBeenCalledTimes(1);
    expect(routeGptRequestMock).not.toHaveBeenCalled();
    expect(recordJobHeartbeatMock).not.toHaveBeenCalled();
    expect(updateClaimedJobTerminalMock).not.toHaveBeenCalled();
  });

  it('releases the reserved slot when queued-input parsing throws', async () => {
    const slot = { release: jest.fn() };
    const rawInput = new Proxy(
      {},
      {
        get: () => {
          throw new Error('input getter failed');
        }
      }
    );

    startReservedPriorityGptDirectExecution({
      jobId: 'job-priority-direct-input-throw',
      claimGeneration: '1',
      workerId: 'api-priority-worker',
      rawInput,
      slot
    });

    await waitForMockCall(
      () => slot.release.mock.calls.length === 1,
      'priority direct parsing failure release'
    );

    expect(slot.release).toHaveBeenCalledTimes(1);
    expect(routeGptRequestMock).not.toHaveBeenCalled();
  });

  it('does not start overlapping priority direct heartbeat requests', async () => {
    const slot = { release: jest.fn() };
    const firstHeartbeat = createDeferred<Record<string, unknown> | null>();
    recordJobHeartbeatMock
      .mockResolvedValueOnce(createJob())
      .mockReturnValueOnce(firstHeartbeat.promise)
      .mockResolvedValueOnce(
        createJob({
          cancel_requested_at: new Date('2026-04-29T10:00:00.000Z'),
          cancel_reason: 'Stop after serialized heartbeat'
        })
      );
    updateClaimedJobTerminalMock.mockResolvedValue(createJob({ status: 'cancelled' }));
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
      jobId: 'job-priority-direct-serialized-heartbeat',
      claimGeneration: '1',
      workerId: 'api-priority-worker',
      rawInput: {
        gptId: 'arcanos-build',
        body: { prompt: 'Keep working while heartbeat is slow.' },
        requestId: 'req-priority-direct-serialized-heartbeat'
      },
      slot
    });

    await waitForMockCall(
      () => routeGptRequestMock.mock.calls.length === 1,
      'priority direct route start'
    );
    expect(recordJobHeartbeatMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(recordJobHeartbeatMock).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(15_000);
    expect(recordJobHeartbeatMock).toHaveBeenCalledTimes(2);

    firstHeartbeat.resolve(createJob());
    await jest.advanceTimersByTimeAsync(0);
    expect(recordJobHeartbeatMock).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(4_999);
    expect(recordJobHeartbeatMock).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1);
    await waitForMockCall(
      () => updateClaimedJobTerminalMock.mock.calls.some((call) => call[1] === 'cancelled'),
      'priority direct serialized heartbeat cancellation'
    );

    expect(recordJobHeartbeatMock).toHaveBeenCalledTimes(3);
    expect(slot.release).toHaveBeenCalledTimes(1);
  });
});

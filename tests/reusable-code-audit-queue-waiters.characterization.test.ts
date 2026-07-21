import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';
import {
  resolveAsyncAskPollIntervalMs,
  resolveAsyncAskWaitForResultMs,
  waitForQueuedAskJobCompletion
} from '../src/services/queuedAskCompletionService.js';
import {
  resolveAsyncGptPollIntervalMs,
  resolveAsyncGptWaitForResultMs,
  waitForQueuedGptJobCompletion
} from '../src/services/queuedGptCompletionService.js';

interface WaitOptions {
  waitForResultMs?: number;
  pollIntervalMs?: number;
}

interface WaitDependencies {
  getJobByIdFn?: (jobId: string) => Promise<JobData | null>;
  sleepFn?: (milliseconds: number) => Promise<void>;
  nowFn?: () => number;
}

interface CharacterizedCompletion {
  state: string;
  job: JobData | null;
}

interface WaiterDescriptor {
  name: 'Ask' | 'GPT';
  wait: (
    jobId: string,
    options?: WaitOptions,
    dependencies?: WaitDependencies
  ) => Promise<CharacterizedCompletion>;
  resolveWait: (requestedWaitMs: number | undefined, env?: NodeJS.ProcessEnv) => number;
  resolvePoll: (
    requestedPollIntervalMs: number | undefined,
    env?: NodeJS.ProcessEnv
  ) => number;
  waitEnvName: 'ASK_ASYNC_WAIT_FOR_RESULT_MS' | 'GPT_ASYNC_WAIT_FOR_RESULT_MS';
  pollEnvName: 'ASK_ASYNC_WAIT_POLL_MS' | 'GPT_ASYNC_WAIT_POLL_MS';
  defaultWaitMs: number;
}

const WAITERS: readonly WaiterDescriptor[] = [
  {
    name: 'Ask',
    wait: waitForQueuedAskJobCompletion,
    resolveWait: resolveAsyncAskWaitForResultMs,
    resolvePoll: resolveAsyncAskPollIntervalMs,
    waitEnvName: 'ASK_ASYNC_WAIT_FOR_RESULT_MS',
    pollEnvName: 'ASK_ASYNC_WAIT_POLL_MS',
    defaultWaitMs: 15_000
  },
  {
    name: 'GPT',
    wait: waitForQueuedGptJobCompletion,
    resolveWait: resolveAsyncGptWaitForResultMs,
    resolvePoll: resolveAsyncGptPollIntervalMs,
    waitEnvName: 'GPT_ASYNC_WAIT_FOR_RESULT_MS',
    pollEnvName: 'GPT_ASYNC_WAIT_POLL_MS',
    defaultWaitMs: 3_500
  }
];

const ENV_NAMES = [
  'ASK_ASYNC_WAIT_FOR_RESULT_MS',
  'ASK_ASYNC_WAIT_POLL_MS',
  'GPT_ASYNC_WAIT_FOR_RESULT_MS',
  'GPT_ASYNC_WAIT_POLL_MS'
] as const;

const originalEnvironment = new Map(
  ENV_NAMES.map((name) => [name, process.env[name]] as const)
);

function restoreEnvironment(): void {
  for (const name of ENV_NAMES) {
    const originalValue = originalEnvironment.get(name);
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
}

function createJob(status: unknown, partial: Partial<JobData> = {}): JobData {
  return {
    id: 'queue-audit-job-001',
    worker_id: 'queue-audit-worker',
    job_type: 'audit',
    status,
    input: Object.freeze({ prompt: 'characterize current behavior' }),
    output: null,
    error_message: undefined,
    retry_count: 0,
    max_retries: 2,
    next_run_at: new Date('2026-07-16T12:00:00.000Z'),
    started_at: undefined,
    completed_at: undefined,
    last_heartbeat_at: undefined,
    lease_expires_at: undefined,
    created_at: new Date('2026-07-16T12:00:00.000Z'),
    updated_at: new Date('2026-07-16T12:00:00.000Z'),
    priority: 100,
    last_worker_id: null,
    autonomy_state: Object.freeze({ source: 'reusable-code-audit' }),
    ...partial
  } as JobData;
}

function immediateObservationClock(): jest.Mock<() => number> {
  return jest
    .fn<() => number>()
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValue(1);
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

afterEach(() => {
  restoreEnvironment();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe.each(WAITERS)('$name queue waiter resolver characterization', (waiter) => {
  it('preserves zero, truncates fractions, clamps the maximum, and falls back on invalid waits', () => {
    const configuredEnvironment = {
      [waiter.waitEnvName]: '12000'
    } as NodeJS.ProcessEnv;

    expect(waiter.resolveWait(0, configuredEnvironment)).toBe(0);
    expect(waiter.resolveWait(49.9, configuredEnvironment)).toBe(49);
    expect(waiter.resolveWait(45_000, configuredEnvironment)).toBe(30_000);
    expect(waiter.resolveWait(-1, configuredEnvironment)).toBe(12_000);
    expect(waiter.resolveWait(Number.NaN, configuredEnvironment)).toBe(12_000);
    expect(waiter.resolveWait(Number.POSITIVE_INFINITY, configuredEnvironment)).toBe(12_000);
    expect(waiter.resolveWait(undefined, configuredEnvironment)).toBe(12_000);
    expect(waiter.resolveWait(undefined, {} as NodeJS.ProcessEnv)).toBe(
      waiter.defaultWaitMs
    );
  });

  it('characterizes environment wait defaults of zero and over the maximum', () => {
    expect(
      waiter.resolveWait(undefined, {
        [waiter.waitEnvName]: '0'
      } as NodeJS.ProcessEnv)
    ).toBe(0);
    expect(
      waiter.resolveWait(undefined, {
        [waiter.waitEnvName]: '45000'
      } as NodeJS.ProcessEnv)
    ).toBe(30_000);
  });

  it('clamps valid poll requests and truncates fractional requests', () => {
    expect(waiter.resolvePoll(1, {} as NodeJS.ProcessEnv)).toBe(50);
    expect(waiter.resolvePoll(50.9, {} as NodeJS.ProcessEnv)).toBe(50);
    expect(waiter.resolvePoll(5_000, {} as NodeJS.ProcessEnv)).toBe(1_000);
  });

  it('preserves the current un-clamped environment fallback for invalid poll requests', () => {
    expect(
      waiter.resolvePoll(0, {
        [waiter.pollEnvName]: '1'
      } as NodeJS.ProcessEnv)
    ).toBe(1);
    expect(
      waiter.resolvePoll(-1, {
        [waiter.pollEnvName]: '5000'
      } as NodeJS.ProcessEnv)
    ).toBe(5_000);
    expect(
      waiter.resolvePoll(Number.NaN, {
        [waiter.pollEnvName]: '0'
      } as NodeJS.ProcessEnv)
    ).toBe(0);
    expect(
      waiter.resolvePoll(undefined, {
        [waiter.pollEnvName]: '0'
      } as NodeJS.ProcessEnv)
    ).toBe(0);
  });
});

describe('Ask and GPT terminal-state characterization matrix', () => {
  const CASES: ReadonlyArray<{
    status: unknown;
    askState: string;
    gptState: string;
  }> = [
    { status: 'completed', askState: 'completed', gptState: 'completed' },
    { status: 'failed', askState: 'failed', gptState: 'failed' },
    { status: 'cancelled', askState: 'failed', gptState: 'cancelled' },
    { status: 'expired', askState: 'pending', gptState: 'expired' },
    { status: 'pending', askState: 'pending', gptState: 'pending' },
    { status: 'running', askState: 'pending', gptState: 'pending' },
    { status: 'queued', askState: 'pending', gptState: 'pending' },
    { status: 'not_found', askState: 'pending', gptState: 'pending' },
    { status: 'unknown-provider-state', askState: 'pending', gptState: 'pending' },
    { status: undefined, askState: 'pending', gptState: 'pending' },
    { status: null, askState: 'pending', gptState: 'pending' }
  ];

  it.each(CASES)(
    'maps stored status $status without forcing Ask and GPT to agree',
    async ({ status, askState, gptState }) => {
      const job = createJob(status);
      const askGetJob = jest
        .fn<(jobId: string) => Promise<JobData | null>>()
        .mockResolvedValue(job);
      const gptGetJob = jest
        .fn<(jobId: string) => Promise<JobData | null>>()
        .mockResolvedValue(job);

      const [askResult, gptResult] = await Promise.all([
        waitForQueuedAskJobCompletion(
          'queue-audit-state-ask',
          { waitForResultMs: 1, pollIntervalMs: 50 },
          {
            getJobByIdFn: askGetJob,
            sleepFn: async () => undefined,
            nowFn: immediateObservationClock()
          }
        ),
        waitForQueuedGptJobCompletion(
          'queue-audit-state-gpt',
          { waitForResultMs: 1, pollIntervalMs: 50 },
          {
            getJobByIdFn: gptGetJob,
            sleepFn: async () => undefined,
            nowFn: immediateObservationClock()
          }
        )
      ]);

      expect(askResult).toEqual({ state: askState, job });
      expect(gptResult).toEqual({ state: gptState, job });
    }
  );

  it.each(WAITERS)('$name maps a null repository read to missing', async (waiter) => {
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(null);

    await expect(
      waiter.wait(
        `queue-audit-missing-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 1 },
        {
          getJobByIdFn,
          sleepFn: async () => undefined,
          nowFn: () => 0
        }
      )
    ).resolves.toEqual({ state: 'missing', job: null });
    expect(getJobByIdFn).toHaveBeenCalledTimes(1);
  });
});

describe.each(WAITERS)('$name queue polling characterization', (waiter) => {
  it('performs no clock, repository, or sleeper work when wait is explicitly zero', async () => {
    const getJobByIdFn = jest.fn<(jobId: string) => Promise<JobData | null>>();
    const sleepFn = jest.fn<(milliseconds: number) => Promise<void>>();
    const nowFn = jest.fn<() => number>();

    await expect(
      waiter.wait(
        `queue-audit-zero-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 0 },
        { getJobByIdFn, sleepFn, nowFn }
      )
    ).resolves.toEqual({ state: 'pending', job: null });
    expect(nowFn).not.toHaveBeenCalled();
    expect(getJobByIdFn).not.toHaveBeenCalled();
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('polls immediately, sleeps only for the remaining budget, and polls at the exact deadline', async () => {
    let nowMs = 0;
    const pendingJob = createJob('running');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(pendingJob);
    const sleepDurations: number[] = [];
    const sleepFn = jest.fn(async (milliseconds: number) => {
      sleepDurations.push(milliseconds);
      nowMs += milliseconds;
    });

    const result = await waiter.wait(
      `queue-audit-schedule-${waiter.name.toLowerCase()}`,
      { waitForResultMs: 120, pollIntervalMs: 50 },
      { getJobByIdFn, sleepFn, nowFn: () => nowMs }
    );

    expect(result).toEqual({ state: 'pending', job: pendingJob });
    expect(sleepDurations).toEqual([50, 50, 20]);
    expect(getJobByIdFn).toHaveBeenCalledTimes(4);
    expect(sleepFn).toHaveBeenCalledTimes(3);
  });

  it('characterizes the maximum nominal poll count after wait and poll clamping', async () => {
    let nowMs = 0;
    const pendingJob = createJob('running');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(pendingJob);
    const sleepFn = jest.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });

    const result = await waiter.wait(
      `queue-audit-max-polls-${waiter.name.toLowerCase()}`,
      { waitForResultMs: 45_000, pollIntervalMs: 1 },
      { getJobByIdFn, sleepFn, nowFn: () => nowMs }
    );

    expect(result).toEqual({ state: 'pending', job: pendingJob });
    expect(getJobByIdFn).toHaveBeenCalledTimes(601);
    expect(sleepFn).toHaveBeenCalledTimes(600);
    expect(nowMs).toBe(30_000);
  });

  it('still performs one final repository observation when the clock moves past the deadline before the loop', async () => {
    const pendingJob = createJob('pending');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(pendingJob);
    const sleepFn = jest.fn<(milliseconds: number) => Promise<void>>();
    const nowFn = jest
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValue(101);

    await expect(
      waiter.wait(
        `queue-audit-before-first-poll-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 100, pollIntervalMs: 50 },
        { getJobByIdFn, sleepFn, nowFn }
      )
    ).resolves.toEqual({ state: 'pending', job: pendingJob });
    expect(getJobByIdFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('returns the current snapshot when the clock jumps past the deadline during repository access', async () => {
    let nowMs = 0;
    const pendingJob = createJob('running');
    const getJobByIdFn = jest.fn(async () => {
      nowMs = 200;
      return pendingJob;
    });
    const sleepFn = jest.fn<(milliseconds: number) => Promise<void>>();

    await expect(
      waiter.wait(
        `queue-audit-forward-clock-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 100, pollIntervalMs: 50 },
        { getJobByIdFn, sleepFn, nowFn: () => nowMs }
      )
    ).resolves.toEqual({ state: 'pending', job: pendingJob });
    expect(getJobByIdFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('allows backward clock movement to add polls because there is no independent iteration cap', async () => {
    const pendingJob = createJob('running');
    const completedJob = createJob('completed');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValueOnce(pendingJob)
      .mockResolvedValueOnce(pendingJob)
      .mockResolvedValueOnce(pendingJob)
      .mockResolvedValueOnce(completedJob);
    const sleepFn = jest.fn(async () => undefined);
    const clockValues = [100, 100, 0, 0, 0, 0, 0, 200];
    const nowFn = jest.fn(() => clockValues.shift() ?? 200);

    await expect(
      waiter.wait(
        `queue-audit-backward-clock-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 100, pollIntervalMs: 50 },
        { getJobByIdFn, sleepFn, nowFn }
      )
    ).resolves.toEqual({ state: 'completed', job: completedJob });
    expect(getJobByIdFn).toHaveBeenCalledTimes(4);
    expect(sleepFn).toHaveBeenCalledTimes(3);
  });

  it('stops immediately after observing a terminal state', async () => {
    const completedJob = createJob('completed');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(completedJob);
    const sleepFn = jest.fn<(milliseconds: number) => Promise<void>>();

    await expect(
      waiter.wait(
        `queue-audit-terminal-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 1_000, pollIntervalMs: 50 },
        { getJobByIdFn, sleepFn, nowFn: () => 0 }
      )
    ).resolves.toEqual({ state: 'completed', job: completedJob });
    expect(getJobByIdFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});

describe.each(WAITERS)('$name queue failure and abort characterization', (waiter) => {
  it.each([
    ['repository failure', new Error('queue audit repository failure')],
    ['repository AbortError', createAbortError('queue audit repository aborted')]
  ])('propagates %s unchanged', async (_label, expectedError) => {
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockRejectedValue(expectedError);
    const sleepFn = jest.fn<(milliseconds: number) => Promise<void>>();

    await expect(
      waiter.wait(
        `queue-audit-repository-error-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 100 },
        { getJobByIdFn, sleepFn, nowFn: () => 0 }
      )
    ).rejects.toBe(expectedError);
    expect(getJobByIdFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it.each([
    ['sleeper failure', new Error('queue audit sleeper failure')],
    ['sleeper AbortError', createAbortError('queue audit sleeper aborted')]
  ])('propagates %s unchanged and performs no later poll', async (_label, expectedError) => {
    const pendingJob = createJob('running');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(pendingJob);
    const sleepFn = jest
      .fn<(milliseconds: number) => Promise<void>>()
      .mockRejectedValue(expectedError);

    await expect(
      waiter.wait(
        `queue-audit-sleeper-error-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 100, pollIntervalMs: 50 },
        { getJobByIdFn, sleepFn, nowFn: () => 0 }
      )
    ).rejects.toBe(expectedError);
    expect(getJobByIdFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('propagates a clock failure before repository access', async () => {
    const expectedError = new Error('queue audit clock failure');
    const getJobByIdFn = jest.fn<(jobId: string) => Promise<JobData | null>>();
    const sleepFn = jest.fn<(milliseconds: number) => Promise<void>>();
    const nowFn = jest.fn(() => {
      throw expectedError;
    });

    await expect(
      waiter.wait(
        `queue-audit-clock-error-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 100 },
        { getJobByIdFn, sleepFn, nowFn }
      )
    ).rejects.toBe(expectedError);
    expect(getJobByIdFn).not.toHaveBeenCalled();
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('ignores an extra already-aborted signal because the current dependency contract does not consume it', async () => {
    const controller = new AbortController();
    controller.abort(createAbortError('queue audit external abort'));
    const completedJob = createJob('completed');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(completedJob);
    const dependencies = {
      getJobByIdFn,
      sleepFn: async () => undefined,
      nowFn: () => 0,
      signal: controller.signal
    } as WaitDependencies & { signal: AbortSignal };

    await expect(
      waiter.wait(
        `queue-audit-ignored-signal-${waiter.name.toLowerCase()}`,
        { waitForResultMs: 100 },
        dependencies
      )
    ).resolves.toEqual({ state: 'completed', job: completedJob });
    expect(getJobByIdFn).toHaveBeenCalledTimes(1);
  });
});

describe.each(WAITERS)('$name queue read and data-shape characterization', (waiter) => {
  it('performs independent reads for repeated and concurrent completion requests', async () => {
    const completedJob = createJob('completed');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(completedJob);
    const dependencies = {
      getJobByIdFn,
      sleepFn: async () => undefined,
      nowFn: () => 0
    };

    await waiter.wait(
      `queue-audit-repeat-${waiter.name.toLowerCase()}`,
      { waitForResultMs: 100 },
      dependencies
    );
    await waiter.wait(
      `queue-audit-repeat-${waiter.name.toLowerCase()}`,
      { waitForResultMs: 100 },
      dependencies
    );
    await Promise.all([
      waiter.wait(
        `queue-audit-concurrent-${waiter.name.toLowerCase()}-a`,
        { waitForResultMs: 100 },
        dependencies
      ),
      waiter.wait(
        `queue-audit-concurrent-${waiter.name.toLowerCase()}-b`,
        { waitForResultMs: 100 },
        dependencies
      )
    ]);

    expect(getJobByIdFn).toHaveBeenCalledTimes(4);
  });

  it('returns the same frozen job object without mutation', async () => {
    const job = Object.freeze(createJob('completed'));
    const before = JSON.stringify(job);
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(job);

    const result = await waiter.wait(
      `queue-audit-identity-${waiter.name.toLowerCase()}`,
      { waitForResultMs: 100 },
      {
        getJobByIdFn,
        sleepFn: async () => undefined,
        nowFn: () => 0
      }
    );

    expect(result.job).toBe(job);
    expect(JSON.stringify(job)).toBe(before);
  });

  it.each([undefined, null])(
    'still reports completed when output is %s',
    async (output) => {
      const completedJob = createJob('completed', { output });
      const getJobByIdFn = jest
        .fn<(jobId: string) => Promise<JobData | null>>()
        .mockResolvedValue(completedJob);

      await expect(
        waiter.wait(
          `queue-audit-missing-output-${waiter.name.toLowerCase()}`,
          { waitForResultMs: 100 },
          {
            getJobByIdFn,
            sleepFn: async () => undefined,
            nowFn: () => 0
          }
        )
      ).resolves.toEqual({ state: 'completed', job: completedJob });
    }
  );

  it.each([
    ['empty string', ''],
    ['runtime non-string', 42 as unknown as string]
  ])('forwards an invalid %s job identifier without service-level validation', async (_label, jobId) => {
    const completedJob = createJob('completed');
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValue(completedJob);

    await waiter.wait(
      jobId,
      { waitForResultMs: 100 },
      {
        getJobByIdFn,
        sleepFn: async () => undefined,
        nowFn: () => 0
      }
    );

    expect(getJobByIdFn).toHaveBeenCalledWith(jobId);
  });
});

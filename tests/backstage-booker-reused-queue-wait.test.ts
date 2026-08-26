import { Buffer } from 'node:buffer';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import express from 'express';
import request from 'supertest';

import type { JobData } from '../src/core/db/schema.js';
import { buildAuthenticatedCredentialActorKey } from '../src/platform/runtime/security.js';
import {
  BACKSTAGE_RESULT_POLL_WAIT_MS,
  resolveBackstageExecutionBudgetPolicy,
} from '../src/shared/backstage/backstageExecutionBudget.js';
import {
  protectBackstageQueuedGptJobOutput,
} from '../src/shared/backstage/backstageQueuedJobResultProtection.js';
import {
  buildProtectedBackstageQueuedGptJobInput,
} from '../src/shared/gpt/asyncGptJob.js';
import {
  buildGptIdempotencyScopeHash,
} from '../src/shared/gpt/gptIdempotency.js';
import {
  DEFAULT_ASYNC_GPT_WAIT_POLL_MS,
  DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS,
  MAX_ASYNC_GPT_WAIT_POLLS,
  MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS,
  resolveGptAsyncHeavyWaitForResultMs,
} from '../src/shared/gpt/gptAsyncWaitPolicy.js';
import {
  createBackstageBookerAsyncResultRouter,
  parseBackstageBookerAsyncResultQuery,
  readBackstageBookerAsyncResult,
} from '../src/routes/jobs.js';
import {
  createBackstageBookerHttpBoundary,
} from '../src/services/backstageBookerHttpBoundary.js';
import {
  resolveAsyncGptPollIntervalMs,
  resolveAsyncGptWaitForResultMs,
  waitForQueuedGptJobCompletion,
} from '../src/services/queuedGptCompletionService.js';
import { resolveQueuedJobWaitPollLimit } from '../src/services/queuedJobCompletionPolling.js';

const ACCESS_TOKEN = `backstage-test-${'a'.repeat(64)}`;
const PAYLOAD_KEY = Buffer.alloc(32, 0x42).toString('base64');
const JOB_ID = '77777777-7777-4777-8777-777777777777';
const UNIVERSE_ID = 'my-universe-2k26';
const RESULT_PATH =
  `/gpt-access/capabilities/v1/backstage-booker/jobs/${JOB_ID}/result`;
const ORIGINAL_ACCESS_TOKEN =
  process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN;
const ORIGINAL_PAYLOAD_KEY =
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;

function restoreEnvironmentValue(
  key: string,
  originalValue: string | undefined
): void {
  if (originalValue === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = originalValue;
  }
}

function buildProtectedJob(overrides: Partial<JobData> = {}): JobData {
  const actorKey = buildAuthenticatedCredentialActorKey(
    'backstage-booker-access',
    ACCESS_TOKEN
  );
  const input = buildProtectedBackstageQueuedGptJobInput({
    body: {
      action: 'generateBooking',
      executionMode: 'sync',
      payload: {
        universeId: UNIVERSE_ID,
        prompt: 'Produce one bounded NXT booking segment.',
      },
    },
    prompt: 'Produce one bounded NXT booking segment.',
    action: 'generateBooking',
    universeId: UNIVERSE_ID,
    notionEnrichmentAuthorized: true,
    requestId: 'request-test',
    traceId: 'trace-test',
    correlationId: 'trace-test',
    executionModeReason: 'backstage_notion_authority_context',
  });
  return {
    id: JOB_ID,
    worker_id: 'test-worker',
    job_type: 'gpt',
    status: 'running',
    claim_generation: '1',
    input,
    retry_count: 0,
    max_retries: 1,
    idempotency_scope_hash: buildGptIdempotencyScopeHash({
      surface: 'public-gpt',
      actorKey,
    }),
    created_at: new Date('2026-08-26T00:00:00.000Z'),
    updated_at: new Date('2026-08-26T00:00:01.000Z'),
    ...overrides,
  };
}

function completeProtectedJob(
  runningJob: JobData,
  output: unknown = {
    ok: true,
    result: {
      booking: 'Official protected Backstage Booker result.',
    },
  }
): JobData {
  return {
    ...runningJob,
    status: 'completed',
    output: protectBackstageQueuedGptJobOutput({
      jobId: runningJob.id,
      rawInput: runningJob.input,
      output,
    }),
    completed_at: new Date('2026-08-26T00:00:42.000Z'),
    updated_at: new Date('2026-08-26T00:00:42.000Z'),
  };
}

function buildTestBoundary() {
  return createBackstageBookerHttpBoundary({
    genericAuth: (_req, res) => {
      res.status(401).json({ error: 'generic-auth-not-allowed' });
    },
    rateLimit: (_req, _res, next) => next(),
  });
}

beforeAll(() => {
  process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = ACCESS_TOKEN;
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = PAYLOAD_KEY;
});

afterAll(() => {
  restoreEnvironmentValue(
    'ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN',
    ORIGINAL_ACCESS_TOKEN
  );
  restoreEnvironmentValue(
    'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY',
    ORIGINAL_PAYLOAD_KEY
  );
});

describe('Backstage Booker reused queue wait', () => {
  it('uses the existing maximum bounded hybrid wait before returning HTTP 202', () => {
    const policy = resolveBackstageExecutionBudgetPolicy({
      profile: 'queued_generation',
      action: 'generateBooking',
    });

    expect(BACKSTAGE_RESULT_POLL_WAIT_MS).toBe(30_000);
    expect(BACKSTAGE_RESULT_POLL_WAIT_MS).toBe(MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS);
    expect(resolveAsyncGptWaitForResultMs(BACKSTAGE_RESULT_POLL_WAIT_MS))
      .toBe(BACKSTAGE_RESULT_POLL_WAIT_MS);
    expect(policy.resultPollWaitMs).toBe(BACKSTAGE_RESULT_POLL_WAIT_MS);
    expect(policy.resultPollWaitMs).toBeLessThan(policy.operationTimeoutMs);
  });

  it('keeps continuity and bounded synchronous generation outside the queue wait', () => {
    expect(resolveBackstageExecutionBudgetPolicy({
      profile: 'continuity_sync',
    }).resultPollWaitMs).toBe(0);
    expect(resolveBackstageExecutionBudgetPolicy({
      profile: 'bounded_sync_generation',
      action: 'generateBooking',
    }).resultPollWaitMs).toBe(0);
  });

  it('isolates the protected Booker wait from the generic heavy wait setting', () => {
    expect(resolveGptAsyncHeavyWaitForResultMs({
      protectedBackstageQueueRequired: true,
      configuredGenericWaitForResultMs: 1,
    })).toBe(BACKSTAGE_RESULT_POLL_WAIT_MS);
    expect(resolveGptAsyncHeavyWaitForResultMs({
      protectedBackstageQueueRequired: false,
    })).toBe(DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS);
    expect(resolveGptAsyncHeavyWaitForResultMs({
      protectedBackstageQueueRequired: false,
      configuredGenericWaitForResultMs: '750.9',
    })).toBe(750);
    expect(resolveGptAsyncHeavyWaitForResultMs({
      protectedBackstageQueueRequired: false,
      configuredGenericWaitForResultMs: 'invalid',
    })).toBe(DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS);
  });

  it('keeps the 30-second polling window within the shared read bounds', () => {
    const emptyEnvironment = {} as NodeJS.ProcessEnv;
    const defaultPollIntervalMs = resolveAsyncGptPollIntervalMs(
      undefined,
      emptyEnvironment
    );
    const minimumPollIntervalMs = resolveAsyncGptPollIntervalMs(1, emptyEnvironment);

    expect(defaultPollIntervalMs).toBe(DEFAULT_ASYNC_GPT_WAIT_POLL_MS);
    expect(resolveQueuedJobWaitPollLimit(
      BACKSTAGE_RESULT_POLL_WAIT_MS,
      defaultPollIntervalMs,
      MAX_ASYNC_GPT_WAIT_POLLS
    )).toBe(121);
    expect(minimumPollIntervalMs).toBe(50);
    expect(resolveQueuedJobWaitPollLimit(
      BACKSTAGE_RESULT_POLL_WAIT_MS,
      minimumPollIntervalMs,
      MAX_ASYNC_GPT_WAIT_POLLS
    )).toBe(MAX_ASYNC_GPT_WAIT_POLLS);
  });

  it('parses only the bounded canonical result wait query', () => {
    expect(parseBackstageBookerAsyncResultQuery({})).toEqual({
      ok: true,
      waitForResultMs: 30_000,
    });
    expect(parseBackstageBookerAsyncResultQuery({
      waitForResultMs: '0',
    })).toEqual({ ok: true, waitForResultMs: 0 });
    expect(parseBackstageBookerAsyncResultQuery({
      waitForResultMs: '30000',
    })).toEqual({ ok: true, waitForResultMs: 30_000 });
    for (const query of [
      { waitForResultMs: '30001' },
      { waitForResultMs: '01' },
      { waitForResultMs: '-1' },
      { waitForResultMs: ['1000', '2000'] },
      { waitForResultMs: '1000', extra: 'true' },
    ]) {
      expect(parseBackstageBookerAsyncResultQuery(query)).toEqual({ ok: false });
    }
  });

  it('returns an owned completed protected job with the managed bearer only', async () => {
    const completedJob = completeProtectedJob(buildProtectedJob());
    const getJobByIdFn = jest.fn(async () => completedJob);
    const waitForCompletion = jest.fn<typeof waitForQueuedGptJobCompletion>();
    const app = express();
    app.use(createBackstageBookerAsyncResultRouter({
      boundary: buildTestBoundary(),
      getJobByIdFn,
      waitForQueuedGptJobCompletionFn: waitForCompletion,
      recordJobLookup: jest.fn(),
    }));

    const response = await request(app)
      .get(RESULT_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.status).toBe('completed');
    expect(response.body.result).toEqual({
      ok: true,
      result: {
        booking: 'Official protected Backstage Booker result.',
      },
    });
    expect(getJobByIdFn).toHaveBeenCalledTimes(1);
    expect(waitForCompletion).not.toHaveBeenCalled();
  });

  it('reuses the existing bounded waiter for an owned running job', async () => {
    const runningJob = buildProtectedJob();
    const completedJob = completeProtectedJob(runningJob);
    const getJobByIdFn = jest
      .fn<(jobId: string) => Promise<JobData | null>>()
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValueOnce(completedJob);
    const waitForCompletion = jest.fn<typeof waitForQueuedGptJobCompletion>(
      async (jobId, options, dependencies) => {
        expect(jobId).toBe(JOB_ID);
        expect(options).toEqual(expect.objectContaining({
          waitForResultMs: 30_000,
          pollIntervalMs: 250,
          signal: expect.any(AbortSignal),
        }));
        const first = await dependencies!.getJobByIdFn!(jobId);
        const second = await dependencies!.getJobByIdFn!(jobId);
        expect(first?.status).toBe('running');
        expect(second?.status).toBe('completed');
        return { state: 'completed', job: second! };
      }
    );
    const app = express();
    app.use(createBackstageBookerAsyncResultRouter({
      boundary: buildTestBoundary(),
      getJobByIdFn,
      waitForQueuedGptJobCompletionFn: waitForCompletion,
      recordJobLookup: jest.fn(),
    }));

    const response = await request(app)
      .get(RESULT_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('completed');
    expect(waitForCompletion).toHaveBeenCalledTimes(1);
    expect(getJobByIdFn).toHaveBeenCalledTimes(2);
  });

  it('conceals unrelated or unowned jobs before entering the waiter', async () => {
    const actorKey = buildAuthenticatedCredentialActorKey(
      'backstage-booker-access',
      ACCESS_TOKEN
    );
    const jobs: Array<JobData | null> = [
      null,
      buildProtectedJob({ idempotency_scope_hash: '0'.repeat(64) }),
      buildProtectedJob({ job_type: 'ask' }),
      buildProtectedJob({ input: { gptId: 'backstage-booker' } }),
    ];

    for (const job of jobs) {
      const waitForCompletion = jest.fn<typeof waitForQueuedGptJobCompletion>();
      const result = await readBackstageBookerAsyncResult({
        jobId: JOB_ID,
        actorKey,
        waitForResultMs: 30_000,
      }, {
        getJobByIdFn: async () => job,
        waitForQueuedGptJobCompletionFn: waitForCompletion,
      });

      expect(result.status).toBe('not_found');
      expect(result.result).toBeNull();
      expect(waitForCompletion).not.toHaveBeenCalled();
    }
  });

  it('rejects an invalid bearer before reading any job', async () => {
    const getJobByIdFn = jest.fn(async () => buildProtectedJob());
    const app = express();
    app.use(createBackstageBookerAsyncResultRouter({
      boundary: buildTestBoundary(),
      getJobByIdFn,
      recordJobLookup: jest.fn(),
    }));

    const response = await request(app)
      .get(RESULT_PATH)
      .set('Authorization', 'Bearer incorrect-token');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED_GPT_ACCESS');
    expect(getJobByIdFn).not.toHaveBeenCalled();
  });

  it('fails closed when protected terminal output cannot be materialized', async () => {
    const malformedJob = buildProtectedJob({
      status: 'completed',
      output: { source: 'tampered' },
      completed_at: new Date('2026-08-26T00:00:42.000Z'),
    });
    const app = express();
    app.use(createBackstageBookerAsyncResultRouter({
      boundary: buildTestBoundary(),
      getJobByIdFn: async () => malformedJob,
      recordJobLookup: jest.fn(),
    }));

    const response = await request(app)
      .get(RESULT_PATH)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('BACKSTAGE_ASYNC_RESULT_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('tampered');
  });
});

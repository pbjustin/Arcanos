import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const findOrCreateGptJobMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const waitForQueuedGptJobCompletionMock = jest.fn();
const resolveAsyncGptPollIntervalMsMock = jest.fn((requested?: number) => requested ?? 250);
const resolveAsyncGptWaitForResultMsMock = jest.fn((requested?: number) => requested ?? 3500);
const getDatabaseStatusMock = jest.fn();
const getWorkerControlHealthMock = jest.fn();
const resolveGptRoutingMock = jest.fn();

class MockIdempotencyKeyConflictError extends Error {}
class MockJobRepositoryUnavailableError extends Error {}
const JOB_READ_SECRET = 'custom-gpt-bridge-job-read-capability-secret-1234567890';
const originalJobReadSecret = process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  IdempotencyKeyConflictError: MockIdempotencyKeyConflictError,
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  findOrCreateGptJob: findOrCreateGptJobMock,
}));

jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
  planAutonomousWorkerJob: planAutonomousWorkerJobMock,
}));

jest.unstable_mockModule('../src/services/queuedGptCompletionService.js', () => ({
  waitForQueuedGptJobCompletion: waitForQueuedGptJobCompletionMock,
  resolveAsyncGptPollIntervalMs: resolveAsyncGptPollIntervalMsMock,
  resolveAsyncGptWaitForResultMs: resolveAsyncGptWaitForResultMsMock,
}));

jest.unstable_mockModule('../src/core/db/index.js', () => ({
  getStatus: getDatabaseStatusMock,
}));

jest.unstable_mockModule('../src/services/workerControlService.js', () => ({
  getWorkerControlHealth: getWorkerControlHealthMock,
}));

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: resolveGptRoutingMock,
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: bridgeRouter } = await import('../src/routes/bridge.js');
const { executeCustomGptBridgeRequest } = await import('../src/services/customGptBridgeService.js');
const {
  buildGptIdempotencyScopeHash,
  buildGptRequestFingerprintHash,
} = await import('../src/shared/gpt/gptIdempotency.js');
const { buildAuthenticatedCredentialActorKey } = await import(
  '../src/shared/security/opaqueSecret.js'
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/', bridgeRouter);
  return app;
}

function buildJob(id: string, status: string, output: unknown = null) {
  return {
    id,
    job_type: 'gpt',
    input: {
      requestPath: '/api/bridge/gpt',
      executionModeReason: 'bridge_query',
    },
    status,
    created_at: '2026-04-16T12:00:00.000Z',
    started_at: status === 'pending' ? null : '2026-04-16T12:00:01.000Z',
    completed_at: status === 'completed' ? '2026-04-16T12:00:02.000Z' : null,
    output,
  };
}

describe('Custom GPT bridge route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = JOB_READ_SECRET;
    process.env.OPENAI_ACTION_SHARED_SECRET = 'test-bridge-secret';
    process.env.DEFAULT_GPT_ID = 'arcanos-core';
    delete process.env.OPENAI_ACTION_BRIDGE_WAIT_TIMEOUT_MS;
    delete process.env.OPENAI_ACTION_BRIDGE_QUERY_WAIT_TIMEOUT_MS;
    delete process.env.OPENAI_ACTION_BRIDGE_POLL_INTERVAL_MS;
    delete process.env.OPENAI_ACTION_BRIDGE_FAILURE_COUNTER_WINDOW_MS;
    getDatabaseStatusMock.mockReturnValue({
      connected: true,
      hasPool: true,
      error: null,
    });
    getWorkerControlHealthMock.mockResolvedValue({
      ok: true,
      status: 'healthy',
    });
    resolveGptRoutingMock.mockResolvedValue({
      ok: true,
      plan: {
        route: '/gpt/arcanos-core',
      },
    });
    planAutonomousWorkerJobMock.mockResolvedValue({
      status: 'pending',
      retryCount: 0,
      maxRetries: 2,
      priority: 85,
      autonomyState: {
        planner: {
          reasons: [],
        },
      },
      planningReasons: [],
    });
  });

  it('requires bridge authentication before collecting health diagnostics', async () => {
    const privateDefaultGptSentinel = 'private-bridge-health-gpt-sentinel';
    process.env.DEFAULT_GPT_ID = privateDefaultGptSentinel;

    const response = await request(buildApp()).get('/api/bridge/health');

    expect(response.status).toBe(401);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({
      ok: false,
      status: 'unauthorized',
      error: {
        source: 'auth',
        message: 'Missing or invalid bridge shared secret.',
      },
      request_id: null,
    });
    expect(JSON.stringify(response.body)).not.toContain(privateDefaultGptSentinel);
    expect(response.body).not.toHaveProperty('env');
    expect(response.body).not.toHaveProperty('database');
    expect(response.body).not.toHaveProperty('worker_status');
    expect(response.body).not.toHaveProperty('route_reachability');
    expect(response.body).not.toHaveProperty('recent_failure_counters');
    expect(response.body).not.toHaveProperty('failure_counters_since_start');
    expect(getDatabaseStatusMock).not.toHaveBeenCalled();
    expect(getWorkerControlHealthMock).not.toHaveBeenCalled();
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
  });

  it('fails closed without collecting health diagnostics when the bridge secret is unconfigured', async () => {
    delete process.env.OPENAI_ACTION_SHARED_SECRET;

    const response = await request(buildApp())
      .get('/api/bridge/health')
      .set('Authorization', 'Bearer any-value');

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({
      ok: false,
      status: 'misconfigured',
      error: {
        source: 'auth',
        message: 'OPENAI_ACTION_SHARED_SECRET is not configured.',
      },
      request_id: null,
    });
    expect(getDatabaseStatusMock).not.toHaveBeenCalled();
    expect(getWorkerControlHealthMock).not.toHaveBeenCalled();
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
  });

  it('preserves bridge secret carrier precedence on health requests', async () => {
    const response = await request(buildApp())
      .get('/api/bridge/health')
      .set('x-openai-action-secret', 'wrong-secret')
      .set('x-action-secret', 'test-bridge-secret');

    expect(response.status).toBe(401);
    expect(getDatabaseStatusMock).not.toHaveBeenCalled();
    expect(getWorkerControlHealthMock).not.toHaveBeenCalled();
    expect(resolveGptRoutingMock).not.toHaveBeenCalled();
  });

  it('reports missing job-read capability configuration in authenticated health', async () => {
    delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

    const response = await request(buildApp())
      .get('/api/bridge/health')
      .set('Authorization', 'Bearer test-bridge-secret');

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({
      ok: false,
      status: 'degraded',
      env: {
        ARCANOS_JOB_READ_CAPABILITY_SECRET: {
          configured: false,
        },
      },
    });
    expect(response.body.missing_required_env).toContain(
      'ARCANOS_JOB_READ_CAPABILITY_SECRET'
    );
  });

  it('sanitizes authenticated bridge dependency health failures', async () => {
    const privateDatabaseSentinel = 'PRIVATE_BRIDGE_DATABASE_HEALTH_SENTINEL';
    const privateWorkerSentinel = 'PRIVATE_BRIDGE_WORKER_HEALTH_SENTINEL';
    getDatabaseStatusMock.mockReturnValue({
      connected: false,
      hasPool: false,
      error: `database connection failed: ${privateDatabaseSentinel}`,
    });
    getWorkerControlHealthMock.mockRejectedValue(
      new Error(`worker health failed: ${privateWorkerSentinel}`),
    );

    const response = await request(buildApp())
      .get('/api/bridge/health')
      .set('Authorization', 'Bearer test-bridge-secret');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body.database).toEqual({
      connected: false,
      hasPool: false,
      error: 'Database health is unavailable.',
    });
    expect(response.body.worker_status).toEqual({
      ok: false,
      status: 'unavailable',
      error: 'Worker health is unavailable.',
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(privateDatabaseSentinel);
    expect(serialized).not.toContain(privateWorkerSentinel);
  });

  it('replaces failed default-GPT routing text with a fixed health message', async () => {
    const privateRoutingSentinel = 'PRIVATE_BRIDGE_ROUTING_HEALTH_SENTINEL';
    resolveGptRoutingMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'UNKNOWN_GPT',
        message: `unregistered route: ${privateRoutingSentinel}`,
      },
    });

    const response = await request(buildApp())
      .get('/api/bridge/health')
      .set('Authorization', 'Bearer test-bridge-secret');

    expect(response.status).toBe(200);
    expect(response.body.route_reachability.default_gpt).toEqual({
      method: 'POST',
      path: '/gpt/arcanos-core',
      reachable: false,
      source: 'unregistered',
      message: 'Default GPT route is unavailable.',
    });
    expect(JSON.stringify(response.body)).not.toContain(privateRoutingSentinel);
  });

  it('rejects requests with an invalid bridge shared secret', async () => {
    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer wrong-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'unauthorized',
        error: expect.objectContaining({
          source: 'auth',
        }),
      }),
    );
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('fails closed before bridge planning and persistence when job-read capability configuration is unavailable', async () => {
    delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({
      ok: false,
      status: 'misconfigured',
      error: {
        source: 'queue',
        message: 'Async job reads are temporarily unavailable.',
      },
      request_id: expect.any(String),
    });
    expect(planAutonomousWorkerJobMock).not.toHaveBeenCalled();
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it.each(['/api/bridge/gpt', '/api/openai/gpt-action'])(
    'returns a fixed error for unexpected failures from %s',
    async (path) => {
      const privateFailureSentinel = 'PRIVATE_BRIDGE_REQUEST_FAILURE_SENTINEL';
      findOrCreateGptJobMock.mockRejectedValueOnce(
        new Error(`unexpected bridge failure: ${privateFailureSentinel}`),
      );

      const response = await request(buildApp())
        .post(path)
        .set('Authorization', 'Bearer test-bridge-secret')
        .send({
          gptId: 'arcanos-core',
          prompt: 'Analyze this deployment',
          action: 'query',
        });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        ok: false,
        status: 'routing_error',
        error: {
          source: 'routing',
          message: 'Custom GPT bridge request failed.',
        },
        request_id: expect.any(String),
        timing: expect.any(Object),
      });
      expect(JSON.stringify(response.body)).not.toContain(privateFailureSentinel);
    },
  );

  it('returns a fixed conflict message for explicit idempotency-key reuse', async () => {
    const privateConflictSentinel = 'PRIVATE_BRIDGE_IDEMPOTENCY_CONFLICT_SENTINEL';
    findOrCreateGptJobMock.mockRejectedValueOnce(
      new MockIdempotencyKeyConflictError(
        `conflicting request fingerprint: ${privateConflictSentinel}`,
      ),
    );

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .set('Idempotency-Key', 'client-retry-key')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      status: 'queue_error',
      error: {
        source: 'queue',
        message: 'Idempotency key conflicts with an existing request.',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(privateConflictSentinel);
  });

  it('returns a sanitized 503 when durable persistence is unavailable during enqueue', async () => {
    const privateRepositorySentinel = 'PRIVATE_BRIDGE_ENQUEUE_REPOSITORY_SENTINEL';
    findOrCreateGptJobMock.mockRejectedValueOnce(
      new MockJobRepositoryUnavailableError(
        `bridge job repository unavailable: ${privateRepositorySentinel}`,
      ),
    );

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      status: 'queue_error',
      error: {
        source: 'queue',
        message: 'Durable GPT job persistence is unavailable.',
      },
      request_id: expect.any(String),
      timing: expect.any(Object),
    });
    expect(response.body).not.toHaveProperty('jobId');
    expect(JSON.stringify(response.body)).not.toContain(privateRepositorySentinel);
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('returns a pending async job response for query actions', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: buildJob('job-pending-123', 'pending'),
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
        metadata: {
          source: 'custom-gpt',
        },
      });

    expect(response.status).toBe(202);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        status: 'pending',
        jobId: 'job-pending-123',
        poll_url: '/jobs/job-pending-123/result',
        result_url: '/jobs/job-pending-123/result',
        action: 'query',
        jobReadToken: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/u),
        jobReadTokenHeader: 'x-arcanos-job-read-token',
      }),
    );
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: 'Analyze this deployment',
          body: expect.objectContaining({
            prompt: 'Analyze this deployment',
          }),
        }),
      }),
    );
    const jobOptions = findOrCreateGptJobMock.mock.calls[0]?.[0];
    const legacyFingerprintHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'query',
      body: {
        prompt: 'Analyze this deployment',
        action: 'query',
      },
    });
    const bridgeFingerprintHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'query',
      body: {
        prompt: 'Analyze this deployment',
        action: 'query',
        bridgeFingerprintVersion: 3,
      },
    });
    expect(jobOptions?.requestFingerprintHash).toBe(bridgeFingerprintHash);
    expect(jobOptions?.requestFingerprintHash).not.toBe(legacyFingerprintHash);
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('uses one authenticated bridge actor across bearer grammar, action-secret, and session variants', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: buildJob('job-auth-actor-123', 'pending'),
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    const body = {
      gptId: 'arcanos-core',
      prompt: 'Analyze this authenticated actor',
      action: 'query',
    };

    const bearerResponse = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'bEaReR   test-bridge-secret')
      .set('X-Session-ID', 'caller-session-one')
      .send(body);
    const actionSecretResponse = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Basic attacker-selected-value')
      .set('x-openai-action-secret', 'test-bridge-secret')
      .set('X-Session-ID', 'caller-session-two')
      .send(body);

    expect(bearerResponse.status).toBe(202);
    expect(actionSecretResponse.status).toBe(202);
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(2);
    const expectedScopeHash = buildGptIdempotencyScopeHash({
      surface: 'custom-gpt-bridge',
      actorKey: buildAuthenticatedCredentialActorKey(
        'custom-gpt-bridge',
        'test-bridge-secret'
      ),
    });
    expect(findOrCreateGptJobMock.mock.calls[0]?.[0]?.idempotencyScopeHash)
      .toBe(expectedScopeHash);
    expect(findOrCreateGptJobMock.mock.calls[1]?.[0]?.idempotencyScopeHash)
      .toBe(expectedScopeHash);
  });

  it('does not issue a generic capability when persistence returns protected GPT Access provenance', async () => {
    const protectedResultSentinel = 'PROTECTED_BRIDGE_REUSE_RESULT_SENTINEL';
    findOrCreateGptJobMock.mockResolvedValue({
      job: {
        ...buildJob('protected-gpt-access-job', 'completed', {
          result: protectedResultSentinel,
        }),
        input: {
          requestPath: '/gpt-access/jobs/create',
          executionModeReason: 'gpt_access_create_ai_job',
        },
      },
      created: false,
      deduped: true,
      dedupeReason: 'reused_completed_result',
    });

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Attempt protected cross-surface reuse',
        action: 'query',
      });

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        source: 'queue',
        message: 'Async job continuation is temporarily unavailable.',
      },
    });
    expect(response.body).not.toHaveProperty('jobId');
    expect(response.body).not.toHaveProperty('jobReadToken');
    expect(JSON.stringify(response.body)).not.toContain(protectedResultSentinel);
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('returns completed output immediately when a query dedupes to a completed job', async () => {
    const completedJob = buildJob('job-deduped-completed-123', 'completed', {
      ok: true,
      result: 'cached output',
    });
    findOrCreateGptJobMock.mockResolvedValue({
      job: completedJob,
      created: false,
      deduped: true,
      dedupeReason: 'reused_completed_result',
    });

    const response = await request(buildApp())
      .post('/api/openai/gpt-action')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        status: 'completed',
        jobId: 'job-deduped-completed-123',
        output: 'cached output',
        observability: expect.objectContaining({
          deduped: true,
        }),
      }),
    );
    expect(waitForQueuedGptJobCompletionMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid DEFAULT_GPT_ID before enqueueing work', async () => {
    process.env.DEFAULT_GPT_ID = 'x'.repeat(129);

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        prompt: 'Analyze this deployment',
        action: 'query',
      });

    expect(response.status).toBe(503);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'misconfigured',
        error: expect.objectContaining({
          source: 'routing',
          message: expect.stringContaining('DEFAULT_GPT_ID is invalid'),
        }),
      }),
    );
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('returns a completed output when query_and_wait finishes within the wait window', async () => {
    const completedJob = buildJob('job-completed-123', 'completed', {
      ok: true,
      result: {
        answer: 'Deployment is healthy.',
      },
    });
    findOrCreateGptJobMock.mockResolvedValue({
      job: buildJob('job-completed-123', 'running'),
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    waitForQueuedGptJobCompletionMock.mockResolvedValue({
      state: 'completed',
      job: completedJob,
    });

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('x-openai-action-secret', 'test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query_and_wait',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: true,
        status: 'completed',
        jobId: 'job-completed-123',
        poll_url: '/jobs/job-completed-123/result',
        result_url: '/jobs/job-completed-123/result',
        output: {
          answer: 'Deployment is healthy.',
        },
      }),
    );
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith('job-completed-123', {
      waitForResultMs: 3500,
      pollIntervalMs: 250,
      signal: expect.any(AbortSignal),
    });
    const waiterSignal = waitForQueuedGptJobCompletionMock.mock.calls[0]?.[1]
      ?.signal as AbortSignal;
    expect(waiterSignal.aborted).toBe(false);
  });

  it('returns a sanitized 503 with the accepted job id when polling becomes unavailable', async () => {
    findOrCreateGptJobMock.mockResolvedValue({
      job: buildJob('job-wait-unavailable-123', 'running'),
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    waitForQueuedGptJobCompletionMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('internal bridge repository sentinel'),
    );

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query_and_wait',
      });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      status: 'queue_error',
      error: {
        source: 'queue',
        message: 'Durable GPT job persistence is unavailable.',
      },
      jobId: 'job-wait-unavailable-123',
      request_id: expect.any(String),
      timing: expect.any(Object),
    });
    expect(JSON.stringify(response.body)).not.toContain('internal bridge repository sentinel');
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('returns the accepted continuation after an unexpected polling failure', async () => {
    const privateWaitSentinel = 'PRIVATE_BRIDGE_WAIT_FAILURE_SENTINEL';
    findOrCreateGptJobMock.mockResolvedValue({
      job: buildJob('job-wait-recovery-123', 'running'),
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    waitForQueuedGptJobCompletionMock.mockRejectedValue(
      new Error(privateWaitSentinel),
    );

    const response = await request(buildApp())
      .post('/api/bridge/gpt')
      .set('Authorization', 'Bearer test-bridge-secret')
      .send({
        gptId: 'arcanos-core',
        prompt: 'Analyze this deployment',
        action: 'query_and_wait',
      });

    expect(response.status).toBe(202);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({
      ok: true,
      status: 'pending',
      jobId: 'job-wait-recovery-123',
      poll_url: '/jobs/job-wait-recovery-123/result',
      result_url: '/jobs/job-wait-recovery-123/result',
      jobReadToken: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/u),
      jobReadTokenHeader: 'x-arcanos-job-read-token',
    });
    expect(JSON.stringify(response.body)).not.toContain(privateWaitSentinel);
    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('preserves enqueueing but rethrows an already-aborted wait signal', async () => {
    const controller = new AbortController();
    const expectedError = new Error('bridge client disconnected');
    expectedError.name = 'AbortError';
    controller.abort(expectedError);
    findOrCreateGptJobMock.mockResolvedValue({
      job: buildJob('job-aborted-wait-123', 'running'),
      created: true,
      deduped: false,
      dedupeReason: 'new_job',
    });
    waitForQueuedGptJobCompletionMock.mockImplementation(
      async (_jobId: string, options: { signal?: AbortSignal }) => {
        options.signal?.throwIfAborted();
        throw new Error('unreachable');
      },
    );

    await expect(
      executeCustomGptBridgeRequest({
        request: {
          gptId: 'arcanos-core',
          prompt: 'Analyze this deployment',
          action: 'query_and_wait',
          metadata: {},
        },
        requestId: 'bridge-aborted-request',
        actorKey: 'bridge-test-actor',
        signal: controller.signal,
      }),
    ).rejects.toBe(expectedError);

    expect(findOrCreateGptJobMock).toHaveBeenCalledTimes(1);
    expect(waitForQueuedGptJobCompletionMock).toHaveBeenCalledWith(
      'job-aborted-wait-123',
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  afterAll(() => {
    if (originalJobReadSecret === undefined) {
      delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;
    } else {
      process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = originalJobReadSecret;
    }
  });
});

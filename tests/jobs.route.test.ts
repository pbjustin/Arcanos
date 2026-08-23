import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  JOB_READ_CAPABILITY_HEADER_NAME,
  issueJobReadCapability,
} from '../src/shared/jobs/jobReadCapability.js';
import { buildGptIdempotencyScopeHash } from '../src/shared/gpt/gptIdempotency.js';
import {
  buildProtectedBackstageQueuedGptJobInput,
  buildQueuedGptBackstageMutationAdmission,
} from '../src/shared/gpt/asyncGptJob.js';
import {
  protectBackstageQueuedGptJobOutput,
} from '../src/shared/backstage/backstageQueuedJobResultProtection.js';
import { BACKSTAGE_STORYLINE_MAX_BYTES } from '../src/shared/backstage/backstageStoryline.js';
import { buildAuthenticatedCredentialActorKey } from '../src/shared/security/opaqueSecret.js';

const getJobByIdMock = jest.fn();
const requestJobCancellationMock = jest.fn();
const sleepMock = jest.fn();
class MockJobRepositoryUnavailableError extends Error {}

const originalAllowAllGpts = process.env.ALLOW_ALL_GPTS;
const originalTrustedGptIds = process.env.TRUSTED_GPT_IDS;
process.env.ALLOW_ALL_GPTS = 'false';
process.env.TRUSTED_GPT_IDS = '';

jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
  getJobById: async (...args: unknown[]) => {
    const job = await getJobByIdMock(...args);
    return job?.job_type === 'gpt' && job.input === undefined
      ? {
          ...job,
          input: {
            requestPath: '/gpt/arcanos-core',
            executionModeReason: 'test_public_gpt',
          },
        }
      : job;
  },
  JobRepositoryUnavailableError: MockJobRepositoryUnavailableError,
  requestJobCancellation: requestJobCancellationMock
}));

jest.unstable_mockModule('../src/shared/sleep.js', () => ({
  sleep: sleepMock
}));

const { default: jobsRouter } = await import('../src/routes/jobs.js');

const COMPLETED_JOB_ID = '11111111-1111-4111-8111-111111111111';
const MISSING_JOB_ID = '22222222-2222-4222-8222-222222222222';
const EXPIRED_JOB_ID = '33333333-3333-4333-8333-333333333333';
const RUNNING_JOB_ID = '44444444-4444-4444-8444-444444444444';
const QUEUED_JOB_ID = '55555555-5555-4555-8555-555555555555';
const CANCEL_REQUEST_JOB_ID = '66666666-6666-4666-8666-666666666666';
const TERMINAL_JOB_ID = '77777777-7777-4777-8777-777777777777';
const TRUNCATED_JOB_ID = '88888888-8888-4888-8888-888888888888';
const LOCAL_AGENT_JOB_ID = '99999999-9999-4999-8999-999999999999';
const DAG_NODE_JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GPT_ACCESS_JOB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRIDGE_JOB_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STORYLINE_JOB_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROTECTED_BOOKER_JOB_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const JOB_READ_SECRET = 'jobs-route-read-capability-secret-1234567890';
const BRIDGE_SECRET = 'bridge-cancellation-actor-secret';
const originalJobReadSecret = process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;
const originalPreviousJobReadSecret =
  process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET;
const originalBridgeSecret = process.env.OPENAI_ACTION_SHARED_SECRET;
const originalBackstagePayloadKey =
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
const originalBackstagePreviousPayloadKey =
  process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY;

function buildApp(options: { authenticatedUserId?: number } = {}) {
  const app = express();
  app.use(express.json());
  if (options.authenticatedUserId !== undefined) {
    app.use((req, _res, next) => {
      req.authUser = {
        id: options.authenticatedUserId!,
        email: 'actor@example.test',
        role: 'operator',
        plan: 'test',
        profileId: null,
        source: 'session',
      };
      next();
    });
  }
  app.use('/', jobsRouter);
  return app;
}

function hashActorKey(
  actorKey: string,
  surface: 'public-gpt' | 'custom-gpt-bridge' = 'public-gpt'
): string {
  return buildGptIdempotencyScopeHash({
    surface,
    actorKey,
  });
}

function getWithJobReadToken(path: string, jobId: string) {
  return request(buildApp())
    .get(path)
    .set(
      JOB_READ_CAPABILITY_HEADER_NAME,
      issueJobReadCapability(jobId, JOB_READ_SECRET)
    );
}

function postWithJobReadToken(
  path: string,
  jobId: string,
  authenticatedUserId?: number
) {
  return request(buildApp({ authenticatedUserId }))
    .post(path)
    .set(
      JOB_READ_CAPABILITY_HEADER_NAME,
      issueJobReadCapability(jobId, JOB_READ_SECRET)
    );
}

function expectNoStore(
  ...responses: Array<{ headers: Record<string, string | undefined> }>
): void {
  for (const response of responses) {
    expect(response.headers['cache-control']).toContain('no-store');
  }
}

function buildLargeStorylineBeats() {
  return Array.from({ length: 25 }, (_value, index) => ({
    sequence: index + 1,
    summary: `storyline-beat-${index + 1}`,
    detail: `${String(index + 1).padStart(2, '0')}:${'x'.repeat(11_000)}`,
  }));
}

describe('/jobs routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sleepMock.mockResolvedValue(undefined);
    process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = JOB_READ_SECRET;
    process.env.OPENAI_ACTION_SHARED_SECRET = BRIDGE_SECRET;
    delete process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET;
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x62).toString('base64');
    delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY;
  });

  afterAll(() => {
    if (originalJobReadSecret === undefined) {
      delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;
    } else {
      process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET = originalJobReadSecret;
    }
    if (originalPreviousJobReadSecret === undefined) {
      delete process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET;
    } else {
      process.env.ARCANOS_JOB_READ_CAPABILITY_PREVIOUS_SECRET =
        originalPreviousJobReadSecret;
    }
    if (originalBridgeSecret === undefined) {
      delete process.env.OPENAI_ACTION_SHARED_SECRET;
    } else {
      process.env.OPENAI_ACTION_SHARED_SECRET = originalBridgeSecret;
    }
    if (originalBackstagePayloadKey === undefined) {
      delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
    } else {
      process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
        originalBackstagePayloadKey;
    }
    if (originalBackstagePreviousPayloadKey === undefined) {
      delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY;
    } else {
      process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY =
        originalBackstagePreviousPayloadKey;
    }
    if (originalAllowAllGpts === undefined) {
      delete process.env.ALLOW_ALL_GPTS;
    } else {
      process.env.ALLOW_ALL_GPTS = originalAllowAllGpts;
    }
    if (originalTrustedGptIds === undefined) {
      delete process.env.TRUSTED_GPT_IDS;
    } else {
      process.env.TRUSTED_GPT_IDS = originalTrustedGptIds;
    }
  });

  it('returns the canonical stored-result lookup payload without enqueueing work', async () => {
    getJobByIdMock.mockResolvedValue({
      id: COMPLETED_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      retention_until: '2026-04-07T10:01:00.000Z',
      idempotency_until: '2026-04-07T10:01:00.000Z',
      expires_at: null,
      error_message: null,
      output: {
        ok: true,
        result: {
          answer: 'stored output'
        }
      },
      cancel_requested_at: null,
      cancel_reason: null
    });

    const response = await getWithJobReadToken(
      `/jobs/${COMPLETED_JOB_ID}/result`,
      COMPLETED_JOB_ID
    );

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual({
      jobId: COMPLETED_JOB_ID,
      status: 'completed',
      jobStatus: 'completed',
      lifecycleStatus: 'completed',
      createdAt: '2026-04-06T10:00:00.000Z',
      updatedAt: '2026-04-06T10:01:00.000Z',
      completedAt: '2026-04-06T10:01:00.000Z',
      retentionUntil: '2026-04-07T10:01:00.000Z',
      idempotencyUntil: '2026-04-07T10:01:00.000Z',
      expiresAt: null,
      poll: `/jobs/${COMPLETED_JOB_ID}/result`,
      stream: `/jobs/${COMPLETED_JOB_ID}/stream`,
      result: {
        ok: true,
        result: {
          answer: 'stored output'
        }
      },
      error: null
    });
  });

  it('decrypts a protected Booker result only after the existing job-read capability succeeds', async () => {
    const privatePrompt = 'private-job-route-prompt-sentinel';
    const privateResult = 'private-job-route-result-sentinel';
    const input = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: { universeId: 'my-universe-2k26', prompt: privatePrompt },
      },
      prompt: privatePrompt,
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-protected-result',
      traceId: 'trace-protected-result',
    });
    const output = protectBackstageQueuedGptJobOutput({
      jobId: PROTECTED_BOOKER_JOB_ID,
      rawInput: input,
      output: {
        ok: true,
        result: privateResult,
        _route: {
          gptId: 'backstage-booker',
          module: 'BACKSTAGE:BOOKER',
          action: 'generateBooking',
          route: 'backstage-booker',
        },
      },
    });
    getJobByIdMock.mockResolvedValue({
      id: PROTECTED_BOOKER_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-08-23T10:00:00.000Z',
      updated_at: '2026-08-23T10:01:00.000Z',
      completed_at: '2026-08-23T10:01:00.000Z',
      retention_until: '2026-08-24T10:01:00.000Z',
      idempotency_until: '2026-08-24T10:01:00.000Z',
      expires_at: null,
      error_message: null,
      input,
      output,
      cancel_requested_at: null,
      cancel_reason: null,
    });

    const response = await getWithJobReadToken(
      `/jobs/${PROTECTED_BOOKER_JOB_ID}/result`,
      PROTECTED_BOOKER_JOB_ID
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      jobId: PROTECTED_BOOKER_JOB_ID,
      status: 'completed',
      result: {
        ok: true,
        result: privateResult,
        _route: { action: 'generateBooking' },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(
      (output as { sealedPayload: { ciphertext: string } }).sealedPayload.ciphertext
    );
  });

  it('does not attempt protected-result decryption before job-read authorization', async () => {
    const input = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: { universeId: 'my-universe-2k26', prompt: 'private prompt' },
      },
      prompt: 'private prompt',
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
    });
    const output = protectBackstageQueuedGptJobOutput({
      jobId: PROTECTED_BOOKER_JOB_ID,
      rawInput: input,
      output: { ok: true, result: 'private result' },
    });
    getJobByIdMock.mockResolvedValue({
      id: PROTECTED_BOOKER_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      input,
      output,
    });
    delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;

    const unauthorized = await request(buildApp())
      .get(`/jobs/${PROTECTED_BOOKER_JOB_ID}/result`);
    const authorized = await getWithJobReadToken(
      `/jobs/${PROTECTED_BOOKER_JOB_ID}/result`,
      PROTECTED_BOOKER_JOB_ID
    );

    expect(unauthorized.status).toBe(200);
    expect(unauthorized.body).toMatchObject({ status: 'not_found', result: null });
    expect(getJobByIdMock).toHaveBeenCalledTimes(1);
    expect(authorized.status).toBe(503);
    expect(authorized.body).toEqual({
      error: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
      message: 'Protected Backstage generation result is unavailable.',
    });
    expect(JSON.stringify(authorized.body)).not.toContain(
      (output as { sealedPayload: { ciphertext: string } }).sealedPayload.ciphertext
    );
  });

  it('preserves a valid large queued Backstage storyline result admitted before execution', async () => {
    const beats = buildLargeStorylineBeats();
    expect(Buffer.byteLength(JSON.stringify(beats), 'utf8')).toBeGreaterThan(256 * 1024);
    expect(beats.every(
      (beat) => Buffer.byteLength(JSON.stringify(beat), 'utf8') <= BACKSTAGE_STORYLINE_MAX_BYTES
    )).toBe(true);

    getJobByIdMock.mockResolvedValue({
      id: STORYLINE_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-08-05T10:00:00.000Z',
      updated_at: '2026-08-05T10:01:00.000Z',
      completed_at: '2026-08-05T10:01:00.000Z',
      retention_until: '2026-08-06T10:01:00.000Z',
      idempotency_until: '2026-08-06T10:01:00.000Z',
      expires_at: null,
      error_message: null,
      input: {
        gptId: 'backstage',
        body: {
          action: 'trackStoryline',
          payload: { sequence: 25, summary: 'Close the current rivalry chapter.' },
        },
        requestPath: '/gpt/backstage',
        executionModeReason: 'explicit_async_request',
        backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
          action: 'trackStoryline',
          principalId: 'operator:storyline-job-test',
        }),
      },
      output: {
        ok: true,
        result: beats,
        _route: {
          gptId: 'backstage',
          module: 'BACKSTAGE:BOOKER',
          route: 'backstage-booker',
          action: 'trackStoryline',
          timestamp: '2026-08-05T10:01:00.000Z',
        },
      },
      cancel_requested_at: null,
      cancel_reason: null,
    });

    const response = await getWithJobReadToken(
      `/jobs/${STORYLINE_JOB_ID}/result`,
      STORYLINE_JOB_ID
    );

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(Number(response.headers['x-response-bytes'])).toBeGreaterThan(256 * 1024);
    expect(Number(response.headers['x-response-bytes'])).toBeLessThanOrEqual(512 * 1024);
    expect(response.body.result.result).toHaveLength(25);
    expect(response.body.result.result).toEqual(beats);
  });

  it('returns the same non-duplicating large Backstage storyline status over JSON and SSE', async () => {
    const beats = buildLargeStorylineBeats();
    expect(Buffer.byteLength(JSON.stringify(beats), 'utf8')).toBeGreaterThan(256 * 1024);
    expect(beats.every(
      (beat) => Buffer.byteLength(JSON.stringify(beat), 'utf8') <= BACKSTAGE_STORYLINE_MAX_BYTES
    )).toBe(true);

    const storylineJob = {
      id: STORYLINE_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-08-05T10:00:00.000Z',
      updated_at: '2026-08-05T10:01:00.000Z',
      completed_at: '2026-08-05T10:01:00.000Z',
      retention_until: '2026-08-06T10:01:00.000Z',
      idempotency_until: '2026-08-06T10:01:00.000Z',
      expires_at: null,
      error_message: null,
      input: {
        gptId: 'backstage',
        body: {
          action: 'trackStoryline',
          payload: { sequence: 25, summary: 'Close the current rivalry chapter.' },
        },
        requestPath: '/gpt/backstage',
        executionModeReason: 'explicit_async_request',
        backstageMutationAdmission: buildQueuedGptBackstageMutationAdmission({
          action: 'trackStoryline',
          principalId: 'operator:storyline-job-test',
        }),
      },
      output: {
        ok: true,
        result: beats,
        _route: {
          gptId: 'backstage',
          module: 'BACKSTAGE:BOOKER',
          route: 'backstage-booker',
          action: 'trackStoryline',
          timestamp: '2026-08-05T10:01:00.000Z',
        },
      },
      cancel_requested_at: null,
      cancel_reason: null,
    };
    getJobByIdMock.mockResolvedValue(storylineJob);

    const statusResponse = await getWithJobReadToken(
      `/jobs/${STORYLINE_JOB_ID}`,
      STORYLINE_JOB_ID
    );
    const streamResponse = await getWithJobReadToken(
      `/jobs/${STORYLINE_JOB_ID}/stream`,
      STORYLINE_JOB_ID
    );

    expect(statusResponse.status).toBe(200);
    expectNoStore(statusResponse, streamResponse);
    expect(statusResponse.headers['x-response-truncated']).toBeUndefined();
    expect(Number(statusResponse.headers['x-response-bytes'])).toBeGreaterThan(256 * 1024);
    expect(Number(statusResponse.headers['x-response-bytes'])).toBeLessThanOrEqual(512 * 1024);
    expect(statusResponse.body.output).toBeNull();
    expect(statusResponse.body.result.result).toEqual(beats);

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers['content-type']).toContain('text/event-stream');
    const terminalBlock = streamResponse.text
      .split('\n\n')
      .find((block) => block.startsWith('event: terminal\n'));
    expect(terminalBlock).toBeDefined();
    const terminalData = JSON.parse(
      terminalBlock!.split('\n').find((line) => line.startsWith('data: '))!.slice(6)
    );
    expect(terminalData).toEqual(statusResponse.body);
    expect(terminalData.output).toBeNull();
    expect(terminalData.result.result).toEqual(beats);
    expect(getJobByIdMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('returns an explicit not_found payload for the canonical result route', async () => {
    getJobByIdMock.mockResolvedValue(null);

    const response = await getWithJobReadToken(
      `/jobs/${MISSING_JOB_ID}/result`,
      MISSING_JOB_ID
    );

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      jobId: MISSING_JOB_ID,
      status: 'not_found',
      jobStatus: null,
      lifecycleStatus: 'not_found',
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      retentionUntil: null,
      idempotencyUntil: null,
      expiresAt: null,
      poll: `/jobs/${MISSING_JOB_ID}/result`,
      stream: `/jobs/${MISSING_JOB_ID}/stream`,
      result: null,
      error: {
        code: 'JOB_NOT_FOUND',
        message: 'Async GPT job was not found.'
      }
    });
  });

  it('returns a pending polling payload for unfinished canonical result lookups', async () => {
    getJobByIdMock.mockResolvedValue({
      id: RUNNING_JOB_ID,
      job_type: 'gpt',
      status: 'running',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:15.000Z',
      completed_at: null,
      retention_until: null,
      idempotency_until: '2026-04-06T11:00:00.000Z',
      expires_at: '2026-04-06T12:00:00.000Z',
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });

    const response = await getWithJobReadToken(
      `/jobs/${RUNNING_JOB_ID}/result`,
      RUNNING_JOB_ID
    );

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      jobId: RUNNING_JOB_ID,
      status: 'pending',
      jobStatus: 'running',
      lifecycleStatus: 'running',
      createdAt: '2026-04-06T10:00:00.000Z',
      updatedAt: '2026-04-06T10:00:15.000Z',
      completedAt: null,
      retentionUntil: null,
      idempotencyUntil: '2026-04-06T11:00:00.000Z',
      expiresAt: '2026-04-06T12:00:00.000Z',
      poll: `/jobs/${RUNNING_JOB_ID}/result`,
      stream: `/jobs/${RUNNING_JOB_ID}/stream`,
      result: null,
      error: null
    });
  });

  it('rejects whitespace-only job identifiers for the canonical result route', async () => {
    const response = await request(buildApp()).get('/jobs/%20/result');

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual({
      error: 'JOB_ID_INVALID'
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it.each([
    ['status', '/jobs/abc123'],
    ['result', '/jobs/abc123/result'],
  ])('rejects malformed job identifiers on the %s route before hitting the repository', async (_routeKind, path) => {
    const response = await request(buildApp()).get(path);

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      error: 'JOB_ID_INVALID'
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it('makes missing, malformed, and cross-job read capabilities indistinguishable from missing jobs without repository access', async () => {
    const missingStatus = await request(buildApp())
      .get(`/jobs/${COMPLETED_JOB_ID}`);
    const malformedResult = await request(buildApp())
      .get(`/jobs/${COMPLETED_JOB_ID}/result`)
      .set(JOB_READ_CAPABILITY_HEADER_NAME, 'not-a-valid-token');
    const crossJobStream = await request(buildApp())
      .get(`/jobs/${COMPLETED_JOB_ID}/stream`)
      .set(
        JOB_READ_CAPABILITY_HEADER_NAME,
        issueJobReadCapability(MISSING_JOB_ID, JOB_READ_SECRET)
      );

    expectNoStore(missingStatus, malformedResult, crossJobStream);
    expect(missingStatus.status).toBe(404);
    expect(missingStatus.body).toEqual({ error: 'JOB_NOT_FOUND' });
    expect(malformedResult.status).toBe(200);
    expect(malformedResult.body).toMatchObject({
      jobId: COMPLETED_JOB_ID,
      status: 'not_found',
      result: null,
      error: {
        code: 'JOB_NOT_FOUND',
      },
    });
    expect(crossJobStream.status).toBe(404);
    expect(crossJobStream.body).toEqual({ error: 'JOB_NOT_FOUND' });
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it('fails capability-protected routes closed before repository access when configuration is unavailable', async () => {
    delete process.env.ARCANOS_JOB_READ_CAPABILITY_SECRET;

    const statusResponse = await request(buildApp())
      .get(`/jobs/${COMPLETED_JOB_ID}`)
      .set(
        JOB_READ_CAPABILITY_HEADER_NAME,
        issueJobReadCapability(COMPLETED_JOB_ID, JOB_READ_SECRET)
      );
    const resultResponse = await request(buildApp())
      .get(`/jobs/${COMPLETED_JOB_ID}/result`)
      .set(
        JOB_READ_CAPABILITY_HEADER_NAME,
        issueJobReadCapability(COMPLETED_JOB_ID, JOB_READ_SECRET)
      );
    const cancellationResponse = await request(buildApp())
      .post(`/jobs/${COMPLETED_JOB_ID}/cancel`)
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-1')
      .set(
        JOB_READ_CAPABILITY_HEADER_NAME,
        issueJobReadCapability(COMPLETED_JOB_ID, JOB_READ_SECRET)
      );

    expectNoStore(statusResponse, resultResponse, cancellationResponse);
    expect(statusResponse.status).toBe(503);
    expect(statusResponse.body).toEqual({
      error: 'JOB_READ_AUTH_UNAVAILABLE',
      message: 'Async job reads are temporarily unavailable.',
    });
    expect(resultResponse.status).toBe(503);
    expect(resultResponse.body).toEqual({
      error: 'JOB_READ_AUTH_UNAVAILABLE',
      message: 'Async job reads are temporarily unavailable.',
    });
    expect(cancellationResponse.status).toBe(503);
    expect(cancellationResponse.body).toEqual({
      error: 'JOB_READ_AUTH_UNAVAILABLE',
      message: 'Async job reads are temporarily unavailable.',
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it('rejects missing and cross-job cancellation capabilities before repository access', async () => {
    const missingCapability = await request(buildApp())
      .post(`/jobs/${RUNNING_JOB_ID}/cancel`)
      .set('x-session-id', 'owner-1');
    const crossJobCapability = await request(buildApp())
      .post(`/jobs/${RUNNING_JOB_ID}/cancel`)
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-1')
      .set(
        JOB_READ_CAPABILITY_HEADER_NAME,
        issueJobReadCapability(MISSING_JOB_ID, JOB_READ_SECRET)
      );

    expectNoStore(missingCapability, crossJobCapability);
    expect(missingCapability.status).toBe(404);
    expect(missingCapability.body).toEqual({ error: 'JOB_NOT_FOUND' });
    expect(missingCapability.body).toEqual({ error: 'JOB_NOT_FOUND' });
    expect(crossJobCapability.status).toBe(404);
    expect(crossJobCapability.body).toEqual({ error: 'JOB_NOT_FOUND' });
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only job identifiers for cancellation through the guarded response path', async () => {
    const response = await request(buildApp())
      .post('/jobs/%20/cancel')
      .set('x-confirmed', 'yes');

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.headers['x-response-truncated']).toBeUndefined();
    expect(response.body).toEqual({
      error: 'JOB_ID_INVALID'
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('keeps confirmation failures no-store before cancellation repository access', async () => {
    const response = await postWithJobReadToken(
      `/jobs/${RUNNING_JOB_ID}/cancel`,
      RUNNING_JOB_ID
    );

    expect(response.status).toBe(403);
    expectNoStore(response);
    expect(response.body).toMatchObject({
      code: 'CONFIRMATION_REQUIRED'
    });
    expect(getJobByIdMock).not.toHaveBeenCalled();
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('returns lifecycle metadata for job polling responses', async () => {
    getJobByIdMock.mockResolvedValue({
      id: EXPIRED_JOB_ID,
      job_type: 'gpt',
      status: 'expired',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:05:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      error_message: 'Expired after retention window.',
      output: null,
      retention_until: '2026-04-06T10:04:00.000Z',
      idempotency_until: '2026-04-06T10:03:00.000Z',
      expires_at: '2026-04-06T10:05:00.000Z',
      cancel_requested_at: null,
      cancel_reason: null
    });

    const response = await getWithJobReadToken(
      `/jobs/${EXPIRED_JOB_ID}`,
      EXPIRED_JOB_ID
    );

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      id: EXPIRED_JOB_ID,
      jobId: EXPIRED_JOB_ID,
      status: 'expired',
      lifecycle_status: 'expired',
      poll: `/jobs/${EXPIRED_JOB_ID}/result`,
      stream: `/jobs/${EXPIRED_JOB_ID}/stream`,
      retention_until: '2026-04-06T10:04:00.000Z',
      idempotency_until: '2026-04-06T10:03:00.000Z',
      expires_at: '2026-04-06T10:05:00.000Z'
    });
  });

  it('hides local-agent status and result records exactly like missing jobs', async () => {
    const localAgentJob = {
      id: LOCAL_AGENT_JOB_ID,
      job_type: 'local-agent',
      status: 'completed',
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:01:00.000Z',
      completed_at: '2026-07-24T10:01:00.000Z',
      error_message: null,
      output: {
        stdout: 'private local-agent output'
      },
      cancel_requested_at: null,
      cancel_reason: null
    };

    getJobByIdMock
      .mockResolvedValueOnce(localAgentJob)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(localAgentJob)
      .mockResolvedValueOnce(null);

    const localStatus = await getWithJobReadToken(
      `/jobs/${LOCAL_AGENT_JOB_ID}`,
      LOCAL_AGENT_JOB_ID
    );
    const missingStatus = await getWithJobReadToken(
      `/jobs/${LOCAL_AGENT_JOB_ID}`,
      LOCAL_AGENT_JOB_ID
    );
    const localResult = await getWithJobReadToken(
      `/jobs/${LOCAL_AGENT_JOB_ID}/result`,
      LOCAL_AGENT_JOB_ID
    );
    const missingResult = await getWithJobReadToken(
      `/jobs/${LOCAL_AGENT_JOB_ID}/result`,
      LOCAL_AGENT_JOB_ID
    );

    expect(localStatus.status).toBe(404);
    expect(localStatus.body).toEqual(missingStatus.body);
    expect(localResult.status).toBe(200);
    expect(localResult.body).toEqual(missingResult.body);
    expect(JSON.stringify(localResult.body)).not.toContain('private local-agent output');
  });

  it('hides dag-node status and result details before public serialization', async () => {
    const privateDagNodeOutput = 'PRIVATE_DAG_NODE_OUTPUT_SENTINEL';
    const dagNodeJob = {
      id: DAG_NODE_JOB_ID,
      job_type: 'dag-node',
      status: 'completed',
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:01:00.000Z',
      completed_at: '2026-07-24T10:01:00.000Z',
      error_message: 'PRIVATE_DAG_NODE_ERROR_SENTINEL',
      output: {
        result: privateDagNodeOutput
      },
      cancel_requested_at: null,
      cancel_reason: null
    };
    getJobByIdMock
      .mockResolvedValueOnce(dagNodeJob)
      .mockResolvedValueOnce(dagNodeJob)
      .mockResolvedValueOnce(dagNodeJob);

    const statusResponse = await getWithJobReadToken(
      `/jobs/${DAG_NODE_JOB_ID}`,
      DAG_NODE_JOB_ID
    );
    const resultResponse = await getWithJobReadToken(
      `/jobs/${DAG_NODE_JOB_ID}/result`,
      DAG_NODE_JOB_ID
    );
    const cancellationResponse = await postWithJobReadToken(
      `/jobs/${DAG_NODE_JOB_ID}/cancel`,
      DAG_NODE_JOB_ID
    )
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-1');

    expect(statusResponse.status).toBe(404);
    expect(statusResponse.body).toEqual({ error: 'JOB_NOT_FOUND' });
    expect(resultResponse.status).toBe(200);
    expect(resultResponse.body).toMatchObject({
      jobId: DAG_NODE_JOB_ID,
      status: 'not_found',
      result: null,
      error: {
        code: 'JOB_NOT_FOUND'
      }
    });
    expect(cancellationResponse.status).toBe(404);
    expect(cancellationResponse.body).toEqual({ error: 'JOB_NOT_FOUND' });
    const serialized = JSON.stringify({
      status: statusResponse.body,
      result: resultResponse.body,
      cancellation: cancellationResponse.body,
    });
    expect(serialized).not.toContain('dag-node');
    expect(serialized).not.toContain(privateDagNodeOutput);
    expect(serialized).not.toContain('PRIVATE_DAG_NODE_ERROR_SENTINEL');
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('hides protected GPT Access jobs even with a mathematically valid generic capability', async () => {
    const protectedResultSentinel = 'PROTECTED_GPT_ACCESS_RESULT_SENTINEL';
    const protectedErrorSentinel = 'PROTECTED_GPT_ACCESS_ERROR_SENTINEL';
    const protectedJob = {
      id: GPT_ACCESS_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      input: {
        requestPath: '/gpt-access/jobs/create',
        executionModeReason: 'gpt_access_create_ai_job',
      },
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:01:00.000Z',
      completed_at: '2026-07-24T10:01:00.000Z',
      error_message: protectedErrorSentinel,
      output: {
        result: protectedResultSentinel,
      },
      cancel_requested_at: null,
      cancel_reason: null,
    };
    getJobByIdMock
      .mockResolvedValueOnce(protectedJob)
      .mockResolvedValueOnce(protectedJob)
      .mockResolvedValueOnce(protectedJob)
      .mockResolvedValueOnce(protectedJob);

    const statusResponse = await getWithJobReadToken(
      `/jobs/${GPT_ACCESS_JOB_ID}`,
      GPT_ACCESS_JOB_ID
    );
    const resultResponse = await getWithJobReadToken(
      `/jobs/${GPT_ACCESS_JOB_ID}/result`,
      GPT_ACCESS_JOB_ID
    );
    const streamResponse = await getWithJobReadToken(
      `/jobs/${GPT_ACCESS_JOB_ID}/stream`,
      GPT_ACCESS_JOB_ID
    );
    const cancellationResponse = await postWithJobReadToken(
      `/jobs/${GPT_ACCESS_JOB_ID}/cancel`,
      GPT_ACCESS_JOB_ID
    )
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-1');

    expect(statusResponse.status).toBe(404);
    expect(resultResponse.status).toBe(200);
    expect(resultResponse.body).toMatchObject({
      jobId: GPT_ACCESS_JOB_ID,
      status: 'not_found',
      result: null,
    });
    expect(streamResponse.status).toBe(404);
    expect(cancellationResponse.status).toBe(404);
    const serialized = JSON.stringify({
      status: statusResponse.body,
      result: resultResponse.body,
      stream: streamResponse.body,
      cancellation: cancellationResponse.body,
    });
    expect(serialized).not.toContain(protectedResultSentinel);
    expect(serialized).not.toContain(protectedErrorSentinel);
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('hides local-agent streams exactly like missing jobs', async () => {
    const localAgentJob = {
      id: LOCAL_AGENT_JOB_ID,
      job_type: 'local-agent',
      status: 'running',
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:01:00.000Z',
      completed_at: null,
      error_message: null,
      output: {
        stdout: 'private local-agent output'
      },
      cancel_requested_at: null,
      cancel_reason: null
    };
    getJobByIdMock
      .mockResolvedValueOnce(localAgentJob)
      .mockResolvedValueOnce(null);

    const localStream = await getWithJobReadToken(
      `/jobs/${LOCAL_AGENT_JOB_ID}/stream`,
      LOCAL_AGENT_JOB_ID
    );
    const missingStream = await getWithJobReadToken(
      `/jobs/${LOCAL_AGENT_JOB_ID}/stream`,
      LOCAL_AGENT_JOB_ID
    );

    expect(localStream.status).toBe(404);
    expect(localStream.body).toEqual(missingStream.body);
    expect(JSON.stringify(localStream.body)).not.toContain('private local-agent output');
  });

  it('hides local-agent cancellation records exactly like missing jobs', async () => {
    const localAgentJob = {
      id: LOCAL_AGENT_JOB_ID,
      job_type: 'local-agent',
      status: 'running',
      idempotency_scope_hash: hashActorKey('session:owner-1'),
      created_at: '2026-07-24T10:00:00.000Z',
      updated_at: '2026-07-24T10:01:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    };
    getJobByIdMock
      .mockResolvedValueOnce(localAgentJob)
      .mockResolvedValueOnce(null);

    const localCancellation = await postWithJobReadToken(
      `/jobs/${LOCAL_AGENT_JOB_ID}/cancel`,
      LOCAL_AGENT_JOB_ID
    )
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-1');
    const missingCancellation = await postWithJobReadToken(
      `/jobs/${LOCAL_AGENT_JOB_ID}/cancel`,
      LOCAL_AGENT_JOB_ID
    )
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'owner-1');

    expect(localCancellation.status).toBe(404);
    expect(localCancellation.body).toEqual(missingCancellation.body);
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('rejects anonymous cancellation requests', async () => {
    getJobByIdMock.mockResolvedValue({
      id: EXPIRED_JOB_ID,
      job_type: 'gpt',
      status: 'expired',
      idempotency_scope_hash: hashActorKey('anonymous-request:unrecoverable'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });
    const response = await postWithJobReadToken(
      `/jobs/${EXPIRED_JOB_ID}/cancel`,
      EXPIRED_JOB_ID
    )
      .set('x-confirmed', 'yes')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(401);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'JOB_CANCELLATION_AUTH_REQUIRED',
        message: 'Job cancellation requires an established authenticated principal or internal actor.'
      }
    });
    expect(getJobByIdMock).toHaveBeenCalledTimes(1);
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('rejects cancellation for the wrong authenticated owner', async () => {
    getJobByIdMock.mockResolvedValue({
      id: RUNNING_JOB_ID,
      job_type: 'gpt',
      status: 'running',
      idempotency_scope_hash: hashActorKey('user:1'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });

    const response = await postWithJobReadToken(
      `/jobs/${RUNNING_JOB_ID}/cancel`,
      RUNNING_JOB_ID,
      2
    )
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'caller-selected-session')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(403);
    expectNoStore(response);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'JOB_CANCELLATION_FORBIDDEN',
        message: 'The current caller does not own this job.'
      }
    });
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('cancels queued jobs immediately for the matching authenticated owner despite session input', async () => {
    getJobByIdMock.mockResolvedValue({
      id: QUEUED_JOB_ID,
      job_type: 'gpt',
      status: 'pending',
      idempotency_scope_hash: hashActorKey('user:1'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'cancelled',
      job: {
        id: QUEUED_JOB_ID,
        job_type: 'gpt',
        status: 'cancelled',
        idempotency_scope_hash: hashActorKey('user:1'),
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: '2026-04-06T10:01:00.000Z',
        error_message: 'Job cancellation requested by client.',
        output: null,
        cancel_requested_at: '2026-04-06T10:01:00.000Z',
        cancel_reason: 'Stop this job'
      }
    });

    const response = await postWithJobReadToken(
      `/jobs/${QUEUED_JOB_ID}/cancel`,
      QUEUED_JOB_ID,
      1
    )
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'caller-selected-session')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: true,
      id: QUEUED_JOB_ID,
      status: 'cancelled',
      lifecycle_status: 'cancelled',
      cancellationRequested: false
    });
  });

  it('replaces private cancellation text before cancelling a protected Booker job', async () => {
    const privateCancellationReason = 'private-job-cancel-reason-sentinel';
    const protectedInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: { universeId: 'my-universe-2k26', prompt: 'private prompt' },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
    });
    const protectedJob = {
      id: PROTECTED_BOOKER_JOB_ID,
      job_type: 'gpt',
      status: 'pending',
      idempotency_scope_hash: hashActorKey('user:1'),
      input: protectedInput,
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null,
    };
    getJobByIdMock.mockResolvedValue(protectedJob);
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'cancelled',
      job: {
        ...protectedJob,
        status: 'cancelled',
        completed_at: '2026-04-06T10:01:00.000Z',
        cancel_requested_at: '2026-04-06T10:01:00.000Z',
        cancel_reason: 'Protected Backstage generation cancellation requested.',
      },
    });

    const response = await postWithJobReadToken(
      `/jobs/${PROTECTED_BOOKER_JOB_ID}/cancel`,
      PROTECTED_BOOKER_JOB_ID,
      1
    )
      .set('x-confirmed', 'yes')
      .send({ reason: privateCancellationReason });

    expect(response.status).toBe(200);
    expect(requestJobCancellationMock).toHaveBeenCalledWith(
      PROTECTED_BOOKER_JOB_ID,
      'Protected Backstage generation cancellation requested.'
    );
    expect(JSON.stringify(requestJobCancellationMock.mock.calls))
      .not.toContain(privateCancellationReason);
  });

  it('validates the action-secret carrier and ignores unrelated auth/session input for bridge cancellation', async () => {
    const bridgeActorKey = buildAuthenticatedCredentialActorKey(
      'custom-gpt-bridge',
      BRIDGE_SECRET
    );
    const bridgeInput = {
      requestPath: '/api/bridge/gpt',
      executionModeReason: 'bridge_query',
    };
    getJobByIdMock.mockResolvedValue({
      id: BRIDGE_JOB_ID,
      job_type: 'gpt',
      input: bridgeInput,
      status: 'pending',
      idempotency_scope_hash: hashActorKey(
        bridgeActorKey,
        'custom-gpt-bridge'
      ),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null,
    });
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'cancelled',
      job: {
        id: BRIDGE_JOB_ID,
        job_type: 'gpt',
        input: bridgeInput,
        status: 'cancelled',
        idempotency_scope_hash: hashActorKey(
          bridgeActorKey,
          'custom-gpt-bridge'
        ),
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: '2026-04-06T10:01:00.000Z',
        error_message: 'Job cancellation requested by client.',
        output: null,
        cancel_requested_at: '2026-04-06T10:01:00.000Z',
        cancel_reason: 'Stop this bridge job',
      },
    });

    const response = await postWithJobReadToken(
      `/jobs/${BRIDGE_JOB_ID}/cancel`,
      BRIDGE_JOB_ID
    )
      .set('x-confirmed', 'yes')
      .set('authorization', 'Basic attacker-selected-value')
      .set('x-openai-action-secret', BRIDGE_SECRET)
      .send({ reason: 'Stop this bridge job' });

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.body).toMatchObject({
      ok: true,
      id: BRIDGE_JOB_ID,
      status: 'cancelled',
    });
    expect(requestJobCancellationMock).toHaveBeenCalledWith(
      BRIDGE_JOB_ID,
      'Stop this bridge job'
    );
  });

  it('returns 202 when cancellation is requested for a running job', async () => {
    getJobByIdMock.mockResolvedValue({
      id: CANCEL_REQUEST_JOB_ID,
      job_type: 'gpt',
      status: 'running',
      idempotency_scope_hash: hashActorKey('user:2'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'cancellation_requested',
      job: {
        id: CANCEL_REQUEST_JOB_ID,
        job_type: 'gpt',
        status: 'running',
        idempotency_scope_hash: hashActorKey('user:2'),
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: null,
        error_message: null,
        output: null,
        cancel_requested_at: '2026-04-06T10:01:00.000Z',
        cancel_reason: 'Stop this job'
      }
    });

    const response = await postWithJobReadToken(
      `/jobs/${CANCEL_REQUEST_JOB_ID}/cancel`,
      CANCEL_REQUEST_JOB_ID,
      2
    )
      .set('x-confirmed', 'yes')
      .send({ reason: 'Stop this job' });

    expect(response.status).toBe(202);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: true,
      id: CANCEL_REQUEST_JOB_ID,
      status: 'running',
      lifecycle_status: 'running',
      cancellationRequested: true
    });
  });

  it('preserves terminal cancellation conflicts for the owning caller', async () => {
    getJobByIdMock.mockResolvedValue({
      id: TERMINAL_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      idempotency_scope_hash: hashActorKey('user:3'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      error_message: null,
      output: { ok: true },
      cancel_requested_at: null,
      cancel_reason: null
    });
    requestJobCancellationMock.mockResolvedValue({
      outcome: 'already_terminal',
      job: {
        id: TERMINAL_JOB_ID,
        job_type: 'gpt',
        status: 'completed',
        idempotency_scope_hash: hashActorKey('user:3'),
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: '2026-04-06T10:01:00.000Z',
        error_message: null,
        output: { ok: true },
        cancel_requested_at: null,
        cancel_reason: null
      }
    });

    const response = await postWithJobReadToken(
      `/jobs/${TERMINAL_JOB_ID}/cancel`,
      TERMINAL_JOB_ID,
      3
    )
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'caller-selected-session');

    expect(response.status).toBe(409);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'JOB_ALREADY_TERMINAL',
        message: 'Terminal jobs cannot be cancelled.'
      }
    });
  });

  it('preserves job lookup metadata when bounded result payloads are truncated', async () => {
    const previousMaxBytes = process.env.CLIENT_RESPONSE_MAX_BYTES;
    process.env.CLIENT_RESPONSE_MAX_BYTES = '2048';
    getJobByIdMock.mockResolvedValue({
      id: TRUNCATED_JOB_ID,
      job_type: 'gpt',
      status: 'completed',
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: '2026-04-06T10:01:00.000Z',
      retention_until: '2026-04-07T10:01:00.000Z',
      idempotency_until: '2026-04-07T10:01:00.000Z',
      expires_at: null,
      error_message: null,
      output: {
        ok: true,
        result: {
          answer: 'x'.repeat(16_000)
        }
      },
      cancel_requested_at: null,
      cancel_reason: null
    });

    try {
      const response = await getWithJobReadToken(
        `/jobs/${TRUNCATED_JOB_ID}/result`,
        TRUNCATED_JOB_ID
      );

      expect(response.status).toBe(200);
      expectNoStore(response);
      expect(response.headers['x-response-bytes']).toBeTruthy();
      expect(response.headers['x-response-truncated']).toBe('true');
      expect(Number(response.headers['x-response-bytes'])).toBeLessThanOrEqual(2048);
      expect(response.body).toMatchObject({
        jobId: TRUNCATED_JOB_ID,
        status: 'completed',
        jobStatus: 'completed',
        lifecycleStatus: 'completed',
        poll: `/jobs/${TRUNCATED_JOB_ID}/result`,
        stream: `/jobs/${TRUNCATED_JOB_ID}/stream`,
        truncated: true,
        result: expect.stringContaining('[truncated]')
      });
      expect(response.body.error).toBeNull();
    } finally {
      if (previousMaxBytes === undefined) {
        delete process.env.CLIENT_RESPONSE_MAX_BYTES;
      } else {
        process.env.CLIENT_RESPONSE_MAX_BYTES = previousMaxBytes;
      }
    }
  });

  it.each([
    ['status', `/jobs/${RUNNING_JOB_ID}`],
    ['result', `/jobs/${RUNNING_JOB_ID}/result`],
    ['cancellation', `/jobs/${RUNNING_JOB_ID}/cancel`]
  ])('returns 503 when the repository is unavailable during the %s lookup', async (routeKind, path) => {
    getJobByIdMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('internal database sentinel')
    );

    const response = routeKind === 'cancellation'
      ? await postWithJobReadToken(path, RUNNING_JOB_ID)
          .set('x-confirmed', 'yes')
          .set('x-session-id', 'owner-1')
      : await getWithJobReadToken(path, RUNNING_JOB_ID);

    expect(response.status).toBe(503);
    expectNoStore(response);
    expect(response.headers['x-response-bytes']).toBeTruthy();
    expect(response.body).toEqual({
      error: 'JOB_REPOSITORY_UNAVAILABLE'
    });
    expect(JSON.stringify(response.body)).not.toContain('internal database sentinel');
    expect(requestJobCancellationMock).not.toHaveBeenCalled();
  });

  it('returns 503 when cancellation persistence becomes unavailable after ownership lookup', async () => {
    getJobByIdMock.mockResolvedValue({
      id: RUNNING_JOB_ID,
      job_type: 'gpt',
      status: 'running',
      idempotency_scope_hash: hashActorKey('user:1'),
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:01:00.000Z',
      completed_at: null,
      error_message: null,
      output: null,
      cancel_requested_at: null,
      cancel_reason: null
    });
    requestJobCancellationMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('internal cancellation sentinel')
    );

    const response = await postWithJobReadToken(
      `/jobs/${RUNNING_JOB_ID}/cancel`,
      RUNNING_JOB_ID,
      1
    )
      .set('x-confirmed', 'yes')
      .set('x-session-id', 'caller-selected-session');

    expect(response.status).toBe(503);
    expectNoStore(response);
    expect(response.body).toEqual({
      error: 'JOB_REPOSITORY_UNAVAILABLE'
    });
    expect(JSON.stringify(response.body)).not.toContain('internal cancellation sentinel');
    expect(requestJobCancellationMock).toHaveBeenCalledTimes(1);
  });

  it('returns JSON 503 when the repository is unavailable before a job stream starts', async () => {
    getJobByIdMock.mockRejectedValue(
      new MockJobRepositoryUnavailableError('internal stream sentinel')
    );

    const response = await getWithJobReadToken(
      `/jobs/${RUNNING_JOB_ID}/stream`,
      RUNNING_JOB_ID
    );

    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(response.body).toEqual({
      error: 'JOB_REPOSITORY_UNAVAILABLE'
    });
    expect(JSON.stringify(response.body)).not.toContain('internal stream sentinel');
  });

  it('emits a sanitized SSE error when the repository becomes unavailable midstream', async () => {
    getJobByIdMock
      .mockResolvedValueOnce({
        id: RUNNING_JOB_ID,
        job_type: 'gpt',
        status: 'running',
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: null,
        error_message: null,
        output: null,
        cancel_requested_at: null,
        cancel_reason: null
      })
      .mockRejectedValueOnce(
        new MockJobRepositoryUnavailableError('internal stream sentinel')
      );

    const response = await getWithJobReadToken(
      `/jobs/${RUNNING_JOB_ID}/stream`,
      RUNNING_JOB_ID
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['cache-control']).toContain('no-cache');
    expect(response.headers['cache-control']).toContain('no-transform');
    expect(response.text).toContain('event: status');
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('"code":"JOB_REPOSITORY_UNAVAILABLE"');
    expect(response.text).not.toContain('internal stream sentinel');
    expect(getJobByIdMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a genuine midstream missing job distinct from a repository outage', async () => {
    getJobByIdMock
      .mockResolvedValueOnce({
        id: RUNNING_JOB_ID,
        job_type: 'gpt',
        status: 'running',
        created_at: '2026-04-06T10:00:00.000Z',
        updated_at: '2026-04-06T10:01:00.000Z',
        completed_at: null,
        error_message: null,
        output: null,
        cancel_requested_at: null,
        cancel_reason: null
      })
      .mockResolvedValueOnce(null);

    const response = await getWithJobReadToken(
      `/jobs/${RUNNING_JOB_ID}/stream`,
      RUNNING_JOB_ID
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: status');
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('"code":"JOB_NOT_FOUND"');
    expect(response.text).not.toContain('JOB_REPOSITORY_UNAVAILABLE');
    expect(getJobByIdMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });
});

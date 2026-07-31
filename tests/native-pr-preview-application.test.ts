import { describe, expect, it } from '@jest/globals';
import request from 'supertest';

import {
  createNativePrPreviewApplication,
  createNativePrPreviewReadinessState,
} from '../src/nativePrPreviewApplication.js';
import {
  NATIVE_PR_PREVIEW_FIXTURE_IDS,
  NATIVE_PR_PREVIEW_MODE,
} from '../src/nativePrPreviewContract.js';
import {
  resolveNativePrPreviewChildEnvironment,
} from '../src/start-native-pr-preview.js';

const identity = {
  prNumber: 1413,
  sourceCommit: 'a'.repeat(40),
};
const FIXTURE_CREATED_AT = '2026-07-30T00:00:00.000Z';
const FIXTURE_COMPLETED_AT = '2026-07-30T00:00:01.000Z';

function expectedJobLinks(jobId: string) {
  return {
    poll: `/jobs/${jobId}/result`,
    stream: `/jobs/${jobId}/stream`,
  };
}

function expectedStatusBody(
  jobId: string,
  status: 'cancelled' | 'completed' | 'failed' | 'pending',
  options: {
    answer?: string;
    cancelReason?: string;
    errorMessage?: string;
  } = {}
) {
  const terminal = status !== 'pending';
  const result = options.answer === undefined
    ? null
    : { ok: true, result: { answer: options.answer } };
  return {
    id: jobId,
    jobId,
    job_type: 'gpt',
    status,
    lifecycle_status: status === 'pending' ? 'queued' : status,
    created_at: FIXTURE_CREATED_AT,
    updated_at: terminal ? FIXTURE_COMPLETED_AT : FIXTURE_CREATED_AT,
    completed_at: terminal ? FIXTURE_COMPLETED_AT : null,
    cancel_requested_at:
      status === 'cancelled' ? FIXTURE_COMPLETED_AT : null,
    cancel_reason: options.cancelReason ?? null,
    retention_until: null,
    idempotency_until: null,
    expires_at: null,
    ...expectedJobLinks(jobId),
    error_message: options.errorMessage ?? null,
    output: result,
    result,
  };
}

function expectedResultBody(
  jobId: string,
  status: 'completed' | 'failed' | 'pending',
  options: {
    answer?: string;
    error?: object;
  } = {}
) {
  const terminal = status !== 'pending';
  return {
    jobId,
    status,
    jobStatus: status,
    lifecycleStatus: status === 'pending' ? 'queued' : status,
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: terminal ? FIXTURE_COMPLETED_AT : FIXTURE_CREATED_AT,
    completedAt: terminal ? FIXTURE_COMPLETED_AT : null,
    retentionUntil: null,
    idempotencyUntil: null,
    expiresAt: null,
    ...expectedJobLinks(jobId),
    result: options.answer === undefined
      ? null
      : { ok: true, result: { answer: options.answer } },
    error: options.error ?? null,
  };
}

function buildApplication() {
  const readinessState = createNativePrPreviewReadinessState();
  const app = createNativePrPreviewApplication({
    identity,
    readinessState,
  });
  readinessState.applicationImported = true;
  readinessState.fixturesSealed = true;
  readinessState.ready = true;
  return { app, readinessState };
}

function expectNoStore(response: { headers: Record<string, string | undefined> }): void {
  expect(response.headers['cache-control']).toContain('no-store');
}

describe('native PR contained application', () => {
  it('accepts only the exact credential-empty child environment', () => {
    const childEnvironment = {
      ARCANOS_NATIVE_PR_APPLICATION_PREVIEW: 'v1',
      ARCANOS_PREVIEW_PR_NUMBER: '1413',
      ARCANOS_PREVIEW_SOURCE_COMMIT: 'a'.repeat(40),
      ARCANOS_PROCESS_KIND: 'web',
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      PORT: '8080',
      RUN_WORKERS: 'false',
      TZ: 'UTC',
    };

    expect(resolveNativePrPreviewChildEnvironment(childEnvironment)).toEqual({
      host: '0.0.0.0',
      port: 8080,
      prNumber: 1413,
      sourceCommit: 'a'.repeat(40),
    });
    expect(() => resolveNativePrPreviewChildEnvironment({
      ...childEnvironment,
      DATABASE_URL: 'postgresql://sensitive-sentinel.invalid/database',
    })).toThrow('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
    expect(() => resolveNativePrPreviewChildEnvironment({
      ...childEnvironment,
      NODE_OPTIONS: '--import=./sensitive-sentinel.mjs',
    })).toThrow('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
    expect(() => resolveNativePrPreviewChildEnvironment({
      ...childEnvironment,
      CUSTOM_SECRET: 'sensitive-sentinel',
    })).toThrow('PREVIEW_APPLICATION_ENVIRONMENT_INVALID');
  });

  it('advertises an explicit trusted-PR containment scope and exact source identity', async () => {
    const { app } = buildApplication();

    const response = await request(app).get('/readyz');

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.body).toEqual({
      applicationImported: true,
      fixturesSealed: true,
      mode: NATIVE_PR_PREVIEW_MODE,
      prNumber: 1413,
      processKind: 'web',
      protectedEffectsEnabled: false,
      protectsMaliciousPr: false,
      ready: true,
      requiresPlatformSecretIsolationForUntrustedCode: true,
      sourceCommit: 'a'.repeat(40),
      trustScope: 'trusted-pr-accidental-effects',
    });
  });

  it('returns 503 readiness until import and fixture sealing are complete and while draining', async () => {
    const readinessState = createNativePrPreviewReadinessState();
    const app = createNativePrPreviewApplication({ identity, readinessState });

    const pending = await request(app).get('/readyz');
    expect(pending.status).toBe(503);
    expectNoStore(pending);

    readinessState.applicationImported = true;
    readinessState.fixturesSealed = true;
    readinessState.ready = true;
    expect((await request(app).get('/readyz')).status).toBe(200);

    readinessState.draining = true;
    readinessState.ready = false;
    const draining = await request(app).get('/readyz');
    expect(draining.status).toBe(503);
    expectNoStore(draining);
  });

  it('executes the real generic job handlers against immutable synthetic fixtures', async () => {
    const { app } = buildApplication();
    const completedStatus = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.completed}`);
    const completedResult = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.completed}/result`);
    const failedResult = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.failed}/result`);
    const invalid = await request(app).get('/jobs/not-a-uuid');
    const invalidResult = await request(app).get('/jobs/not-a-uuid/result');
    const invalidCancellation = await request(app)
      .post('/jobs/not-a-uuid/cancel')
      .send({ reason: 'bounded preview check' });
    const missing = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.missing}`);
    const unavailable = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.repositoryUnavailable}`);
    const authUnavailable = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.authUnavailable}`);
    const unauthorized = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.unauthorized}`);

    expect(completedStatus.status).toBe(200);
    expect(completedStatus.body).toEqual(expectedStatusBody(
      NATIVE_PR_PREVIEW_FIXTURE_IDS.completed,
      'completed',
      { answer: 'synthetic preview result' }
    ));
    expect(completedResult.status).toBe(200);
    expect(completedResult.body).toEqual(expectedResultBody(
      NATIVE_PR_PREVIEW_FIXTURE_IDS.completed,
      'completed',
      { answer: 'synthetic preview result' }
    ));
    expect(failedResult.status).toBe(200);
    expect(failedResult.body).toEqual(expectedResultBody(
      NATIVE_PR_PREVIEW_FIXTURE_IDS.failed,
      'failed',
      {
        error: {
          code: 'JOB_FAILED',
          message: 'Synthetic preview failure.',
          details: {
            lifecycleStatus: 'failed',
            jobStatus: 'failed',
            resultRetained: false,
          },
        },
      }
    ));
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'JOB_ID_INVALID' });
    expect(invalidResult.status).toBe(400);
    expect(invalidResult.body).toEqual({ error: 'JOB_ID_INVALID' });
    expect(invalidCancellation.status).toBe(400);
    expect(invalidCancellation.body).toEqual({ error: 'JOB_ID_INVALID' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'JOB_NOT_FOUND' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ error: 'JOB_REPOSITORY_UNAVAILABLE' });
    expect(authUnavailable.status).toBe(503);
    expect(authUnavailable.body).toEqual({
      error: 'JOB_READ_AUTH_UNAVAILABLE',
      message: 'Async job reads are temporarily unavailable.',
    });
    expect(unauthorized.status).toBe(404);
    expect(unauthorized.body).toEqual({ error: 'JOB_NOT_FOUND' });
    [
      completedStatus,
      completedResult,
      failedResult,
      invalid,
      invalidResult,
      invalidCancellation,
      missing,
      unavailable,
      authUnavailable,
      unauthorized,
    ].forEach(expectNoStore);
  });

  it('keeps synthetic cancellation deterministic across repeated runs', async () => {
    const { app } = buildApplication();
    const cancellationPath =
      `/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable}/cancel`;
    const first = await request(app)
      .post(cancellationPath)
      .send({ reason: 'bounded preview check' });
    const second = await request(app)
      .post(cancellationPath)
      .send({ reason: 'bounded preview check' });
    const terminal = await request(app)
      .post(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal}/cancel`)
      .send({ reason: 'bounded preview check' });
    const unavailable = await request(app)
      .post(
        `/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable}/cancel`
      )
      .send({ reason: 'bounded preview check' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({
      ok: true,
      cancellationRequested: false,
      ...expectedStatusBody(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable,
        'cancelled',
        { cancelReason: 'Synthetic preview cancellation.' }
      ),
    });
    expect(second.body).toEqual(first.body);
    expect(terminal.status).toBe(409);
    expect(terminal.body).toEqual({
      ok: false,
      error: {
        code: 'JOB_ALREADY_TERMINAL',
        message: 'Terminal jobs cannot be cancelled.',
      },
      job: expectedStatusBody(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal,
        'completed',
        { answer: 'synthetic terminal result' }
      ),
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({
      error: 'JOB_REPOSITORY_UNAVAILABLE',
    });
    [first, second, terminal, unavailable].forEach(expectNoStore);
  });

  it.each([
    ['GET', '/'],
    ['GET', '/gpt/arcanos-core'],
    ['POST', '/memory/save'],
    ['GET', '/metrics'],
    ['GET', '/jobs/11111111-1111-4111-8111-111111111111/stream'],
    ['OPTIONS', '/readyz'],
    ['GET', '/readyz?verbose=true'],
    ['GET', '/health%2fextra'],
  ])('denies every unlisted method/path before application routing: %s %s', async (method, path) => {
    const { app } = buildApplication();
    const response = await request(app)[method.toLowerCase() as 'get'](path);

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found');
    expectNoStore(response);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['authorization', 'Bearer sensitive-sentinel'],
    ['cookie', 'session=sensitive-sentinel'],
    ['x-session-id', 'sensitive-sentinel'],
    ['x-arcanos-job-read-token', 'sensitive-sentinel'],
    ['x-openai-action-secret', 'sensitive-sentinel'],
  ])('rejects external credential carrier %s without reflecting it', async (headerName, headerValue) => {
    const { app } = buildApplication();
    const response = await request(app)
      .get(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.completed}`)
      .set(headerName, headerValue);

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found');
    expect(response.text).not.toContain(headerValue);
    expectNoStore(response);
  });

  it.each([
    ['text/plain', 'non-json cancellation body'],
    ['application/octet-stream', 'opaque cancellation body'],
  ])('rejects non-JSON cancellation bodies before routing: %s', async (
    contentType,
    body
  ) => {
    const { app } = buildApplication();
    const response = await request(app)
      .post(`/jobs/${NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable}/cancel`)
      .set('content-type', contentType)
      .send(body);

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found');
    expectNoStore(response);
  });

  it('rejects bodies on read-only routes before routing', async () => {
    const { app } = buildApplication();
    const response = await request(app)
      .get('/readyz')
      .set('content-type', 'application/json')
      .send({ unexpected: true });

    expect(response.status).toBe(404);
    expect(response.text).toBe('not found');
    expectNoStore(response);
  });
});

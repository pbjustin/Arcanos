import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'dispatch-error-token-12345678901234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

const mockRouteGptRequest = jest.fn();
const mockCreateDagRun = jest.fn();
const requestErrorLoggerMock = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: mockRouteGptRequest
}));

jest.unstable_mockModule('../src/services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    createRun: mockCreateDagRun
  }
}));

jest.unstable_mockModule('@dag/templates.js', () => ({
  TRINITY_CORE_DAG_TEMPLATE_NAME: 'trinity-core'
}));

const { default: dispatchRouter } = await import('../src/routes/dispatch.js');

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:dispatch-error';
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'mcp:invoke';
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & {
      logger: { error: typeof requestErrorLoggerMock };
    }).logger = {
      error: requestErrorLoggerMock
    };
    next();
  });
  app.use('/', dispatchRouter);
  return app;
}

describe('/dispatch error boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
  });

  it('does not expose unexpected dispatch exceptions', async () => {
    const privateErrorSentinel = 'PRIVATE_DISPATCH_FAILURE_SENTINEL';
    const rawMessage = `dispatch provider failed: ${privateErrorSentinel}`;
    mockRouteGptRequest.mockRejectedValueOnce(new Error(rawMessage));

    const response = await request(buildApp())
      .post('/dispatch')
      .send({
        target: 'gpt',
        gptId: 'arcanos-core',
        action: 'query',
        executionMode: 'gpt',
        prompt: 'Run a normal writing request.'
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      code: 'DISPATCH_FAILED',
      message: 'Dispatch failed.',
      routeFamily: 'dispatch',
      target: 'gpt',
      action: 'query',
      executionMode: 'gpt'
    });
    expect(JSON.stringify(response.body)).not.toContain(rawMessage);
    expect(JSON.stringify(response.body)).not.toContain(privateErrorSentinel);
    expect(requestErrorLoggerMock).toHaveBeenCalledWith(
      'dispatch.universal.failed',
      expect.objectContaining({
        target: 'gpt',
        gptId: 'arcanos-core',
        action: 'query',
        executionMode: 'gpt',
        error: rawMessage
      })
    );
  });

  it('keeps an authorized DAG execution failure private and no-store', async () => {
    const privateErrorSentinel = 'PRIVATE_DAG_DISPATCH_FAILURE_SENTINEL';
    const rawMessage = `DAG persistence failed: ${privateErrorSentinel}`;
    mockCreateDagRun.mockRejectedValueOnce(new Error(rawMessage));

    const response = await request(buildApp())
      .post('/dispatch')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        target: 'dag',
        prompt: 'Run the workflow now.',
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      code: 'DISPATCH_FAILED',
      message: 'Dispatch failed.',
      routeFamily: 'dispatch',
      target: 'dag',
    }));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(JSON.stringify(response.body)).not.toContain(rawMessage);
    expect(JSON.stringify(response.body)).not.toContain(privateErrorSentinel);
    expect(mockCreateDagRun).toHaveBeenCalledTimes(1);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
    expect(requestErrorLoggerMock).toHaveBeenCalledWith(
      'dispatch.universal.failed',
      expect.objectContaining({
        target: 'dag',
        error: rawMessage,
      })
    );
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
});

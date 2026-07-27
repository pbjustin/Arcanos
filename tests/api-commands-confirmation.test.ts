import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const mockExecuteCommand = jest.fn();
const supportedModes = new Set(['true', 'false', 'passive', 'log-only']);

jest.unstable_mockModule('@services/commandCenter.js', () => ({
  executeCommand: mockExecuteCommand,
  listAvailableCommands: () => [],
  validateCommandForExecution: (
    command: string,
    payload: Record<string, unknown>
  ) => {
    if (command !== 'audit-safe:set-mode') {
      return {
        ok: false,
        errorCode: 'UNSUPPORTED_COMMAND',
      };
    }
    if (
      typeof payload.mode !== 'string'
      || !supportedModes.has(payload.mode)
      || Object.keys(payload).length !== 1
    ) {
      return {
        ok: false,
        errorCode: 'INVALID_COMMAND_PAYLOAD',
      };
    }
    return {
      ok: true,
      command,
      payload: Object.freeze({ ...payload }),
    };
  },
}));

const apiCommandsRouter = (
  await import('../src/routes/api-commands.js')
).default;

const controlPlaneToken =
  'api-commands-confirm-token-123456789012345678901';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    environmentName => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(
  principalId = 'operator:api-commands-confirmation'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'mcp:invoke';
}

function createApp(): Express {
  const app = express();
  app.use('/api/commands', apiCommandsRouter);
  return app;
}

function commandRequest(
  app: Express,
  body: Record<string, unknown>
) {
  return request(app)
    .post('/api/commands/execute')
    .set('Authorization', `Bearer ${controlPlaneToken}`)
    .send(body);
}

function buildCommandResult(
  command: string,
  success: boolean,
  errorCode?: string
) {
  return {
    success,
    command,
    message: success ? 'Command completed.' : 'Command rejected.',
    output: success ? { mode: 'true' } : null,
    error: success
      ? null
      : {
          code: errorCode,
          message: 'Command rejected.',
          httpStatusCode: 400,
        },
    metadata: {
      executedAt: '2026-07-27T12:00:00.000Z',
      auditSafeMode: 'true',
      commandTraceId: 'cef_route_test',
      traceId: null,
      executionId: null,
      capabilityId: null,
      stepId: null,
      source: '/api/commands/execute',
    },
  };
}

describe('POST /api/commands/execute challenge confirmation', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    app = createApp();
    mockExecuteCommand.mockImplementation(async (
      command: string,
      payload: Record<string, unknown>,
      context: Record<string, unknown>
    ) => {
      if (command !== 'audit-safe:set-mode') {
        return buildCommandResult(command, false, 'UNSUPPORTED_COMMAND');
      }
      if (!supportedModes.has(String(payload.mode))) {
        return buildCommandResult(command, false, 'INVALID_COMMAND_PAYLOAD');
      }
      return {
        ...buildCommandResult(command, true),
        metadata: {
          ...buildCommandResult(command, true).metadata,
          traceId: context.traceId ?? null,
        },
      };
    });
  });

  it('rejects manual and compatibility bypass headers in challenge-only mode', async () => {
    const response = await commandRequest(app, {
      command: 'audit-safe:set-mode',
      payload: { mode: 'true' },
    })
      .set('x-confirmed', 'yes')
      .set('x-gpt-id', 'trusted-test-gpt')
      .set('x-arcanos-confirm-token', 'compatibility-marker');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toEqual(
      expect.any(String)
    );
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it('executes once after consuming the exact issued challenge', async () => {
    const body = {
      command: 'audit-safe:set-mode',
      payload: { mode: 'true' },
    };
    const pending = await commandRequest(app, body);
    const challengeId = pending.headers['x-confirmation-challenge'];
    const confirmed = await commandRequest(app, body)
      .set('x-confirmed', `token:${challengeId}`);

    expect(pending.status).toBe(403);
    expect(confirmed.status).toBe(200);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'audit-safe:set-mode',
      { mode: 'true' },
      expect.objectContaining({
        source: '/api/commands/execute',
        executionPermit: expect.any(Object),
      })
    );

    const replay = await commandRequest(app, body)
      .set('x-confirmed', `token:${challengeId}`);
    expect(replay.status).toBe(403);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects a challenge when the validated payload changes', async () => {
    const pending = await commandRequest(app, {
      command: 'audit-safe:set-mode',
      payload: { mode: 'true' },
    });
    const challengeId = pending.headers['x-confirmation-challenge'];

    const changed = await commandRequest(app, {
      command: 'audit-safe:set-mode',
      payload: { mode: 'false' },
    }).set('x-confirmed', `token:${challengeId}`);

    expect(changed.status).toBe(403);
    expect(changed.headers['x-confirmation-challenge']).not.toBe(challengeId);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it('rejects a challenge when the authenticated principal changes', async () => {
    const body = {
      command: 'audit-safe:set-mode',
      payload: { mode: 'true' },
    };
    const pending = await commandRequest(app, body);
    const challengeId = pending.headers['x-confirmation-challenge'];
    configureControlPlane('operator:api-commands-confirmation-other');

    const changed = await commandRequest(app, body)
      .set('x-confirmed', `token:${challengeId}`);

    expect(changed.status).toBe(403);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it('returns invalid and unsupported command errors before challenging', async () => {
    const invalid = await commandRequest(app, {
      command: 'audit-safe:set-mode',
      payload: { mode: 'invalid' },
    });
    const unsupported = await commandRequest(app, {
      command: 'system:shell',
      payload: {},
    });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_COMMAND_PAYLOAD');
    expect(invalid.headers['x-confirmation-challenge']).toBeUndefined();
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe('UNSUPPORTED_COMMAND');
    expect(unsupported.headers['x-confirmation-challenge']).toBeUndefined();
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

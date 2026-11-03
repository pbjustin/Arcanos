import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { recordChatIntent } from '../src/routes/ask/intent_store.js';
import systemStateRouter from '../src/routes/system-state.js';
import {
  createSystemStateHttpBoundary,
} from '../src/services/controlPlane/systemStateHttpBoundary.js';
import {
  SYSTEM_STATE_BODY_LIMIT_BYTES,
  systemStateBodyParser,
} from '../src/services/controlPlane/systemStateBodyParser.js';
import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'system-state-boundary-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
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
  scopes = 'arcanos:read,mcp:invoke',
  principalId = 'operator:system-state-boundary'
): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = principalId;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
}

function buildApp(): express.Express {
  const app = express();
  app.set('trust proxy', true);
  const boundary = createSystemStateHttpBoundary({
    maxClientRequests: 100,
    windowMs: 60_000,
  });
  app.use('/system-state', boundary);
  app.use('/system-state', systemStateBodyParser);
  app.use(express.json({ limit: '10mb' }));
  app.use('/', systemStateRouter);
  app.get('/system-stateful', (_req, res) => res.status(204).end());
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    res.status((error as { status?: number }).status ?? 500).json({
      code: 'BROAD_PARSER_REJECTED',
    });
  });
  return app;
}

function authenticatedGet(app: express.Express, path = '/system-state') {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

function authenticatedPost(app: express.Express) {
  return request(app)
    .post('/system-state')
    .set('Authorization', `Bearer ${controlPlaneToken}`);
}

async function challengeConfirmedPost(
  app: express.Express,
  body: Record<string, unknown>
) {
  const pendingResponse = await authenticatedPost(app).send(body);
  const challengeId = pendingResponse.headers['x-confirmation-challenge'];

  expect(pendingResponse.status).toBe(403);
  expect(pendingResponse.body.confirmationRequired).toBe(true);
  expect(typeof challengeId).toBe('string');

  return authenticatedPost(app)
    .set('X-Confirmed', `token:${challengeId}`)
    .send(body);
}

describe('system-state HTTP ingress boundary', () => {
  beforeEach(() => {
    configureControlPlane();
  });

  it('authenticates before parsing an invalid request body', async () => {
    const response = await request(buildApp())
      .post('/system-state')
      .set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json')
      .send('{"patch":');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('uses an explicit frozen authentication environment without mutating ambient configuration', async () => {
    configureControlPlane('arcanos:read', 'operator:ambient-read-only');
    const ambientScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
    const explicitToken = 'system-state-explicit-preview-token-1234567890';
    const authenticationEnvironment = Object.freeze({
      ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: explicitToken,
      ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:explicit-preview',
      ARCANOS_CONTROL_PLANE_SCOPES: 'mcp:invoke',
    }) as NodeJS.ProcessEnv;
    const app = express();
    app.post('/status', createSystemStateHttpBoundary({
      authenticationEnvironment,
      maxClientRequests: 10,
      windowMs: 60_000,
    }));
    app.post('/status', systemStateBodyParser);
    app.post('/status', (_req, res) => res.status(204).end());

    const response = await request(app)
      .post('/status')
      .set('Authorization', `Bearer ${explicitToken}`)
      .send({ status: 'active' });

    expect(response.status).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(process.env.ARCANOS_CONTROL_PLANE_SCOPES).toBe(ambientScopes);
    expect(Object.isFrozen(authenticationEnvironment)).toBe(true);
  });

  it('authenticates before allocating an oversized request body', async () => {
    const response = await request(buildApp())
      .post('/system-state')
      .set('X-Confirmed', 'yes')
      .send({
        patch: {
          label: 'x'.repeat(SYSTEM_STATE_BODY_LIMIT_BYTES),
        },
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('fails closed when control-plane authentication is unavailable', async () => {
    clearPurposeBoundCredentialEnvironment();

    const response = await request(buildApp()).get('/system-state');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
  });

  it.each([
    'ARCANOS_CONTROL_PLANE_ACCESS_TOKEN',
    'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID',
  ])('returns configuration unavailable for missing %s on both daemon methods', async (name) => {
    delete process.env[name];
    const app = buildApp();

    for (const method of ['get', 'post'] as const) {
      const response = await request(app)[method]('/system-state')
        .set('Authorization', `Bearer ${controlPlaneToken}`)
        .send(method === 'post' ? {} : undefined);

      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
      expect(response.text).not.toContain(controlPlaneToken);
      expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    }
  });

  it.each([undefined, ''])('denies reads when server scopes are %s', async (scopes) => {
    if (scopes === undefined) {
      delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
    } else {
      process.env.ARCANOS_CONTROL_PLANE_SCOPES = scopes;
    }

    const response = await authenticatedGet(buildApp());

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('rejects malformed server scopes as unavailable configuration', async () => {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'arcanos:read,,mcp:invoke';

    const response = await authenticatedGet(buildApp());

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_UNAVAILABLE');
  });

  it.each([
    undefined,
    'Bearer invalid-system-state-test-control-token-1234567890',
    'Basic system-state-client-basic-token-1234567890',
  ])('rejects missing or invalid GET authentication (%s)', async (authorization) => {
    const pending = request(buildApp()).get('/system-state');
    if (authorization !== undefined) {
      pending.set('Authorization', authorization);
    }
    const response = await pending;

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(response.headers['www-authenticate']).toBe('Bearer realm="control-plane"');
    expect(response.headers['cache-control']).toBe('no-store');
    if (authorization !== undefined) {
      expect(response.text).not.toContain(authorization.split(' ')[1]);
    }
  });

  it('keeps credentials out of authentication, scope, and validation error logs', async () => {
    const audit = { warn: jest.fn(), error: jest.fn() };
    const app = express();
    app.use((req, _res, next) => {
      req.logger = audit as unknown as express.Request['logger'];
      next();
    });
    app.use(systemStateRouter);
    const invalidToken = 'synthetic-private-invalid-control-token-1234567890';
    const sensitiveSession = `private-session-${'x'.repeat(100)}`;

    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
    const unavailable = await authenticatedGet(app);
    configureControlPlane();
    const invalid = await request(app).get('/system-state')
      .set('Authorization', `Bearer ${invalidToken}`);
    configureControlPlane('mcp:invoke');
    const denied = await authenticatedGet(app);
    configureControlPlane();
    const badRequest = await authenticatedGet(app).query({ sessionId: sensitiveSession });

    expect([unavailable.status, invalid.status, denied.status, badRequest.status])
      .toEqual([503, 401, 403, 400]);
    expect(audit.error).toHaveBeenCalledWith('control_plane.http_auth.denied', {
      reason: 'configuration_unavailable', statusCode: 503,
    });
    expect(audit.warn).toHaveBeenCalledWith('control_plane.http_auth.denied', {
      reason: 'invalid_auth', statusCode: 401,
    });
    expect(audit.warn).toHaveBeenCalledWith('system_state.http_authorization.denied', {
      reason: 'missing_scope', statusCode: 403, method: 'GET',
    });
    const observed = JSON.stringify({
      logs: [audit.warn.mock.calls, audit.error.mock.calls],
      errors: [unavailable.body, invalid.body, denied.body, badRequest.body],
    });
    for (const secret of [controlPlaneToken, invalidToken, sensitiveSession]) {
      expect(observed).not.toContain(secret);
    }
  });

  it('retrieves state through the real Python HTTP client while preserving authorization failures', async () => {
    // Resolve dependencies before opening the fixture server or isolating the
    // child from operator data. Python user sites need not be installation-local.
    const userSite = spawnSync('python', ['-c', 'import site; print(site.getusersitepackages() if site.ENABLE_USER_SITE else "")'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    expect(userSite.status).toBe(0);
    const sandbox = mkdtempSync(path.join(tmpdir(), 'arcanos-system-state-e2e-'));
    const sessionId = 'synthetic-daemon-system-state-e2e';
    const seeded = recordChatIntent('Seed isolated daemon system state', sessionId);
    const observed: Array<{ method: string; path: string; sessionId: unknown; dedicated: boolean }> = [];
    const app = express();
    app.use((req, _res, next) => {
      observed.push({
        method: req.method,
        path: req.path,
        sessionId: req.query.sessionId,
        dedicated: req.get('Authorization') === `Bearer ${controlPlaneToken}`
          && !req.get('X-Gpt-Id') && !req.get('X-Arcanos-Daemon-Token'),
      });
      next();
    });
    app.use(systemStateRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a loopback fixture port');
    }
    const daemonPath = fileURLToPath(new URL('../daemon-python', import.meta.url));
    const code = `
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import arcanos.env as runtime_env
# This fixture must never hydrate a project or installed operator .env.
runtime_env._BOOTSTRAPPED = True
runtime_env._BASE_DIR = Path(os.environ["DATA_DIR"])
from arcanos.backend_client import BackendApiClient
def unrelated_credential():
    raise AssertionError("Control-plane requests must not select unrelated credentials")
client = BackendApiClient(sys.argv[2], unrelated_credential,
    daemon_access_token_provider=unrelated_credential, timeout_seconds=5)
kwargs = {"metadata": {"instanceId": "synthetic-daemon-system-state-e2e"}}
if sys.argv[3] == "mutation":
    kwargs.update(expected_version=1, patch={"label": "unapproved-fixture-mutation"})
result = client.request_system_state(**kwargs)
error = result.error
print(json.dumps({"ok": result.ok, "kind": error.kind if error else None,
    "status": error.status_code if error else None,
    "challenge": bool(error.confirmation_challenge_id) if error else False,
    "mode": result.value.get("mode") if result.value else None,
    "intent": result.value.get("intent") if result.value else None}))
`;
    const launchEnvironment = Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT'].filter(name => process.env[name] !== undefined)
        .map(name => [name, process.env[name]!])
    );
    try {
      for (const scenario of [
        { name: 'read', token: controlPlaneToken, status: null, kind: null },
        { name: 'missing-server-token', token: controlPlaneToken, status: 503, kind: 'configuration' },
        { name: 'invalid-client-token', token: 'invalid-python-test-control-token-1234567890', status: 401, kind: 'control_plane_auth' },
        { name: 'missing-client-token', token: '', status: null, kind: 'control_plane_auth' },
        { name: 'missing-scope', token: controlPlaneToken, status: 403, kind: 'control_plane_auth' },
        { name: 'mutation', token: controlPlaneToken, status: 403, kind: 'confirmation' },
      ]) {
        configureControlPlane(scenario.name === 'missing-scope' ? 'mcp:invoke' : 'arcanos:read,mcp:invoke');
        if (scenario.name === 'missing-server-token') {
          delete process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN;
        }
        const beforeCount = observed.length;
        const output = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
          const child = spawn('python', ['-c', code, daemonPath, `http://127.0.0.1:${address.port}`, scenario.name], {
            cwd: sandbox,
            env: {
              ...launchEnvironment,
              USERPROFILE: sandbox, LOCALAPPDATA: sandbox, APPDATA: sandbox,
              HOME: sandbox, DATA_DIR: sandbox, TEMP: sandbox, TMP: sandbox,
              BACKEND_ALLOW_HTTP: 'true', PYTHONIOENCODING: 'utf-8',
              OPENAI_API_KEY: 'synthetic-unused-control-plane-test-provider-key',
              PYTHONPATH: userSite.stdout.trim(),
              ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: scenario.token,
            },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', chunk => { stdout += chunk.toString(); });
          child.stderr.on('data', chunk => { stderr += chunk.toString(); });
          child.once('error', reject);
          child.once('close', exitCode => resolve({ stdout, stderr, exitCode }));
        });
        expect({ exitCode: output.exitCode, stderr: output.stderr }).toEqual({ exitCode: 0, stderr: '' });
        const result = JSON.parse(output.stdout);
        expect(result).toMatchObject({
          ok: scenario.name === 'read', status: scenario.status, kind: scenario.kind,
          challenge: scenario.name === 'mutation',
        });
        if (scenario.name === 'read') {
          expect(result.mode).toBe('system_state');
          expect(result.intent).toMatchObject({ version: seeded.version, label: seeded.label });
        }
        if (scenario.name === 'missing-client-token') {
          expect(observed).toHaveLength(beforeCount);
        } else {
          expect(observed.slice(beforeCount)).toEqual([{
            method: scenario.name === 'mutation' ? 'POST' : 'GET',
            path: '/system-state',
            sessionId: scenario.name === 'mutation' ? undefined : sessionId,
            dedicated: scenario.name !== 'invalid-client-token',
          }]);
        }
        for (const secret of [controlPlaneToken, 'invalid-python-test-control-token-1234567890']) {
          expect(output.stdout + output.stderr).not.toContain(secret);
          expect(readFileSync(path.join(sandbox, 'logs', 'debug_server.log'), 'utf8')).not.toContain(secret);
        }
      }
      const finalState = await authenticatedGet(app).query({ sessionId });
      expect(finalState.body.intent).toMatchObject({ version: seeded.version, label: seeded.label });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps invalid bearer traffic from exhausting authenticated ingress', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use('/system-state', createSystemStateHttpBoundary({
      maxClientRequests: 1,
      windowMs: 60_000,
    }));
    app.use('/', systemStateRouter);
    const clientAddress = '198.51.100.42';

    const denied = await request(app)
      .get('/system-state')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-control-plane-test-token');
    const throttled = await request(app)
      .get('/system-state')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', 'Bearer invalid-control-plane-test-token');
    const authenticated = await request(app)
      .get('/system-state')
      .set('X-Forwarded-For', clientAddress)
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(denied.status).toBe(401);
    expect(throttled.status).toBe(429);
    expect(authenticated.status).toBe(200);
  });

  it('separates read and mutation scopes', async () => {
    configureControlPlane('arcanos:read');
    const readOnlyApp = buildApp();
    const readResponse = await authenticatedGet(readOnlyApp);
    const mutationDenied = await authenticatedPost(readOnlyApp)
      .set('X-Confirmed', 'yes')
      .send({});

    expect(readResponse.status).toBe(200);
    expect(readResponse.body.mode).toBe('system_state');
    expect(mutationDenied.status).toBe(403);
    expect(mutationDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');

    configureControlPlane('mcp:invoke');
    const readDenied = await authenticatedGet(buildApp());
    expect(readDenied.status).toBe(403);
    expect(readDenied.body.error.code).toBe('CONTROL_PLANE_SCOPE_DENIED');
  });

  it('principal-throttles repeated requests that fail scope authorization', async () => {
    configureControlPlane(
      'arcanos:read',
      'operator:system-state-scope-throttle'
    );
    const app = buildApp();
    const deniedResponses = [];

    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      deniedResponses.push(await authenticatedPost(app).send({}));
    }
    const throttledResponse = await authenticatedPost(app).send({});

    expect(deniedResponses).toHaveLength(10);
    expect(deniedResponses.every(
      (response) => (
        response.status === 403
        && response.body.error.code === 'CONTROL_PLANE_SCOPE_DENIED'
      )
    )).toBe(true);
    expect(throttledResponse.status).toBe(429);
  });

  it('requires a principal- and body-bound one-use mutation challenge', async () => {
    const primaryPrincipal = 'operator:system-state-boundary';
    const alternatePrincipal = 'operator:system-state-alternate';
    configureControlPlane('mcp:invoke', primaryPrincipal);
    const app = buildApp();
    const originalBody = {};
    const changedBody = {
      sessionId: `system-state-challenge-${Date.now()}`,
    };
    const pendingResponse = await authenticatedPost(app)
      .set('X-Confirmed', 'yes')
      .set('X-Gpt-Id', 'trusted-system-state-client')
      .set('X-Arcanos-Confirm-Token', 'non-challenge-approval')
      .send(originalBody);
    const primaryChallengeId =
      pendingResponse.headers['x-confirmation-challenge'];

    configureControlPlane('mcp:invoke', alternatePrincipal);
    const principalMismatchResponse = await authenticatedPost(app)
      .set('X-Confirmed', `token:${primaryChallengeId}`)
      .send(originalBody);
    const alternateChallengeId =
      principalMismatchResponse.headers['x-confirmation-challenge'];
    const bodyMismatchResponse = await authenticatedPost(app)
      .set('X-Confirmed', `token:${alternateChallengeId}`)
      .send(changedBody);
    const changedBodyChallengeId =
      bodyMismatchResponse.headers['x-confirmation-challenge'];
    const confirmedResponse = await authenticatedPost(app)
      .set('X-Confirmed', `token:${changedBodyChallengeId}`)
      .send(changedBody);
    const replayResponse = await authenticatedPost(app)
      .set('X-Confirmed', `token:${changedBodyChallengeId}`)
      .send(changedBody);

    expect(pendingResponse.status).toBe(403);
    expect(pendingResponse.body.confirmationRequired).toBe(true);
    expect(pendingResponse.headers['x-confirmation-status']).toBe('pending');
    expect(typeof primaryChallengeId).toBe('string');
    expect(principalMismatchResponse.status).toBe(403);
    expect(typeof alternateChallengeId).toBe('string');
    expect(bodyMismatchResponse.status).toBe(403);
    expect(typeof changedBodyChallengeId).toBe('string');
    expect(confirmedResponse.status).toBe(200);
    expect(replayResponse.status).toBe(403);
    expect(replayResponse.body.confirmationRequired).toBe(true);
  });

  it('allows one confirmed operator mutation and preserves its response', async () => {
    configureControlPlane('mcp:invoke');
    const sessionId = `system-state-boundary-${Date.now()}`;
    const seeded = recordChatIntent('Seed boundary mutation', sessionId);

    const response = await challengeConfirmedPost(buildApp(), {
      sessionId,
      expectedVersion: seeded.version,
      patch: {
        status: 'active',
        phase: 'execution',
        label: 'boundary-confirmed',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.intent).toEqual(expect.objectContaining({
      status: 'active',
      phase: 'execution',
      label: 'boundary-confirmed',
      version: seeded.version + 1,
    }));
  });

  it.each([
    {
      name: 'malformed JSON',
      configure: (pendingRequest: request.Test) => pendingRequest
        .set('Content-Type', 'application/json')
        .send('{"patch":'),
      status: 400,
    },
    {
      name: 'malformed vendor JSON',
      configure: (pendingRequest: request.Test) => pendingRequest
        .set('Content-Type', 'application/merge-patch+json')
        .send('{"patch":'),
      status: 400,
    },
    {
      name: 'an array body',
      configure: (pendingRequest: request.Test) => pendingRequest.send([]),
      status: 400,
    },
    {
      name: 'compressed content',
      configure: (pendingRequest: request.Test) => pendingRequest
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send('{}'),
      status: 415,
    },
  ])('returns a stable parser response for $name', async ({
    configure,
    status,
  }) => {
    configureControlPlane('mcp:invoke');
    const response = await configure(
      authenticatedPost(buildApp()).set('X-Confirmed', 'yes')
    );

    expect(response.status).toBe(status);
    expect(response.body.error).toEqual({
      code: 'SYSTEM_STATE_REQUEST_INVALID',
      message: 'System-state request is invalid.',
    });
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('parses and confirms valid vendor JSON instead of treating it as absent', async () => {
    configureControlPlane('mcp:invoke');
    const app = buildApp();
    const sessionId = `system-state-vendor-json-${Date.now()}`;
    const seeded = recordChatIntent('Seed vendor JSON mutation', sessionId);
    const body = {
      sessionId,
      expectedVersion: seeded.version,
      patch: {
        label: 'vendor-json-confirmed',
      },
      compatibilityMetadata: {
        nested: {
          ignored: true,
        },
      },
    };
    const serializedBody = JSON.stringify(body);
    const pendingResponse = await authenticatedPost(app)
      .set('Content-Type', 'application/merge-patch+json')
      .send(serializedBody);
    const challengeId = pendingResponse.headers['x-confirmation-challenge'];

    expect(pendingResponse.status).toBe(403);
    expect(typeof challengeId).toBe('string');

    const confirmedResponse = await authenticatedPost(app)
      .set('Content-Type', 'application/merge-patch+json')
      .set('X-Confirmed', `token:${challengeId}`)
      .send(serializedBody);

    expect(confirmedResponse.status).toBe(200);
    expect(confirmedResponse.body.intent).toEqual(expect.objectContaining({
      label: 'vendor-json-confirmed',
      version: seeded.version + 1,
    }));
  });

  it('rejects deeply nested sub-limit JSON before confirmation fingerprinting', async () => {
    configureControlPlane('mcp:invoke');
    const nestedBody = `${'{"a":'.repeat(6_000)}0${'}'.repeat(6_000)}`;
    expect(Buffer.byteLength(nestedBody, 'utf8')).toBeLessThan(
      SYSTEM_STATE_BODY_LIMIT_BYTES
    );

    const response = await authenticatedPost(buildApp())
      .set('Content-Type', 'application/json')
      .send(nestedBody);

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'SYSTEM_STATE_REQUEST_INVALID',
      message: 'System-state request is invalid.',
    });
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('rejects an oversized body at the dedicated parser', async () => {
    configureControlPlane('mcp:invoke');
    const response = await authenticatedPost(buildApp())
      .set('X-Confirmed', 'yes')
      .send({
        patch: {
          label: 'x'.repeat(SYSTEM_STATE_BODY_LIMIT_BYTES),
        },
      });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('SYSTEM_STATE_REQUEST_INVALID');
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('terminates unknown protected subpaths without capturing neighbors', async () => {
    const unknownResponse = await authenticatedGet(
      buildApp(),
      '/system-state/unknown'
    );
    const neighborResponse = await request(buildApp()).get('/system-stateful');

    expect(unknownResponse.status).toBe(404);
    expect(unknownResponse.body).toEqual({
      error: 'Route Not Found',
      code: 404,
    });
    expect(neighborResponse.status).toBe(204);
  });

  it.each([
    ['GET', '/system-state/', 200],
    ['GET', '/SYSTEM-STATE', 200],
    ['PUT', '/system-state', 404],
    ['GET', '/system-state/extra', 404],
    ['GET', '/system-state%2Fextra', 404],
  ])('keeps the canonical method/path boundary for %s %s', async (
    method,
    path,
    expectedStatus
  ) => {
    const response = await request(buildApp())
      [method.toLowerCase() as 'get' | 'put'](path)
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(response.status).toBe(expectedStatus);
  });

  it('applies read authorization to HEAD and returns no-store metadata', async () => {
    const response = await request(buildApp())
      .head('/system-state')
      .set('Authorization', `Bearer ${controlPlaneToken}`);

    expect(response.status).toBe(200);
    expect(response.text).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
  });

  it('bounds caller-selected session identifiers without reflection', async () => {
    const sessionId = `sensitive-${'x'.repeat(100)}`;
    const response = await authenticatedGet(buildApp()).query({ sessionId });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'System-state request is invalid.',
      },
    });
    expect(response.text).not.toContain(sessionId);
  });

  it('mounts authentication and bounded parsing before the broad parser', () => {
    const appSource = readFileSync(
      new URL('../src/app.ts', import.meta.url),
      'utf8'
    );
    const boundaryIndex = appSource.indexOf(
      "app.use('/system-state', systemStateHttpBoundary)"
    );
    const bodyParserIndex = appSource.indexOf(
      "app.use('/system-state', systemStateBodyParser)"
    );
    const broadParserIndex = appSource.indexOf(
      'app.use(express.json({ limit: config.limits.jsonLimit }))'
    );

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(bodyParserIndex).toBeGreaterThan(boundaryIndex);
    expect(bodyParserIndex).toBeLessThan(broadParserIndex);
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

import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorRequestHandler } from 'express';

import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';

const initializeModuleRegistry = jest.fn<() => Promise<void>>();
jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry,
  getModulesForRegistry: () => [],
}));
// Registry reads do not touch the daemon store. Keep its disk lifecycle outside
// this transport test, along with unrelated request-logging instrumentation.
jest.unstable_mockModule('@routes/api-daemon/context.js', () => ({ daemonStore: {} }));
jest.unstable_mockModule('@middleware/requestContext.js', () => ({ requestContext: jest.fn() }));

const savedEnvironment = new Map(
  [...PURPOSE_BOUND_CREDENTIAL_ENV_NAMES, 'DAEMON_REGISTRY_RATE_LIMIT_MAX']
    .map(name => [name, process.env[name]] as const)
);
process.env.DAEMON_REGISTRY_RATE_LIMIT_MAX = '20';
const express = (await import('express')).default;
const apiDaemonRouter = (await import('../src/routes/api-daemon.js')).default;
const daemonToken = 'synthetic-daemon-registry-http-token-1234567890';
const wrongToken = 'synthetic-wrong-registry-http-token-1234567890';
const peerToken = 'synthetic-control-plane-http-token-1234567890';

afterAll(() => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('Python registry client over real Express loopback HTTP', () => {
  it('preserves dedicated auth, rejects invalid evidence, and never retries failed reads', async () => {
    const python = process.env.PYTHON_EXECUTABLE || 'python';
    const userSite = spawnSync(python, ['-c', 'import site; print(site.getusersitepackages() if site.ENABLE_USER_SITE else "")'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    expect(userSite.status).toBe(0);
    const sandbox = mkdtempSync(path.join(tmpdir(), 'arcanos-registry-http-'));
    const observed: Array<{ method: string; path: string; dedicated: boolean; status?: number }> = [];
    let wirePayload: 'normal' | 'malformed' | 'empty' = 'normal';
    const app = express();
    app.use((req, res, next) => {
      const observation = {
        method: req.method,
        path: req.path,
        dedicated: req.get('x-arcanos-daemon-token') === daemonToken
          && !req.get('Authorization') && !req.get('x-gpt-id') && !req.get('Cookie'),
        status: undefined as number | undefined,
      };
      observed.push(observation);
      res.once('finish', () => { observation.status = res.statusCode; });
      const sendJson = res.json.bind(res);
      res.json = body => sendJson(res.statusCode === 200 && wirePayload !== 'normal'
        ? wirePayload === 'empty' ? {} : { ok: true, error: 'not registry evidence' }
        : body);
      next();
    });
    app.use(apiDaemonRouter);
    app.use(((_error, _req, res, _next) => {
      res.status(500).json({ error: 'registry initialization unavailable' });
    }) satisfies ErrorRequestHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
    const daemonPath = fileURLToPath(new URL('../daemon-python', import.meta.url));
    const fixture = fileURLToPath(new URL('./fixtures/daemon_registry_client.py', import.meta.url));
    const launchEnvironment = Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT'].filter(name => process.env[name] !== undefined)
        .map(name => [name, process.env[name]!])
    );
    const scenarios = [
      { name: 'matching dedicated credentials', token: daemonToken, kind: null, status: null, http: 1 },
      { name: 'missing client credential', token: '', kind: 'daemon_auth', status: null, http: 0 },
      { name: 'missing server credential', token: daemonToken, kind: 'http', status: 503, http: 1 },
      { name: 'invalid credential', token: wrongToken, kind: 'daemon_auth', status: 401, http: 1 },
      { name: 'client purpose collision', token: peerToken, kind: 'daemon_auth', status: null, http: 0 },
      { name: 'server purpose collision', token: daemonToken, kind: 'http', status: 503, http: 1 },
      { name: 'registry initialization failure', token: daemonToken, kind: 'http', status: 500, http: 1 },
      { name: 'malformed registry', token: daemonToken, kind: 'parse', status: null, http: 1 },
      { name: 'empty registry', token: daemonToken, kind: 'parse', status: null, http: 1 },
      { name: 'valid registry recovery', token: daemonToken, kind: null, status: null, http: 1 },
      { name: 'rate limited', token: daemonToken, kind: 'rate_limit', status: 429, http: 25 },
    ];
    try {
      for (const scenario of scenarios) {
        for (const name of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) delete process.env[name];
        process.env.ARCANOS_DAEMON_ACCESS_TOKEN = daemonToken;
        if (scenario.name === 'missing server credential') delete process.env.ARCANOS_DAEMON_ACCESS_TOKEN;
        if (scenario.name === 'server purpose collision') process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = daemonToken;
        initializeModuleRegistry.mockReset();
        initializeModuleRegistry.mockResolvedValue(undefined);
        if (scenario.name === 'registry initialization failure') {
          initializeModuleRegistry.mockRejectedValue(new Error('synthetic initialization failure'));
        }
        wirePayload = scenario.name === 'malformed registry' ? 'malformed'
          : scenario.name === 'empty registry' ? 'empty' : 'normal';
        const beforeCount = observed.length;
        const output = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
          const child = spawn(python, ['-B', fixture, daemonPath, `http://127.0.0.1:${address.port}`,
            String(scenario.name === 'rate limited' ? 25 : 1)], {
            cwd: sandbox,
            env: {
              ...launchEnvironment,
              USERPROFILE: sandbox, LOCALAPPDATA: sandbox, APPDATA: sandbox,
              HOME: sandbox, DATA_DIR: sandbox, TEMP: sandbox, TMP: sandbox,
              BACKEND_ALLOW_HTTP: 'true', PYTHONIOENCODING: 'utf-8',
              PYTHONPATH: userSite.stdout.trim(),
              OPENAI_API_KEY: 'test-unused-registry-http-provider-key',
              ARCANOS_DAEMON_ACCESS_TOKEN: scenario.token,
              ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: peerToken,
              ARCANOS_GPT_ACCESS_TOKEN: 'synthetic-unused-registry-gpt-access-token-1234567890',
              BACKEND_TOKEN: 'synthetic-unused-registry-backend-token-1234567890',
              BACKEND_ALLOW_GPT_ID_AUTH: 'true',
              NO_PROXY: '*',
            },
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', chunk => { stdout += chunk.toString(); });
          child.stderr.on('data', chunk => { stderr += chunk.toString(); });
          child.once('error', reject);
          child.once('close', exitCode => resolve({ stdout, stderr, exitCode }));
        });
        expect({ scenario: scenario.name, exitCode: output.exitCode, stderr: output.stderr })
          .toEqual({ scenario: scenario.name, exitCode: 0, stderr: '' });
        const results = JSON.parse(output.stdout) as Array<{ ok: boolean; kind: string | null; status: number | null; version: number | null }>;
        expect(results.at(-1)).toMatchObject({
          ok: scenario.kind === null, kind: scenario.kind, status: scenario.status,
        });
        if (scenario.kind === null) expect(results[0].version).toBe(1);
        if (scenario.name === 'rate limited') {
          expect(results).toHaveLength(25);
          expect(results.some(result => result.ok)).toBe(true);
        }
        const requests = observed.slice(beforeCount);
        expect(requests).toHaveLength(scenario.http);
        expect(requests.every(request => request.method === 'GET' && request.path === '/api/daemon/registry')).toBe(true);
        if (scenario.name === 'rate limited') expect(requests.at(-1)?.status).toBe(429);
        else expect(requests.every(request => request.status === (scenario.status ?? 200))).toBe(true);
        if (scenario.token === daemonToken) expect(requests.every(request => request.dedicated)).toBe(true);
        if (['missing server credential', 'invalid credential', 'server purpose collision'].includes(scenario.name)) {
          expect(initializeModuleRegistry).not.toHaveBeenCalled();
        }
        const log = readFileSync(path.join(sandbox, 'logs', 'debug_server.log'), 'utf8');
        for (const secret of [daemonToken, wrongToken, peerToken]) {
          expect(output.stdout + output.stderr + log).not.toContain(secret);
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 90_000);
});

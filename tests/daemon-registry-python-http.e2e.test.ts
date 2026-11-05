import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorRequestHandler } from 'express';

import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';
import { createDaemonStore } from '../src/routes/daemonStore.js';
import { recordChatIntent, updateIntentWithOptimisticLock } from '../src/routes/ask/intent_store.js';

const initializeModuleRegistry = jest.fn<() => Promise<{ listRegisteredModules: () => unknown[] }>>();
const routeGptRequest = jest.fn();
const resolveGptRouting = jest.fn();
jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  initializeModuleRegistry,
  getModulesForRegistry: () => [],
  getModuleMetadata: () => null,
  listRegisteredModules: () => [],
  getPublicModulesForRegistry: () => [],
  dispatchModuleAction: () => { throw new Error('Unexpected real module dispatch'); },
  resolveLegacyModule: () => null,
  resolveRegisteredModule: () => null,
  ModuleNotFoundError: class extends Error {},
  ModuleActionNotFoundError: class extends Error {},
  ModuleAccessDeniedError: class extends Error {},
}));
// Keep the actual challenge binding, expiry, consume, replay and queue logic.
// Only filesystem persistence and provider dispatch are controlled dependencies.
const daemonStore = createDaemonStore({
  fs: { existsSync: () => false, readFileSync, writeFileSync: () => undefined, mkdirSync: () => undefined },
  path: { dirname: path.dirname }, tokensFilePath: 'unused-acceptance-store.json',
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, now: () => new Date(),



});
jest.unstable_mockModule('@routes/api-daemon/context.js', () => ({ daemonStore }));
jest.unstable_mockModule('@middleware/requestContext.js', () => ({ requestContext: jest.fn() }));
jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({ routeGptRequest, resolveGptRouting }));

const savedEnvironment = new Map(
  [...PURPOSE_BOUND_CREDENTIAL_ENV_NAMES, 'DAEMON_REGISTRY_RATE_LIMIT_MAX',
    'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID', 'ARCANOS_CONTROL_PLANE_SCOPES']
    .map(name => [name, process.env[name]] as const)
);
process.env.DAEMON_REGISTRY_RATE_LIMIT_MAX = '20';
const express = (await import('express')).default;
const { default: apiDaemonRouter, createPendingDaemonActions } = await import('../src/routes/api-daemon.js');
const systemStateRouter = (await import('../src/routes/system-state.js')).default;
const gptRouter = (await import('../src/routes/gptRouter.js')).default;
const daemonToken = 'synthetic-daemon-registry-http-token-1234567890';
const wrongToken = 'synthetic-wrong-registry-http-token-1234567890';
const peerToken = 'synthetic-control-plane-http-token-1234567890';
let directRegistryHttpCount: number | null = null;

afterAll(() => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (process.platform !== 'win32') console.log('[ARCANOS_NATIVE_EXPRESS_NOT_RUN] ' + JSON.stringify({
    native_windows_acceptance: 'NOT_RUN', reason: 'Requires Windows ConPTY and the full daemon development dependencies',
    cross_platform_registry_http_test: 'retained',
  }));
});

describe('Python registry client over real Express loopback HTTP', () => {
  it('preserves dedicated auth, rejects invalid evidence, and never retries failed reads', async () => {
    const configuredPython = process.env.PYTHON_EXECUTABLE || 'python';
    const python = path.isAbsolute(configuredPython) || /[\\/]/u.test(configuredPython)
      ? path.resolve(configuredPython) : configuredPython;
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
        initializeModuleRegistry.mockResolvedValue({ listRegisteredModules: () => [] });
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
      directRegistryHttpCount = observed.length;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 90_000);
  (process.platform === 'win32' ? it : it.skip)('runs the native Windows public CLI through real registry, status, and confirmation HTTP boundaries', async () => {
    const configuredPython = process.env.PYTHON_EXECUTABLE || 'python';
    const python = path.isAbsolute(configuredPython) || /[\\/]/u.test(configuredPython)
      ? path.resolve(configuredPython) : configuredPython;
    const userSite = spawnSync(python, ['-c', 'import site; print(site.getusersitepackages() if site.ENABLE_USER_SITE else "")'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    expect(userSite.status).toBe(0);
    const sandbox = mkdtempSync(path.join(tmpdir(), 'arcanos-native-express-'));
    const daemonPath = fileURLToPath(new URL('../daemon-python', import.meta.url));
    const fixture = fileURLToPath(new URL('./fixtures/daemon_registry_client.py', import.meta.url));
    const genericToken = 'synthetic-native-writing-http-token-1234567890';
    const credentials = { daemon: daemonToken, control: peerToken, gpt: genericToken };
    const health = [
      "What's your current system status?", 'Is ARCANOS healthy?', 'Are your backend and memory working?',
      'What is your trust state?', 'Are you functioning normally?', 'Run a system health check.',
      "What's your backend status?", 'Is the daemon connected securely?', 'deep: Is the backend healthy?',
      'backend: Can you check your system status?', '/deep Is ARCANOS healthy?',
      '/backend What is your trust state?', '/status',
    ];
    type Scenario = {
      name: string; commands: string[]; expectedTrust: string; gpt?: number; tty?: boolean;
      daemon?: string; serverDaemon?: boolean; serverCollision?: boolean; wire?: string;
      stateStatus?: number; fault?: string; faultBefore?: string; confirmation?: boolean;
      approvals?: number; accepted?: number; confirmRequests?: number; replay?: boolean;
      scope?: string; stateWire?: 'malformed' | 'unknown'; label?: string; diagnostics?: number;
      writingWire?: 'pending' | 'empty'; invalidChallenge?: boolean; historicalFull?: boolean;
      extraEnv?: Record<string, string>;
      debugRequest?: { message: string; route_override?: 'local' | 'backend' };
    };
    const scenarios: Scenario[] = [
      { name: 'operational questions and prefixes', commands: health, expectedTrust: 'FULL', gpt: 0 },
      { name: 'ordinary hypothetical and unrelated questions', commands: ['If the backend were healthy, what would happen?', "What's the status of my GitHub PR?"], expectedTrust: 'FULL', gpt: 2 },
      { name: 'missing daemon credential with normal conversation', commands: ['/status', 'Hello!'], daemon: '', expectedTrust: 'DEGRADED', gpt: 1 },
      { name: 'invalid daemon with independent control and writing', commands: ['/status', 'Help me write a Python function.'], daemon: wrongToken, expectedTrust: 'DEGRADED', gpt: 1 },
      { name: 'missing server daemon credential', commands: ['/status'], serverDaemon: false, expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'client credential collision', commands: ['/status'], daemon: peerToken, expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'writing credential cannot become daemon authority', commands: ['/status'], daemon: genericToken, expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'server credential collision', commands: ['/status'], serverCollision: true, expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'malformed registry envelope', commands: ['/status'], wire: 'malformed', expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'registry unavailable', commands: ['/status'], wire: 'unavailable', expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'authenticated registry recovery', commands: ['/status'], wire: 'recover', expectedTrust: 'FULL', gpt: 0 },
      { name: 'unavailable state is not diagnostic success', commands: ['/status'], stateStatus: 503, expectedTrust: 'FULL', gpt: 0 },
      { name: 'malformed state is not diagnostic success', commands: ['/status'], stateWire: 'malformed', expectedTrust: 'FULL', gpt: 0 },
      { name: 'missing control scope is denied', commands: ['/status'], scope: 'mcp:invoke', expectedTrust: 'FULL', gpt: 0 },
      { name: 'unknown state measurements stay unknown', commands: ['/status'], stateWire: 'unknown', expectedTrust: 'FULL', gpt: 0 },
      { name: 'work context protects credentials and literal Unicode', commands: ['What am I working on?', '/status'],
        label: 'Review [red]draft[/red] — café 👩‍💻 ' + daemonToken + ' ' + peerToken + ' ' + genericToken,
        diagnostics: 1, expectedTrust: 'FULL', gpt: 0 },
      { name: 'pending writing response is not completed', commands: ['Hello!'], writingWire: 'pending',
        extraEnv: { BACKEND_FALLBACK_TO_LOCAL: 'true' }, expectedTrust: 'FULL', gpt: 1 },
      { name: 'empty writing object is not completed', commands: ['Hello!'], writingWire: 'empty', expectedTrust: 'FULL', gpt: 1 },
      { name: 'expires during status read', commands: ['/status'], fault: 'expire-after-read', expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'expires while rendering one observation', commands: ['/status'], fault: 'expire-at-render', expectedTrust: 'FULL', gpt: 0 },
      { name: 'rollback cannot revive authority', commands: ['/status'], faultBefore: 'rollback-after-expiry', wire: 'fail-after-first', expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'invalid anchor cannot revive authority', commands: ['/status'], faultBefore: 'missing-anchor', wire: 'fail-after-first', expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'future receipt cannot establish authority', commands: ['/status'], faultBefore: 'future-wall', wire: 'fail-after-first', expectedTrust: 'DEGRADED', gpt: 0 },
      { name: 'authenticated debug diagnostic returns structured evidence', commands: [], diagnostics: 1,
        debugRequest: { message: 'Is ARCANOS healthy?', route_override: 'local' }, expectedTrust: 'FULL', gpt: 0 },
      { name: 'debug source cannot approve confirmation', commands: [], confirmation: true,
        tty: true, debugRequest: { message: 'Request the synthetic sensitive action.' }, expectedTrust: 'FULL', accepted: 0, confirmRequests: 0 },
      { name: 'noninteractive confirmation rejects', commands: ['Request the synthetic sensitive action.'], confirmation: true, expectedTrust: 'FULL', accepted: 0, confirmRequests: 0 },
      { name: 'historical FULL cannot authorize expired confirmation', commands: ['/status', 'Request the synthetic sensitive action.'],
        confirmation: true, historicalFull: true, faultBefore: 'expire', wire: 'fail-after-first',
        extraEnv: { BACKEND_FALLBACK_TO_LOCAL: 'true' }, expectedTrust: 'UNSAFE', accepted: 0, confirmRequests: 0 },
      ...process.platform === 'win32' ? [
        { name: 'explicit confirmation queues original action once', commands: ['Request the synthetic sensitive action.', 'y'], confirmation: true, tty: true, expectedTrust: 'FULL', accepted: 1, confirmRequests: 1 },
        { name: 'explicit rejection queues nothing', commands: ['Request the synthetic sensitive action.', 'n'], confirmation: true, tty: true, expectedTrust: 'FULL', accepted: 0, confirmRequests: 0 },
        { name: 'confirmation expires during operator wait', commands: ['Request the synthetic sensitive action.', 'y'], confirmation: true, tty: true, faultBefore: 'expire', expectedTrust: 'UNSAFE', accepted: 0, confirmRequests: 0 },
        { name: 'confirmation rollback cannot reuse authority', commands: ['Request the synthetic sensitive action.', 'y'], confirmation: true, tty: true, faultBefore: 'rollback-after-expiry', expectedTrust: 'UNSAFE', accepted: 0, confirmRequests: 0 },
        { name: 'confirmation missing backend fails closed', commands: ['Request the synthetic sensitive action.', 'y'], confirmation: true, tty: true, faultBefore: 'missing-backend', expectedTrust: 'UNSAFE', accepted: 0, confirmRequests: 0 },
        { name: 'confirmation missing anchor fails closed', commands: ['Request the synthetic sensitive action.', 'y'], confirmation: true, tty: true, faultBefore: 'missing-anchor', expectedTrust: 'UNSAFE', accepted: 0, confirmRequests: 0 },
        { name: 'confirmation future anchor fails closed', commands: ['Request the synthetic sensitive action.', 'y'], confirmation: true, tty: true, faultBefore: 'future-anchor', expectedTrust: 'UNSAFE', accepted: 0, confirmRequests: 0 },
        { name: 'invalid confirmation challenge queues nothing', commands: ['Request the synthetic sensitive action.', 'y'], confirmation: true, tty: true, invalidChallenge: true, expectedTrust: 'FULL', accepted: 0, confirmRequests: 1 },
        { name: 'confirmation replay cannot queue twice', commands: ['Request the synthetic sensitive action.', 'y', 'Request the synthetic sensitive action.', 'y'], confirmation: true, tty: true, replay: true, expectedTrust: 'FULL', accepted: 1, confirmRequests: 2 },
      ] : [],
    ];
    const launchEnvironment = Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT'].filter(name => process.env[name] !== undefined)
        .map(name => [name, process.env[name]!])
    );
    // The preceding direct-client matrix intentionally exhausts its real limiter.
    // A fresh real router has its own bounded native-test admission window.
    let nativeDaemonRouter = apiDaemonRouter;
    process.env.DAEMON_REGISTRY_RATE_LIMIT_MAX = '200';
    await jest.isolateModulesAsync(async () => {
      nativeDaemonRouter = (await import('../src/routes/api-daemon.js')).default;
    });
    initializeModuleRegistry.mockReset();
    initializeModuleRegistry.mockResolvedValue({ listRegisteredModules: () => [] });
    resolveGptRouting.mockImplementation(async (gptId: string) => ({
      ok: true, plan: { matchedId: gptId, module: 'ARCANOS:CORE', route: 'core', action: 'query',
        availableActions: ['query'], moduleVersion: null, moduleDescription: null, matchMethod: 'exact' },
      _route: { gptId, module: 'ARCANOS:CORE', route: 'core', action: 'query' },
    }));
    routeGptRequest.mockImplementation(async () => ({
      ok: true, result: { result: 'Synthetic ordinary answer — café 雪.', activeModel: 'fixture', tokens: 0, cost: 0 },
      _route: { gptId: 'arcanos-daemon', module: 'ARCANOS:CORE', route: 'core', action: 'query' },
    }));
    type Observation = {
      method: string; path: string; status?: number; envelope?: string;
      daemon: boolean; control: boolean; writing: boolean; binding?: boolean; accepted?: number;
      responseCode?: string;
      state?: { mode: string; intentFreshness: unknown; backendFreshness: unknown; connectedType: string; registryAvailableType: string };
    };
    const observed: Observation[] = [];
    let current = scenarios[0];
    let registryReads = 0;
    let accepted = 0;
    let originalChallenge: string | undefined;
    let originalInstance: string | undefined;
    const confirmationInstances = new Set<string>();
    const reports: object[] = [];
    const app = express();
    app.use((req, res, next) => {
      const row: Observation = {
        method: req.method, path: req.path,
        daemon: req.get('x-arcanos-daemon-token') === daemonToken && !req.get('Authorization') && !req.get('Cookie') && !req.get('x-gpt-id'),
        control: req.get('Authorization') === 'Bearer ' + peerToken && !req.get('x-arcanos-daemon-token') && !req.get('Cookie') && !req.get('x-gpt-id'),
        writing: req.get('Authorization') === 'Bearer ' + genericToken && !req.get('x-arcanos-daemon-token') && !req.get('Cookie'),
      };
      observed.push(row);
      if (current.label && req.path === '/system-state' && typeof req.query.sessionId === 'string') {
        const seeded = recordChatIntent('Synthetic controlled intent', req.query.sessionId);
        updateIntentWithOptimisticLock(seeded.version, { label: current.label }, req.query.sessionId);
      }
      res.once('finish', () => { row.status = res.statusCode; });
      const sendBody = res.send.bind(res);
      res.send = body => {
        if (row.path === '/gpt/arcanos-daemon' && current.writingWire) {
          res.status(current.writingWire === 'pending' ? 202 : 200).type('application/json');
          row.envelope = current.writingWire === 'pending' ? 'writing_pending' : 'writing_empty_object';
          return sendBody(JSON.stringify({
            ok: true, result: current.writingWire === 'pending' ? { status: 'pending', jobId: 'synthetic-job' } : {},
          }));
        }
        return sendBody(body);
      };
      const send = res.json.bind(res);
      res.json = body => {
        if (req.path === '/api/daemon/registry') {
          registryReads += 1;
          if (current.wire === 'unavailable' || current.wire === 'recover' && registryReads === 1
            || current.wire === 'fail-after-first' && registryReads > 1) {
            res.status(503); body = { error: 'Synthetic registry outage' };
          } else if (current.wire === 'malformed' && res.statusCode === 200) {
            body = { ok: true, error: 'Not registry evidence' };
          }
        }
        if (req.path === '/system-state' && current.stateStatus) {
          res.status(current.stateStatus); body = { error: 'Synthetic state outage' };
        }
        if (req.path === '/system-state' && res.statusCode === 200) {
          if (current.stateWire === 'malformed') body = { mode: 'system_state', error: 'Missing required sections' };
          if (current.stateWire === 'unknown') body = {
            ...body, intent: { ...body.intent, confidence: null, version: null },
            backend: { connected: null, registryAvailable: null },
            stateFreshness: { intent: null, backend: 'unknown' }, generatedAt: null,
          };
          if (body?.mode === 'system_state' && body?.stateFreshness) row.state = {
            mode: body.mode, intentFreshness: body.stateFreshness.intent, backendFreshness: body.stateFreshness.backend,
            connectedType: body.backend.connected === null ? 'null' : typeof body.backend.connected,
            registryAvailableType: body.backend.registryAvailable === null ? 'null' : typeof body.backend.registryAvailable,
          };
        }
        row.envelope = body?.mode === 'system_state' ? 'system_state'
          : body?.version === 1 && Array.isArray(body?.endpoints) ? 'registry_v1'
          : body?.code === 'CONFIRMATION_REQUIRED' ? 'confirmation_challenge'
          : typeof body?.queued === 'number' ? 'confirmation_result' : res.statusCode >= 400 ? 'error' : 'writing_or_heartbeat';
        if (typeof body?.error?.code === 'string') row.responseCode = body.error.code;
        if (req.path === '/api/daemon/confirm-actions') {
          row.binding = req.body?.confirmation_token === originalChallenge && req.body?.instanceId === originalInstance;
          row.accepted = typeof body?.queued === 'number' ? body.queued : 0;
          accepted += row.accepted;
        }
        return send(body);
      };
      next();
    });
    app.use(systemStateRouter);
    app.use(express.json());
    app.use(nativeDaemonRouter);
    // Canonical writing has no daemon challenge producer. This explicitly
    // synthetic provider seam issues a real store-bound challenge; auth,
    // confirmation HTTP, instance binding, replay and queue logic remain real.
    app.post('/gpt/arcanos-daemon', (req, res, next) => {
      if (!current.confirmation) return next();
      const instanceId = req.body?.metadata?.instanceId;
      if (typeof instanceId !== 'string') return res.status(400).json({ error: 'Instance metadata required' });
      if (!current.replay || !originalChallenge) {
        originalInstance = instanceId;
        originalChallenge = createPendingDaemonActions(instanceId, [{
          daemon: 'fixture_inert_action', payload: { marker: 'synthetic-no-execution' },
          summary: 'Review [red]draft[/red] — café 👩‍💻 ' + daemonToken + ' ' + peerToken + ' ' + genericToken,
        }]);
      }
      return res.status(403).json({
        code: 'CONFIRMATION_REQUIRED', confirmationChallenge: { id: current.invalidChallenge ? 'invalid-synthetic-challenge' : originalChallenge },
        pending_actions: [{ summary: 'Review [red]draft[/red] — café 👩‍💻 ' + daemonToken + ' ' + peerToken + ' ' + genericToken }],
      });
    });
    app.use('/gpt', gptRouter);
    app.use(((error, _req, res, _next) => {
      let message = error instanceof Error ? error.message : 'Unknown fixture dependency failure';
      for (const token of [daemonToken, wrongToken, peerToken, genericToken]) message = message.replaceAll(token, '[REDACTED]');
      res.status(500).json({ error: { code: message } });
    }) satisfies ErrorRequestHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve); server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback address');
    let primaryFailure = false;
    let activeCaseStart = 0;
    try {
      for (const [index, scenario] of scenarios.entries()) {
        current = scenario; registryReads = 0; accepted = 0; originalChallenge = originalInstance = undefined;
        for (const name of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) delete process.env[name];
        if (scenario.serverDaemon !== false) process.env.ARCANOS_DAEMON_ACCESS_TOKEN = daemonToken;
        process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = scenario.serverCollision ? daemonToken : peerToken;
        process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:synthetic-native-' + index;
        process.env.ARCANOS_CONTROL_PLANE_SCOPES = scenario.scope ?? 'arcanos:read,mcp:invoke';
        const scenarioPath = path.join(sandbox, 'scenario-' + index + '.json');
        const receiptPath = path.join(sandbox, 'receipt-' + index + '.json');
        writeFileSync(scenarioPath, JSON.stringify({
          name: scenario.name, credentials: { ...credentials, daemon: scenario.daemon ?? daemonToken },
          tty: scenario.tty ?? false, heartbeat: !!scenario.confirmation,
          speak: !scenario.confirmation, fault: scenario.fault,
          extraEnv: scenario.extraEnv,
          debugRequest: scenario.debugRequest,
          steps: [...scenario.commands.map((input, step) => ({
            input, ...scenario.faultBefore && step === (scenario.confirmation ? 1 : 0) ? { faultBefore: scenario.faultBefore } : {},
          })), { input: '/exit' }],
        }));
        const before = observed.length;
        activeCaseStart = before;
        const beforeDispatches = routeGptRequest.mock.calls.length;
        const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
          const child = spawn(python, ['-B', fixture, '--native', daemonPath,
            'http://127.0.0.1:' + address.port, scenarioPath, receiptPath], {
            cwd: sandbox, env: { ...launchEnvironment, PYTHONIOENCODING: 'utf-8',
              PYTHONPATH: userSite.stdout.trim(), ACCEPTANCE_PYTHON_USER_SITE: userSite.stdout.trim() },
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 80_000,
          });
          let stdout = '', stderr = '';
          child.stdout.on('data', chunk => { stdout += chunk.toString(); });
          child.stderr.on('data', chunk => { stderr += chunk.toString(); });
          child.once('error', reject);
          child.once('close', code => resolve({ stdout, stderr, code }));
        });
        if (!existsSync(receiptPath)) throw new Error(
          'Native case ' + scenario.name + ' produced no receipt; controller exit=' + output.code
          + ', stderr bytes=' + Buffer.byteLength(output.stderr),
        );
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        const expectedNativeStderr = scenario.debugRequest && !scenario.tty
          ? expect.stringMatching(new RegExp('^127\\.0\\.0\\.1 - - \\[[^\\]]+\\] "POST /debug/ask HTTP/1\\.1" '
            + (scenario.confirmation ? '500' : '200') + ' -\\r?\\n$')) : '';
        expect({ name: scenario.name, ...output, failure: receipt.failure, native_stderr: receipt.stderr })
          .toEqual({ name: scenario.name, stdout: '', stderr: '', code: 0, failure: null, native_stderr: expectedNativeStderr });
        expect(receipt.public_entrypoint).toBe(true);
        expect(receipt.entrypoint.slice(-3)).toEqual(['-u', '-m', 'arcanos.cli']);
        const initialized = receipt.observations.find((event: { event: string }) => event.event === 'initialized');
        expect(path.resolve(initialized.source_file).toLowerCase()).toBe(path.join(daemonPath, 'arcanos', 'cli', 'cli.py').toLowerCase());
        expect(initialized.python_executable).toBe(receipt.entrypoint[0]);
        expect(receipt.exit_code).toBe(0);
        expect(receipt.audit_parse_errors).toBe(0);
        expect(receipt.cleanup).toMatchObject({ child_closed: true, forced_termination: false });
        if (!scenario.tty) expect(receipt.cleanup.owned_windows_job_closed).toBe(true);
        expect(Object.values(receipt.leaks).every(value => value === false)).toBe(true);
        expect(receipt.leaks).toMatchObject({
          terminal: false, logs: false, history: false, speech: false, results: false,
          context: false, prompt: false, audit: false,
        });
        if (scenario.debugRequest) {
          expect(receipt.leaks.debug_json).toBe(false);
          expect(receipt.debug_response).toMatchObject({ method: 'POST', path: '/debug/ask', status: scenario.confirmation ? 500 : 200 });
          expect(receipt.speech).toHaveLength(0);
          if (!scenario.confirmation) expect(receipt.debug_response.payload).toMatchObject({
            ok: true, source: 'diagnostic', tokens_used: '[REDACTED]', cost_usd: 0,
          });
        }
        const guard = receipt.network.find((event: { event: string }) => event.event === 'guard_installed');
        expect(guard.stdin_isatty).toBe(!!scenario.tty);
        expect(receipt.network.filter((event: { event: string }) => event.event === 'socket.connect')
          .every((event: { host: string; port: number; allowed: boolean }) =>
            event.allowed && event.host === '127.0.0.1' && guard.allowed_ports.includes(event.port))).toBe(true);
        const blockedNetwork = receipt.network.filter((event: { allowed?: boolean }) => event.allowed === false);
        // urllib3 probes IPv6 support by binding ::1:0 during import. The guard
        // continues to deny it; no connection or external name lookup is allowed.
        const deniedCapabilityProbes = blockedNetwork.filter((event: { event: string; host: string; port: number }) =>
          event.event === 'socket.bind' && event.host === '::1' && event.port === 0);
        expect(deniedCapabilityProbes.length).toBeLessThanOrEqual(1);
        expect({ name: scenario.name, blocked: blockedNetwork }).toEqual({ name: scenario.name, blocked: deniedCapabilityProbes });
        if (scenario.fault || scenario.faultBefore) expect(receipt.observations.some((event: { event: string; kind?: string }) =>
          event.event === 'injected_fault' && event.kind === (scenario.fault ?? scenario.faultBefore))).toBe(true);
        expect(receipt.final_state.trust).toBe(scenario.expectedTrust);
        const rows = observed.slice(before);
        const stateRows = rows.filter(row => row.path === '/system-state');
        expect(stateRows.every(row => row.control)).toBe(true);
        if (!scenario.serverCollision) expect(stateRows.map(row => row.status))
          .toEqual(stateRows.map(() => scenario.stateStatus ?? (scenario.scope ? 403 : 200)));
        const gptRows = rows.filter(row => row.path === '/gpt/arcanos-daemon');
        const confirmRows = rows.filter(row => row.path === '/api/daemon/confirm-actions');
        expect(confirmRows).toHaveLength(scenario.confirmRequests ?? 0);
        const partition = originalInstance ? daemonStore.getTokenForInstance(originalInstance) : null;
        const queuedActions = partition && originalInstance ? daemonStore.listPendingCommands(partition, originalInstance) : [];
        expect(accepted).toBe(scenario.accepted ?? 0);
        expect(queuedActions).toHaveLength(scenario.accepted ?? 0);
        expect(confirmRows.every(row => row.daemon && row.binding === !scenario.invalidChallenge)).toBe(true);
        for (const action of queuedActions) expect({ name: action.name, payload: action.payload, bound: action.instanceId === originalInstance })
          .toEqual({ name: 'fixture_inert_action', payload: { marker: 'synthetic-no-execution' }, bound: true });
        if (originalInstance) {
          expect(confirmationInstances.has(originalInstance)).toBe(false);
          confirmationInstances.add(originalInstance);
        }
        expect(receipt.observations.some((event: { event: string }) => event.event === 'local_generation_attempt')).toBe(false);
        if (!scenario.confirmation) expect(gptRows).toHaveLength(scenario.gpt ?? 0);
        if (scenario.gpt) expect({ name: scenario.name, requests: gptRows }).toEqual({
          name: scenario.name, requests: gptRows.map(row => ({ ...row, writing: true, status: scenario.writingWire === 'pending' ? 202 : 200 })),
        });
        if (scenario.daemon === '' || scenario.daemon === peerToken || scenario.daemon === genericToken) {
          expect(rows.filter(row => row.path === '/api/daemon/registry')).toHaveLength(0);
        }
        if (!scenario.confirmation) {
          const diagnostics = receipt.observations.filter((event: { event: string }) => event.event === 'diagnostic_result');
          expect(diagnostics).toHaveLength(scenario.diagnostics ?? scenario.commands.length - (scenario.gpt ?? 0));
          if (scenario.name === 'operational questions and prefixes') {
            expect(receipt.speech).toHaveLength(scenario.commands.filter(input => input !== '/status').length);
            for (const spoken of receipt.speech) {
              expect(spoken.length).toBeLessThanOrEqual(600);
              expect(spoken).toContain('Daemon trust (local): FULL');
              expect(spoken).toContain('Daemon registry evidence (local): valid and fresh');
              expect(['Backend dependency health', 'Memory availability', 'Memory consistency', 'Audit-safe mode',
                'Intent tracking correctness', 'Overall stability and risk']
                .every(label => spoken.includes(label + ': unknown'))).toBe(true);
            }
          }
          for (const observation of diagnostics) {
            expect(observation.text).toContain('Daemon trust (local): ' + scenario.expectedTrust);
            for (const label of ['Memory availability', 'Memory consistency', 'Overall stability and risk']) {
              expect(observation.text).toContain(label + ': unknown');
            }
            const full = observation.text.includes('Daemon trust (local): FULL');
            if (full) expect(observation.text).toContain('Daemon registry evidence (local): valid and fresh');
          }
          const terminal = receipt.audits.filter((event: { event: string; source?: string }) =>
            ['execute_success', 'execute_failed'].includes(event.event) && event.source === 'diagnostic');
          expect(terminal).toHaveLength(diagnostics.length);
          expect(terminal.every((event: { trust: string }) => event.trust === scenario.expectedTrust)).toBe(true);
          const diagnosticAudits = receipt.audits.filter((event: { event: string; source?: string }) =>
            event.event.startsWith('execute_') && event.source === 'diagnostic');
          expect(diagnosticAudits).toHaveLength(diagnostics.length * 2);
          for (let offset = 0; offset < diagnosticAudits.length; offset += 2) {
            expect(diagnosticAudits[offset].event).toBe('execute_attempt');
            expect(diagnosticAudits[offset + 1].command).toBe(diagnosticAudits[offset].command);
            expect(diagnosticAudits[offset + 1].operation).toBe('status');
          }
          if (scenario.stateStatus || scenario.stateWire === 'malformed' || scenario.scope) {
            expect(terminal.every((event: { event: string }) => event.event === 'execute_failed')).toBe(true);
          }
          if (scenario.writingWire || !scenario.gpt) expect(receipt.history).toHaveLength(0);
          else {
            expect(receipt.history.map((turn: { ai: string }) => turn.ai))
              .toEqual(Array(scenario.gpt).fill('Synthetic ordinary answer — café 雪.'));
            expect(receipt.printed_output).toContain('Synthetic ordinary answer — café 雪.');
            expect(receipt.final_state.last_response).toBe('Synthetic ordinary answer — café 雪.');
            for (const parsed of receipt.observations.filter((event: { event: string }) => event.event === 'conversation_result')) {
              expect(parsed.value).toMatchObject({ tokens_used: 0, cost_usd: 0, source: 'backend' });
            }
          }
          if (scenario.label) {
            expect(receipt.printed_output).toContain('Review [red]draft[/red] — café 👩‍💻');
            expect(receipt.final_state.current_intent).toContain('Review [red]draft[/red] — café 👩‍💻');
          }
          if (scenario.stateWire === 'unknown') expect(receipt.printed_output).toContain('Backend-reported connection: unknown');
          if (scenario.writingWire) {
            expect(receipt.audits.filter((event: { event: string }) => event.event === 'execute_success')).toHaveLength(0);
            if (scenario.writingWire === 'pending') {
              expect(receipt.audits.filter((event: { event: string }) => event.event.startsWith('execute_'))
                .map((event: { event: string }) => event.event)).toEqual(['execute_attempt', 'execute_unconfirmed']);
              expect(receipt.printed_output).toContain('Backend request is pending; no completed answer is available.');
              expect(receipt.speech).toHaveLength(0);
            }
          }
        } else if (scenario.historicalFull) {
          expect(receipt.observations.find((event: { event: string }) => event.event === 'diagnostic_result').text)
            .toContain('Daemon trust (local): FULL');
          expect(receipt.final_state.last_confirmation_handled).toBe(true);
          expect(receipt.final_state.prompt_claims_fresh).toBe(false);
        }
        reports.push({
          name: scenario.name, native_http_requests: rows.length, accepted_actions: queuedActions.length, wire_queued_count: accepted,
          requests: rows.map(row => ({ ...row })), native_transport: receipt.transport,
          confirmation_submissions: confirmRows.length, provider_dispatches: routeGptRequest.mock.calls.length - beforeDispatches,
          privacy: 'PASS', cleanup: 'PASS',
          denied_ipv6_capability_probes: deniedCapabilityProbes.length, nonfixture_connections: 0,
          debug_http: receipt.debug_response ? { method: 'POST', path: '/debug/ask', status: receipt.debug_response.status,
            envelope: scenario.confirmation ? 'explicit_failure' : 'diagnostic_result' } : null,
        });
      }
      const nativeRequestCount = reports.reduce((count, report) => count + (report as { native_http_requests: number }).native_http_requests, 0);
      const debugRequestCount = reports.filter(report => (report as { debug_http: object | null }).debug_http).length;
      const ttyCasesRun = reports.filter(report => (report as { native_transport: string }).native_transport === 'Windows ConPTY').length;
      const aggregate = {
        result: 'PASS',
        platform: process.platform, cases_run: reports.length, WindowsTTY_cases_run: ttyCasesRun,
        WindowsTTY_cases_NOT_RUN: scenarios.filter(scenario => scenario.tty).length - ttyCasesRun,
        direct_registry_matrix_http_requests: directRegistryHttpCount,
        native_express_http_requests: nativeRequestCount, native_debug_http_requests: debugRequestCount,
        HTTP_E2E_REQUEST_COUNT: (directRegistryHttpCount ?? 0) + nativeRequestCount + debugRequestCount,
        cases: reports,
        synthetic_challenge_issuance: true, production_challenge_generation: 'NOT_PROVEN',
        writing_server_policy: 'actual public GPT route and provider admission; header selection is not bearer authentication',
        paid_provider_calls: 0,
      };
      if (process.env.ARCANOS_NATIVE_HTTP_RECEIPT) writeFileSync(process.env.ARCANOS_NATIVE_HTTP_RECEIPT, JSON.stringify(aggregate, null, 2));
      console.log('[ARCANOS_NATIVE_EXPRESS_ACCEPTANCE] ' + JSON.stringify(aggregate));
    } catch (error) {
      primaryFailure = true;
      const failure = {
        result: 'FAILED', case: current.name, completed_cases: reports.length,
        requests: observed.slice(activeCaseStart), primary_error_type: error instanceof Error ? error.name : 'Unknown',
      };
      try {
        if (process.env.ARCANOS_NATIVE_HTTP_RECEIPT) writeFileSync(process.env.ARCANOS_NATIVE_HTTP_RECEIPT, JSON.stringify(failure, null, 2));
      } catch {
        console.error('[ARCANOS_NATIVE_EXPRESS_RECEIPT_FAILURE] Primary test failure is preserved.');
      }
      console.error('[ARCANOS_NATIVE_EXPRESS_FAILURE] ' + JSON.stringify(failure));
      throw error;
    } finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        console.error('[ARCANOS_NATIVE_EXPRESS_CLEANUP_FAILURE] ' + JSON.stringify({
          code: error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN',
          primary_failure_preserved: primaryFailure,
        }));
        if (!primaryFailure) throw error;
      }
    }
  }, 180_000);
});

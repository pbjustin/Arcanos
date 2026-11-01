import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// Real SDK, canonical adapter, provider-health orchestration and native HTTP.
// Only durable budget/job-event storage is replaced; no PostgreSQL or paid provider is used.
const reserveWorkerAiProviderAttemptMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@core/db/repositories/workerBudgetRepository.js', () => ({
  reserveWorkerAiProviderAttempt: reserveWorkerAiProviderAttemptMock,
  WORKER_BUDGET_NON_JOB_SUBJECT_ID: '00000000-0000-0000-0000-000000000000'
}));
jest.unstable_mockModule('@core/db/repositories/jobEventRepository.js', () => ({ recordJobEvent: jest.fn() }));

const environmentNames = [
  'OPENAI_API_KEY', 'RAILWAY_OPENAI_API_KEY', 'API_KEY', 'OPENAI_KEY',
  'OPENAI_BASE_URL', 'OPENAI_API_BASE_URL', 'OPENAI_API_BASE',
  'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_WEBHOOK_SECRET', 'FORCE_MOCK',
] as const;
const originalEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
for (const name of environmentNames) delete process.env[name];
process.env.OPENAI_API_KEY = 'sk-test-loopback-provider-health';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1';

const originalFetch = globalThis.fetch;
const providers: LoopbackProvider[] = [];
const pending = new Set<Promise<unknown>>();
const holds: Array<{ release: (status?: number) => void }> = [];
let transportCalls = 0;
let rejectedExternalCalls = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const target = new URL(request.url);
  if (request.method !== 'GET' || !providers.some(provider =>
    target.origin === provider.origin && target.pathname === `${provider.prefix}/models`
  )) {
    rejectedExternalCalls += 1;
    throw new Error('Loopback provider acceptance forbids this transport.');
  }
  transportCalls += 1;
  return originalFetch(request, { redirect: 'error' });
};

const { configureBackendUnifiedOpenAIClient } = await import('../src/core/init-openai.js');
const { resetOpenAIAdapter, WorkerAiCallBudgetPausedError } = await import('../src/core/adapters/openai.adapter.js');
const { resetClient } = await import('@arcanos/openai/unifiedClient');
const { resetCredentialCache } = await import('../src/services/openai/credentialProvider.js');
const {
  getOpenAIServiceHealth, getOpenAIProviderRuntimeStatus, probeOpenAIProviderHealth,
  reinitializeOpenAIProvider, validateAPIKeyAtStartup
} = await import('../src/services/openai/serviceHealth.js');
const { createAiExecutionContext, runWithAiExecutionContext } = await import('../src/services/openai/aiExecutionContext.js');
const { getCircuitBreakerSnapshot } = await import('../src/services/openai/resilience.js');

interface ObservedRequest {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  receivedAt: number;
}
interface LoopbackProvider {
  server: Server;
  sockets: Set<Socket>;
  origin: string;
  prefix: string;
  requests: ObservedRequest[];
  actions: Array<(response: ServerResponse) => void>;
}

function respond(response: ServerResponse, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(status === 200 ? { object: 'list', data: [] } : {
    error: { message: 'Loopback authentication refused', type: 'authentication_error', code: 'invalid_api_key', param: null }
  }));
}

async function createProvider(prefix = '/v1'): Promise<LoopbackProvider> {
  const provider: LoopbackProvider = {
    server: createServer(), sockets: new Set(), origin: '', prefix, requests: [], actions: []
  };
  provider.server.on('connection', socket => {
    provider.sockets.add(socket);
    socket.once('close', () => provider.sockets.delete(socket));
  });
  provider.server.on('request', (request, response) => {
    provider.requests.push({ method: request.method, path: request.url,
      authorization: request.headers.authorization, receivedAt: Date.now() });
    (provider.actions.shift() ?? respond)(response);
  });
  await new Promise<void>((resolve, reject) => {
    provider.server.once('error', reject);
    provider.server.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener did not acquire a TCP port.');
  provider.origin = `http://127.0.0.1:${address.port}`;
  providers.push(provider);
  return provider;
}

function selectProvider(provider: LoopbackProvider, apiKey = 'sk-test-loopback-provider-health'): void {
  process.env.OPENAI_API_KEY = apiKey;
  process.env.OPENAI_BASE_URL = `${provider.origin}${provider.prefix}`;
}

function track<T>(operation: Promise<T>): Promise<T> {
  pending.add(operation);
  void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  return operation;
}

function holdNextResponse(provider: LoopbackProvider) {
  let response: ServerResponse | undefined;
  let releasedStatus: number | undefined;
  let reached!: () => void;
  let markClosed!: () => void;
  const received = new Promise<void>(resolve => { reached = resolve; });
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  provider.actions.push(incoming => {
    response = incoming;
    response.once('close', markClosed);
    reached();
    if (releasedStatus !== undefined) respond(response, releasedStatus);
  });
  const hold = { received, closed, release: (status = 200) => {
    if (releasedStatus !== undefined) return;
    releasedStatus = status;
    if (response && !response.destroyed) respond(response, status);
  } };
  holds.push(hold);
  return hold;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Loopback acceptance timed out: ${label}`);
    await delay(5);
  }
}

async function waitForRetry(nextRetryAt: string | null): Promise<void> {
  if (nextRetryAt === null) throw new Error('Failure did not expose its retry boundary.');
  await delay(Math.max(0, Date.parse(nextRetryAt) - Date.now()) + 5);
}

function workerContext() {
  return createAiExecutionContext({ sourceType: 'background', sourceName: 'loopback_provider_acceptance',
    workerBudget: { statsWorkerId: 'async-queue', workerId: 'loopback-worker', maxCallsPerHour: 2 } });
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Loopback acceptance timed out: ${label}`)), 2500);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function admission(allowed = true) {
  return { kind: 'ai_provider_attempt', statsWorkerId: 'async-queue', allowed,
    used: allowed ? 1 : 2, limit: 2, remaining: allowed ? 1 : 0,
    evaluatedAt: new Date().toISOString(), nextAvailableAt: allowed ? null : new Date(Date.now() + 60_000).toISOString() };
}

let provider: LoopbackProvider;
beforeEach(async () => {
  reserveWorkerAiProviderAttemptMock.mockReset().mockResolvedValue(admission());
  provider = await createProvider();
  selectProvider(provider);
  resetClient();
  resetOpenAIAdapter();
  resetCredentialCache();
  configureBackendUnifiedOpenAIClient();
  await expect(probeOpenAIProviderHealth({ force: true, source: 'loopback_fixture_reset' })).resolves.toMatchObject({ ok: true });
  provider.requests.length = 0;
  transportCalls = 0;
  rejectedExternalCalls = 0;
});

afterEach(async () => {
  for (const hold of holds.splice(0)) hold.release();
  await Promise.allSettled([...pending]);
  resetClient();
  resetOpenAIAdapter();
  resetCredentialCache();
  for (const fixture of providers.splice(0)) {
    for (const socket of fixture.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => fixture.server.close(error => error ? reject(error) : resolve()));
  }
  expect(rejectedExternalCalls).toBe(0);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const name of environmentNames) {
    const original = originalEnvironment.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

describe('provider health through actual SDK and loopback HTTP', () => {
  it('records a successful models transport and makes no requests during healthy idle reads', async () => {
    const result = await track(probeOpenAIProviderHealth({ force: true, source: 'loopback_success' }));
    expect(result).toMatchObject({ ok: true, skipped: false, runtime: { consecutiveFailures: 0, nextRetryAt: null } });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models' });
    for (let tick = 0; tick < 1000; tick += 1) expect(getOpenAIServiceHealth().providerRuntime.consecutiveFailures).toBe(0);
    expect(transportCalls).toBe(1);
    expect(provider.requests).toHaveLength(1);
  });

  it('classifies an actual socket disconnect as transient network failure with no SDK retry', async () => {
    const breakerBefore = getCircuitBreakerSnapshot().state;
    provider.actions.push(response => response.destroy());
    const result = await track(probeOpenAIProviderHealth({ force: true, source: 'loopback_disconnect' }));
    expect(result).toMatchObject({ ok: false, skipped: false, runtime: {
      lastFailureCategory: 'network', lastFailureStatus: null, consecutiveFailures: 1
    } });
    expect(transportCalls).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(getOpenAIServiceHealth().providerRuntime.authenticationBlocked).toBe(false);
    await expect(probeOpenAIProviderHealth()).resolves.toMatchObject({ skipped: true, reason: 'provider_backoff_active' });
    expect(transportCalls).toBe(1);
    await waitForRetry(result.runtime.nextRetryAt);
    const recovered = await track(probeOpenAIProviderHealth({ source: 'loopback_disconnect_recovery' }));
    expect(recovered).toMatchObject({ ok: true, runtime: {
      lastFailureAt: result.runtime.lastFailureAt, lastFailureCategory: null,
      consecutiveFailures: 0, backoffMs: 0, nextRetryAt: null
    } });
    expect(Date.parse(recovered.runtime.lastSuccessAt!)).toBeGreaterThan(Date.parse(result.runtime.lastFailureAt!));
    expect(transportCalls).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(getCircuitBreakerSnapshot().state).toBe(breakerBefore);
  });

  it('retains an HTTP 401 until an explicit successful probe without duplicate authentication retries', async () => {
    provider.actions.push(response => respond(response, 401));
    const failed = await track(probeOpenAIProviderHealth({ force: true, source: 'loopback_authentication' }));
    expect(failed).toMatchObject({ ok: false, runtime: {
      lastFailureCategory: 'authentication', lastFailureStatus: 401, consecutiveFailures: 1
    } });
    expect(getOpenAIServiceHealth().providerRuntime.authenticationBlocked).toBe(true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(reinitializeOpenAIProvider({
        ignoreBackoff: true, suppressUnchangedAuthenticationProbe: true, source: 'loopback_unchanged_authentication'
      })).resolves.toMatchObject({ skipped: true, reason: 'provider_authentication_unchanged' });
    }
    expect(transportCalls).toBe(1);
    expect(provider.requests).toHaveLength(1);
    const recovered = await track(reinitializeOpenAIProvider({ ignoreBackoff: true, source: 'loopback_explicit_authentication_recovery' }));
    expect(recovered).toMatchObject({ ok: true, runtime: { lastFailureCategory: null, nextRetryAt: null } });
    expect(getOpenAIServiceHealth().providerRuntime.authenticationBlocked).toBe(false);
    expect(transportCalls).toBe(2);
    expect(provider.requests).toHaveLength(2);
  });

  it('aborts an actual pending HTTP response at the probe deadline, then recovers after backoff', async () => {
    const hold = holdNextResponse(provider);
    const probe = track(probeOpenAIProviderHealth({ force: true, timeoutMs: 1000, source: 'loopback_timeout' }));
    try {
      await bounded(hold.received, 'timeout transport arrival');
      const failed = await probe;
      expect(failed).toMatchObject({ ok: false, runtime: {
        lastFailureCategory: 'timeout', lastFailureStatus: null, consecutiveFailures: 1
      } });
      await bounded(hold.closed, 'aborted HTTP socket closure');
      expect(Date.parse(failed.runtime.lastFailureAt!)).toBeGreaterThan(Date.parse(failed.runtime.lastAttemptAt!));
      expect(Date.parse(failed.runtime.lastFailureAt!)).toBeGreaterThanOrEqual(provider.requests[0]!.receivedAt);
      await expect(probeOpenAIProviderHealth()).resolves.toMatchObject({ skipped: true, reason: 'provider_backoff_active' });
      expect(transportCalls).toBe(1);
      await waitForRetry(failed.runtime.nextRetryAt);
      expect(transportCalls).toBe(1);
      await expect(track(probeOpenAIProviderHealth({ source: 'loopback_timeout_recovery' }))).resolves.toMatchObject({
        ok: true, runtime: { lastFailureAt: failed.runtime.lastFailureAt, consecutiveFailures: 0, nextRetryAt: null }
      });
      expect(provider.requests).toHaveLength(2);
      expect(transportCalls).toBe(2);
    } finally {
      hold.release();
      await probe;
    }
  });

  it('returns startup validation before real provider transport completion', async () => {
    const hold = holdNextResponse(provider);
    const previous = getOpenAIProviderRuntimeStatus();
    // Ensure the startup attempt has a distinct timestamp, including on a fast loopback host.
    await delay(5);
    const settled = track(waitFor(() => getOpenAIProviderRuntimeStatus().lastAttemptAt !== previous.lastAttemptAt,
      'startup probe settlement', 5000));
    try {
      expect(validateAPIKeyAtStartup()).toBe(true);
      expect(getOpenAIProviderRuntimeStatus().lastSuccessAt).toBe(previous.lastSuccessAt);
      await bounded(hold.received, 'startup transport arrival');
      expect(provider.requests).toHaveLength(1);
      await delay(15);
    } finally {
      hold.release();
      // Drain success or failure even if an earlier assertion fails.
      await settled;
    }
    expect(transportCalls).toBe(1);
    expect(getOpenAIProviderRuntimeStatus().consecutiveFailures).toBe(0);
    expect(getOpenAIProviderRuntimeStatus().lastSuccessAt).not.toBe(previous.lastSuccessAt);
  });

  it('contains overlapping forced attempts to one transport and timestamps completion after the held response', async () => {
    const hold = holdNextResponse(provider);
    const first = track(probeOpenAIProviderHealth({ force: true, timeoutMs: 1000 }));
    let releasedAt = 0;
    try {
      await bounded(hold.received, 'concurrent transport arrival');
      const before = getOpenAIProviderRuntimeStatus();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await expect(probeOpenAIProviderHealth({ force: true })).resolves.toMatchObject({
          skipped: true, reason: 'provider_probe_in_flight', runtime: before
        });
      }
      await expect(reinitializeOpenAIProvider({ ignoreBackoff: true })).resolves.toMatchObject({
        skipped: true, reason: 'provider_probe_in_flight'
      });
      expect(transportCalls).toBe(1);
      await delay(15);
    } finally {
      releasedAt = Date.now();
      hold.release();
      await first;
    }
    const result = await first;
    expect(result.ok).toBe(true);
    expect(Date.parse(result.runtime.lastAttemptAt!)).toBeLessThanOrEqual(provider.requests[0]!.receivedAt);
    expect(Date.parse(result.runtime.lastSuccessAt!)).toBeGreaterThanOrEqual(releasedAt);
    expect(Date.parse(result.runtime.lastSuccessAt!)).toBeGreaterThan(Date.parse(result.runtime.lastAttemptAt!));
    expect(provider.requests).toHaveLength(1);
  });

  it.each([
    ['credential', 200], ['credential', 401], ['endpoint', 200], ['endpoint', 401], ['both', 200], ['both', 401]
  ] as const)('checks the replacement %s exactly once after the superseded HTTP %s response', async (change, oldStatus) => {
    const hold = holdNextResponse(provider);
    const first = track(probeOpenAIProviderHealth({ force: true, timeoutMs: 1000, source: 'loopback_old_provider' }));
    const replacements: Array<Promise<unknown>> = [];
    try {
      await bounded(hold.received, 'replacement initial transport');
      const target = change === 'credential' ? provider : await createProvider('/proxy/v1');
      const key = change === 'endpoint' ? 'sk-test-loopback-provider-health' : 'sk-test-loopback-replacement';
      selectProvider(target, key);
      const replacement = track(reinitializeOpenAIProvider({ ignoreBackoff: true, source: 'loopback_replacement' }));
      const concurrent = track(reinitializeOpenAIProvider({ ignoreBackoff: true, source: 'loopback_replacement_concurrent' }));
      replacements.push(replacement, concurrent);
      await delay(15);
      expect(transportCalls).toBe(1);
      const replacedState = getOpenAIProviderRuntimeStatus();
      hold.release(oldStatus);
      await expect(first).resolves.toEqual({
        ok: false, skipped: true, reason: 'provider_configuration_changed', runtime: replacedState
      });
      await expect(replacement).resolves.toMatchObject({ ok: true, skipped: false });
      await expect(concurrent).resolves.toMatchObject({ skipped: true, reason: 'provider_probe_in_flight' });
      expect(transportCalls).toBe(2);
      expect(target.requests.at(-1)).toMatchObject({
        method: 'GET', path: `${target.prefix}/models`, authorization: `Bearer ${key}`
      });
      expect(getOpenAIServiceHealth().providerRuntime).toMatchObject({
        authenticationBlocked: false, lastFailureCategory: null, consecutiveFailures: 0, nextRetryAt: null
      });
    } finally {
      hold.release(oldStatus);
      await Promise.allSettled([first, ...replacements]);
    }
  });

  it.each([true, false])('enforces the actual adapter worker budget before HTTP (allowed: %s)', async allowed => {
    reserveWorkerAiProviderAttemptMock.mockResolvedValueOnce(admission(allowed));
    const context = workerContext();
    const result = track(Promise.resolve(runWithAiExecutionContext(context, () => probeOpenAIProviderHealth({ force: true }))));
    if (allowed) {
      await expect(result).resolves.toMatchObject({ ok: true });
      expect(context.totals.calls).toBe(1);
    } else {
      await expect(result).rejects.toBeInstanceOf(WorkerAiCallBudgetPausedError);
      expect(context.workerBudgetFailure).toBeInstanceOf(WorkerAiCallBudgetPausedError);
    }
    expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
    expect(provider.requests).toHaveLength(allowed ? 1 : 0);
    expect(transportCalls).toBe(allowed ? 1 : 0);
  });

  it.each([true, false])('rechecks the replacement caller budget after the old HTTP transport settles (allowed: %s)', async allowed => {
    const hold = holdNextResponse(provider);
    const first = track(Promise.resolve(runWithAiExecutionContext(workerContext(), () =>
      probeOpenAIProviderHealth({ force: true, timeoutMs: 1000 }))));
    let replacement: Promise<unknown> | undefined;
    try {
      await bounded(hold.received, 'metered original transport');
      const target = await createProvider('/proxy/v1');
      selectProvider(target, 'sk-test-loopback-replacement-budget');
      const context = workerContext();
      replacement = track(Promise.resolve(runWithAiExecutionContext(context, () =>
        reinitializeOpenAIProvider({ ignoreBackoff: true }))));
      await delay(15);
      expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(1);
      expect(target.requests).toHaveLength(0);
      // Admission changes while waiting: no cached permission or detached follow-up may bypass it.
      reserveWorkerAiProviderAttemptMock.mockResolvedValueOnce(admission(allowed));
      hold.release();
      await expect(first).resolves.toMatchObject({ skipped: true, reason: 'provider_configuration_changed' });
      if (allowed) {
        await expect(replacement).resolves.toMatchObject({ ok: true });
        expect(context.totals.calls).toBe(1);
      } else {
        await expect(replacement).rejects.toBeInstanceOf(WorkerAiCallBudgetPausedError);
        expect(context.workerBudgetFailure).toBeInstanceOf(WorkerAiCallBudgetPausedError);
      }
      expect(reserveWorkerAiProviderAttemptMock).toHaveBeenCalledTimes(2);
      expect(target.requests).toHaveLength(allowed ? 1 : 0);
      expect(transportCalls).toBe(allowed ? 2 : 1);
    } finally {
      hold.release();
      await Promise.allSettled([first, ...(replacement ? [replacement] : [])]);
    }
  });
});

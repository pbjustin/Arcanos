import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startGenerativeModelPolicyProvider } from '../tests/fixtures/generative-model-policy-provider.ts';

const scriptPath = fileURLToPath(import.meta.url);
const resultPrefix = 'MODEL_POLICY_APP_E2E_RESULT=';
const authority = 'ft:gpt-4.1:synthetic:app-e2e-authority';
const scenarios = ['missing-authority', 'invalid-authority', 'conflicting-override', 'authoritative-answer'];

function isolatedEnvironment(scenario) {
  // Inherit only OS launch requirements. No developer credentials, dotenv,
  // database, Redis, provider endpoints, NODE_OPTIONS, or Railway identity.
  const environment = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return {
    ...environment,
    NODE_ENV: 'test', LOG_LEVEL: 'error', FORCE_MOCK: 'true',
    RUN_WORKERS: 'false', DISABLE_EXTERNAL_CALLS: 'true', DISABLE_DIAGNOSTICS_CRON: 'true',
    REDIS_SHARED_METRICS_ENABLED: 'false', DIAGNOSTICS_SHARED_METRICS: 'false',
    PUBLIC_PROVIDER_RATE_LIMIT_STORE: 'memory',
    OPENAI_API_KEY: '', OPENAI_MAX_RETRIES: '0',
    FINETUNED_MODEL_ID: ['conflicting-override', 'authoritative-answer'].includes(scenario) ? authority
      : scenario === 'invalid-authority' ? 'gpt-6.1-sol' : '',
    FINE_TUNED_MODEL_ID: '', AI_MODEL: '', OPENAI_MODEL: '',
    RAILWAY_OPENAI_MODEL: '', RAILWAY_FINETUNED_MODEL_ID: '',
    RAILWAY_FINE_TUNED_MODEL_ID: '', RAILWAY_AI_MODEL: '',
    HOST: '127.0.0.1', PORT: '8080', npm_package_version: '1.0.0'
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function runScenario(scenario) {
  assert(scenarios.includes(scenario));
  // Fail closed if the internal child entry is invoked from a developer checkout.
  assert.equal(path.dirname(path.resolve(process.cwd())), path.resolve(tmpdir()));
  assert(path.basename(process.cwd()).startsWith('arcanos-model-policy-e2e-'));
  assert.equal(readdirSync(process.cwd()).length, 0, 'Child requires a fresh empty state directory');
  process.env = isolatedEnvironment(scenario);
  // The actual compiled app, preflight, policy, middleware, and SDK run here.
  // Only post-listener dependency activation is replaced: no DDL, Redis,
  // worker claim, or background loop belongs in this bounded HTTP fixture.
  let blockedExternalFetches = 0;
  let dependencyInitializations = 0;
  let runtimeActivationFixtureCalls = 0;
  let releaseDependencies;
  const provider = await startGenerativeModelPolicyProvider({ authorityModel: authority, maxRequests: 4 });
  process.env.OPENAI_BASE_URL = provider.baseURL;
  process.env.OPENAI_API_KEY = provider.apiKey;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(provider.baseURL).origin) {
      blockedExternalFetches += 1;
      throw new Error('External transport is forbidden in the app E2E fixture');
    }
    return provider.fetch(input, options);
  };

  let appServer;
  try {
    const { startServer } = await import('../dist/server.js');
    if (scenario === 'invalid-authority') {
      const { validateEnvironment } = await import('../dist/platform/runtime/environmentValidation.js');
      assert(validateEnvironment().errors.some(error => error.includes('Invalid value for AI_MODEL')));
      await assert.rejects(startServer({
        initializeDependencies: async () => { throw new Error('Unexpected dependency initialization'); },
        startRedis: () => { throw new Error('Unexpected Redis activation'); },
        registerSignalHandlers: false
      }), /STARTUP_ENVIRONMENT_INVALID/);
      const { getStartupLifecycleSnapshot } = await import('../dist/platform/runtime/startupLifecycle.js');
      assert.equal(getStartupLifecycleSnapshot().listenerBound, false);
      assert.equal(provider.requests.length, 0);
      assert.equal(blockedExternalFetches, 0);
      return { scenario, passed: true, listenerBound: false, providerRequests: 0, blockedExternalFetches: 0 };
    }

    // Reserve a free loopback port; startServer intentionally rejects PORT=0.
    const reservation = createServer();
    process.env.PORT = String(await listen(reservation));
    await close(reservation);
    const { app } = await import('../dist/app.js');
    appServer = await startServer({
      app,
      startAppRuntimeOnce: () => { runtimeActivationFixtureCalls += 1; return true; },
      initializeDependencies: () => {
        dependencyInitializations += 1;
        return new Promise(resolve => { releaseDependencies = resolve; });
      },
      primeTelemetry: async () => {},
      startSelfHealing: () => ({ loopRunning: false, intervalMs: 30000 }),
      registerSignalHandlers: false
    });
    const baseUrl = `http://127.0.0.1:${process.env.PORT}`;
    const observations = [];
    async function request(route, body) {
      const response = await nativeFetch(`${baseUrl}${route}`, {
        ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000)
      });
      const payload = await response.json();
      observations.push({ route, status: response.status });
      return { status: response.status, payload };
    }

    for (const route of ['/diag/ping', '/health', '/healthz', '/status']) {
      const response = await request(route);
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.payload.status, 'ok');
    }
    const startingReadiness = await request('/readyz');
    assert.equal(startingReadiness.status, 503);
    assert.equal(startingReadiness.payload.ready, false);
    assert.equal(startingReadiness.payload.checks.find(check => check.name === 'startup').code, 'APPLICATION_STARTING');
    assert.equal(runtimeActivationFixtureCalls, 0);
    releaseDependencies();
    await new Promise(resolve => setImmediate(resolve));
    const readyReadiness = await request('/readyz');
    assert.equal(readyReadiness.status, 200, JSON.stringify(readyReadiness));
    assert.equal(readyReadiness.payload.ready, true);
    assert.equal(readyReadiness.payload.checks.find(check => check.name === 'startup').healthy, true);
    const status = await request('/api/openai/status');
    assert.equal(status.status, 200);
    assert.equal(status.payload.openai.configured, true);
    assert.equal(status.payload.openai.clientInitialized, true);
    assert.equal(status.payload.openai.defaultModel, scenario === 'missing-authority' ? '' : authority);
    assert.equal(status.payload.openai.fallbackModel, scenario === 'missing-authority' ? '' : authority);

    if (scenario === 'missing-authority') {
      const prompt = await request('/api/openai/prompt', { prompt: 'Synthetic policy admission check' });
      assert.equal(prompt.status, 503, JSON.stringify(prompt));
      assert.equal(prompt.payload.error, 'FINAL_AUTHORITY_UNAVAILABLE');
      for (const [route, body] of [
        ['/api/vision', { imageBase64: 'aW1hZ2U=', prompt: 'Synthetic policy admission check' }],
        ['/query-finetune', { prompt: 'Synthetic policy admission check' }]
      ]) {
        const response = await request(route, body);
        assert.equal(response.status, 503, JSON.stringify(response));
        assert.equal(response.payload.response, undefined);
        assert.equal(response.payload.output, undefined);
        assert.match(JSON.stringify(response.payload), /authority/i);
      }
    } else if (scenario === 'conflicting-override') {
      const response = await request('/api/openai/prompt', {
        prompt: 'Synthetic policy admission check', model: 'gpt-4o'
      });
      assert.equal(response.status, 400, JSON.stringify(response));
      assert.equal(response.payload.error, 'MODEL_OVERRIDE_CONFLICT');
    } else {
      provider.enqueue({ kind: 'completion', text: 'Synthetic authority answer.' });
      const response = await request('/api/vision', {
        imageBase64: 'aW1hZ2U=', prompt: 'Synthetic policy admission check'
      });
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.payload.response, 'Synthetic authority answer.');
      assert.equal(response.payload.model, authority);
      assert.equal(response.payload.tokens, 18);
      assert.equal(provider.requests.length, 1);
      assert.equal(provider.requests[0].model, authority);
      assert.equal(provider.requests[0].authorizationAccepted, true);
    }
    assert.equal(dependencyInitializations, 1);
    assert.equal(runtimeActivationFixtureCalls, 1);
    assert.equal(provider.requests.length, scenario === 'authoritative-answer' ? 1 : 0);
    assert.equal(blockedExternalFetches, 0);
    return {
      scenario, passed: true, listenerBound: true, observations,
      dependencyInitializations, runtimeActivationFixtureCalls,
      providerRequests: provider.requests.length, blockedExternalFetches: 0
    };
  } finally {
    await close(appServer);
    const { stopRedisLifecycle } = await import('../dist/platform/runtime/redisLifecycle.js');
    await stopRedisLifecycle();
    await provider.close();
    globalThis.fetch = nativeFetch;
  }
}

const scenarioIndex = process.argv.indexOf('--scenario');
if (scenarioIndex !== -1) {
  const result = await runScenario(process.argv[scenarioIndex + 1]);
  console.log(`${resultPrefix}${JSON.stringify(result)}`);
} else {
  for (const scenario of scenarios) {
    test(`compiled app HTTP model policy: ${scenario}`, { timeout: 30000 }, () => {
      const sandbox = mkdtempSync(path.join(tmpdir(), 'arcanos-model-policy-e2e-'));
      try {
        const child = spawnSync(process.execPath, [scriptPath, '--scenario', scenario], {
          cwd: sandbox, env: isolatedEnvironment(scenario), encoding: 'utf8',
          timeout: 25000, maxBuffer: 1024 * 1024
        });
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        const resultLine = child.stdout.split(/\r?\n/).find(line => line.startsWith(resultPrefix));
        assert(resultLine, 'Child did not attest its HTTP assertions');
        const result = JSON.parse(resultLine.slice(resultPrefix.length));
        assert.equal(result.scenario, scenario);
        assert.equal(result.passed, true);
        console.log(resultLine);
      } finally {
        // Only delete the unique directory this test created under the OS temp root.
        assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(tmpdir()));
        assert(path.basename(sandbox).startsWith('arcanos-model-policy-e2e-'));
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  }
}

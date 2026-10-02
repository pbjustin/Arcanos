import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const sandboxPrefix = 'arcanos-heartbeat-app-e2e-';
const token = 'test-heartbeat-app-e2e-control-token-1234567890';
const scenarios = ['protocol', 'missing-config', 'missing-scope', 'quota'];
const heartbeat = {
  timestamp: '2026-10-02T04:24:33.000Z',
  mode: 'test-private-heartbeat-mode',
  payload: {
    write_override: false,
    db_write_enable: true,
    suppression_level: 'test-private-suppression',
    confirmation: 'test-private-confirmation',
  },
};
const expectedMessage = 'Heartbeat acknowledged. Mode: test-private-heartbeat-mode, '
  + 'write operations enabled, suppression level: test-private-suppression. '
  + 'Confirmation: test-private-confirmation.';

function isolatedEnvironment(sandbox, scenario) {
  // Only Windows launch requirements survive. No inherited credentials, dotenv,
  // service addresses, NODE_OPTIONS, deployment identity, or developer state.
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR']
    .filter(name => typeof process.env[name] === 'string')
    .map(name => [name, process.env[name]]));
  return {
    ...environment,
    TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox,
    HEARTBEAT_E2E_TEMP_PARENT: path.dirname(sandbox),
    NODE_ENV: 'test', LOG_LEVEL: 'error', HOST: '127.0.0.1', PORT: '8080',
    RUN_WORKERS: 'false', DISABLE_EXTERNAL_CALLS: 'true', DISABLE_DIAGNOSTICS_CRON: 'true',
    PROMPT_DEBUG_TRACE_PERSIST: 'false', SELF_IMPROVE_ENABLED: 'false',
    PREDICTIVE_HEALING_ENABLED: 'false', PREDICTIVE_AUTO_EXECUTE: 'false',
    REDIS_SHARED_METRICS_ENABLED: 'false', DIAGNOSTICS_SHARED_METRICS: 'false',
    PUBLIC_PROVIDER_RATE_LIMIT_STORE: 'memory', ARCANOS_CONTEXT_MODE: 'disabled',
    OPENAI_API_KEY: '', DATABASE_URL: '', REDIS_URL: '',
    ARC_MEMORY_PATH: path.join(sandbox, 'memory'), ARC_LOG_PATH: path.join(sandbox, 'logs'),
    ARC_DATASET_LOG_PATH: path.join(sandbox, 'logs'),
    SELF_HEAL_TELEMETRY_FILE: path.join(sandbox, 'memory', 'self-heal-telemetry.json'),
    DAEMON_TOKENS_FILE: path.join(sandbox, 'memory', 'daemon_tokens.json'),
    SELF_IMPROVE_EVIDENCE_DIR: path.join(sandbox, 'governance', 'evidence_packs'),
    ALLOW_ALL_GPTS: 'false', TRUSTED_GPT_IDS: '',
    ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: scenario === 'missing-config' ? '' : token,
    ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:heartbeat-app-e2e',
    ARCANOS_CONTROL_PLANE_SCOPES: scenario === 'missing-scope' ? 'arcanos:read' : 'mcp:invoke',
  };
}

async function runFixture(scenario) {
  assert(scenarios.includes(scenario));
  const sandbox = realpathSync(process.cwd());
  assert(path.basename(sandbox).startsWith(sandboxPrefix));
  assert.equal(path.dirname(sandbox), realpathSync(process.env.HEARTBEAT_E2E_TEMP_PARENT));
  assert.equal(lstatSync(sandbox).isSymbolicLink(), false);
  assert.equal(readdirSync(sandbox).length, 0, 'Fixture requires fresh isolated state');
  assert.equal(process.env.ARC_MEMORY_PATH, path.join(sandbox, 'memory'));
  assert.equal(typeof process.send, 'function', 'Fixture requires its verifier IPC channel');
  const expectedEnvironment = isolatedEnvironment(sandbox, scenario);
  const unexpectedEnvironmentKeys = Object.keys(process.env)
    .filter(name => !Object.hasOwn(expectedEnvironment, name));
  // Windows/libuv injects these OS launch keys even with an explicit env map.
  // Remove them before app import; any other inherited key fails closed.
  const windowsLaunchKeys = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH',
    'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE'];
  for (const name of unexpectedEnvironmentKeys) {
    assert(process.platform === 'win32' && windowsLaunchKeys.includes(name),
      `Fixture refuses inherited environment key: ${name}`);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(expectedEnvironment)) {
    assert(process.env[name] === value, `Fixture environment mismatch: ${name}`);
  }

  let networkAttempts = 0;
  const denyNetwork = () => {
    networkAttempts += 1;
    throw new Error('Application egress is forbidden in the heartbeat fixture');
  };
  // The verifier runs in the parent. The app may listen/accept but cannot make
  // any outbound connection, including loopback, or invoke a provider fetch.
  Socket.prototype.connect = denyNetwork;
  globalThis.fetch = denyNetwork;

  // Use the normal compiled app, route graph, logger, auth, schema, confirmation,
  // and singleton quota. Do not activate startup dependencies/background work.
  const { app } = await import('../dist/app.js');
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  process.send({ type: 'ready', port: server.address().port });
  process.once('message', async message => {
    assert.equal(message, 'shutdown');
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const { getStartupLifecycleSnapshot } = await import('../dist/platform/runtime/startupLifecycle.js');
    const { getRedisLifecycleSnapshot } = await import('../dist/platform/runtime/redisLifecycle.js');
    assert.equal(getStartupLifecycleSnapshot().runtimeInitialized, false);
    assert.equal(getRedisLifecycleSnapshot().connected, false);
    process.send({ type: 'finished', networkAttempts }, () => {
      process.stdout.write('', () => process.exit(0));
    });
  });
}

async function startFixture(scenario, environmentOverrides = {}) {
  assert(existsSync(new URL('../dist/app.js', import.meta.url)), 'Run npm run build before heartbeat E2E');
  const temporaryParent = realpathSync(tmpdir());
  const sandbox = realpathSync(mkdtempSync(path.join(temporaryParent, sandboxPrefix)));
  const child = spawn(process.execPath, [scriptPath, '--fixture', scenario], {
    cwd: sandbox, env: { ...isolatedEnvironment(sandbox, scenario), ...environmentOverrides }, shell: false,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  let finished;
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const lifetime = setTimeout(() => child.kill(), 50_000);
  closed.then(() => clearTimeout(lifetime));
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    if (Buffer.byteLength(stdout) > 1024 * 1024) child.kill();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
    if (Buffer.byteLength(stderr) > 64 * 1024) child.kill();
  });
  child.on('message', message => {
    if (message.type === 'finished') finished = message;
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Compiled heartbeat fixture readiness timed out')), 30_000);
    child.once('error', reject);
    child.on('message', message => {
      if (message.type === 'ready') {
        clearTimeout(timer);
        resolve(message.port);
      }
    });
    closed.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`Heartbeat fixture exited before readiness (${code}): ${stderr}`));
    });
  });
  async function cleanup() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    // Delete only our real, unique child of the OS temporary root.
    assert.equal(path.dirname(realpathSync(sandbox)), temporaryParent);
    assert(path.basename(sandbox).startsWith(sandboxPrefix));
    assert.equal(lstatSync(sandbox).isSymbolicLink(), false);
    rmSync(sandbox, { recursive: true });
    assert.equal(existsSync(sandbox), false);
  }
  try {
    const port = await ready;
    return {
      port, sandbox, cleanup,
      async finish() {
        child.send('shutdown');
        const deadline = setTimeout(() => child.kill(), 5000);
        const result = await closed;
        clearTimeout(deadline);
        assert.equal(result.code, 0, `Heartbeat fixture failed: ${stderr}`);
        assert.equal(result.signal, null);
        assert.equal(finished?.networkAttempts, 0, 'Heartbeat/health must make zero outbound calls');
        return stdout;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function request(port, options = {}) {
  const body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? heartbeat);
  const headers = {
    'Content-Type': 'application/json', Connection: 'close',
    ...(options.auth === false ? {} : { Authorization: `Bearer ${options.auth ?? token}` }),
    ...(options.confirm === false ? {} : { 'X-Confirmed': options.confirm ?? 'yes' }),
    ...(options.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': Buffer.byteLength(body) }),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const pending = httpRequest({
      hostname: '127.0.0.1', port, path: options.path ?? '/heartbeat',
      method: options.method ?? 'POST', headers,
    }, response => {
      let text = '';
      response.on('data', chunk => {
        text += chunk.toString();
        if (Buffer.byteLength(text) > 64 * 1024) pending.destroy(new Error('Unbounded fixture response'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) });
          pending.destroy();
        } catch (error) { reject(error); }
      });
    });
    pending.setTimeout(5000, () => pending.destroy(new Error('Heartbeat HTTP request timed out')));
    pending.on('error', reject);
    if (options.headersOnly) pending.flushHeaders();
    else if (options.chunked) {
      pending.write(body.slice(0, 97));
      pending.write(body.slice(97, 2048));
      pending.end(body.slice(2048));
    } else pending.end(body);
  });
}

async function verifyScenario(scenario, fixture) {
  const observations = [];
  const successes = [];
  async function check(name, options, status, code) {
    const result = await request(fixture.port, options);
    assert.equal(result.status, status, name);
    if (code) assert.equal(result.body.error?.code ?? result.body.code, code, name);
    if ((options?.method ?? 'POST') === 'POST') {
      assert.equal(result.headers['cache-control'], 'no-store', name);
      assert.equal(result.headers.pragma, 'no-cache', name);
    }
    if (status === 200 && (options?.method ?? 'POST') === 'POST') {
      assert.deepEqual(result.body, { message: expectedMessage }, name);
      for (const header of ['x-request-id', 'x-trace-id']) {
        assert.equal(typeof result.headers[header], 'string', name);
        assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.headers[header]), name);
      }
      successes.push({ requestId: result.headers['x-request-id'], traceId: result.headers['x-trace-id'] });
    }
    observations.push({ name, status });
    return result;
  }
  if (scenario === 'missing-config' || scenario === 'missing-scope') {
    const status = scenario === 'missing-config' ? 503 : 403;
    const code = scenario === 'missing-config' ? 'CONTROL_PLANE_AUTH_UNAVAILABLE' : 'CONTROL_PLANE_SCOPE_DENIED';
    await check('reject without receiving declared body', {
      headersOnly: true, headers: { 'Content-Length': 10 * 1024 * 1024 },
    }, status, code);
  } else if (scenario === 'quota') {
    for (let index = 0; index < 3; index += 1) {
      await check('invalid bearer cannot charge operator quota', { auth: 'test-invalid-bearer', body: '{' },
        401, 'CONTROL_PLANE_AUTH_REQUIRED');
    }
    const first = await check('singleton boundary charges once', {}, 200);
    assert.equal(first.headers['x-ratelimit-limit'], '60');
    assert.equal(first.headers['x-ratelimit-remaining'], '59');
    for (let index = 2; index <= 60; index += 1) {
      const malformed = index % 2 === 0;
      const response = await check('count malformed and unconfirmed attempts', {
        body: malformed ? '{' : heartbeat, confirm: false,
        headers: { 'X-Forwarded-For': `198.51.100.${index}`, 'X-Session-ID': `test-session-${index}`,
          'X-Client-ID': `test-client-${index}` },
      }, malformed ? 400 : 403);
      assert.equal(response.headers['x-ratelimit-remaining'], String(60 - index));
    }
    const denied = await check('request 61 cannot evade quota', {
      body: '{', headers: { 'X-Forwarded-For': '203.0.113.1', 'X-Session-ID': 'test-new-session' },
    }, 429);
    assert.equal(denied.headers['x-ratelimit-bucket'], 'heartbeat-principal');
    assert(Number(denied.headers['retry-after']) > 0);
    assert.equal(denied.headers['x-confirmation-challenge'], undefined);
  } else {
    await check('unauthenticated body is never needed', {
      auth: false, headersOnly: true, headers: { 'Content-Length': 10 * 1024 * 1024 },
    }, 401, 'CONTROL_PLANE_AUTH_REQUIRED');
    await check('unauthenticated malformed body', { auth: false, body: '{' }, 401, 'CONTROL_PLANE_AUTH_REQUIRED');
    const pending = await check('confirmation challenge', { confirm: false }, 403, 'CONFIRMATION_REQUIRED');
    await check('exact one-use confirmation retry', { confirm: `token:${pending.headers['x-confirmation-challenge']}` }, 200);
    await check('confirmation replay rejected', { confirm: `token:${pending.headers['x-confirmation-challenge']}` }, 403);
    const changed = await check('new confirmation challenge', { confirm: false }, 403);
    await check('changed body cannot use confirmation', {
      confirm: `token:${changed.headers['x-confirmation-challenge']}`,
      body: { ...heartbeat, mode: 'test-changed-mode' },
    }, 403);
    const correlated = await check('manual acknowledgement', {
      headers: { 'X-Request-ID': 'test-heartbeat-known-request', 'X-Trace-ID': 'test-heartbeat-known-trace' },
    }, 200);
    assert.equal(correlated.headers['x-request-id'], 'test-heartbeat-known-request');
    assert.equal(correlated.headers['x-trace-id'], 'test-heartbeat-known-trace');
    await check('case and trailing slash', { path: '/HeArTbEaT/' }, 200);
    await check('vendor JSON', { headers: { 'Content-Type': 'application/heartbeat+json' } }, 200);
    const serialized = JSON.stringify(heartbeat);
    for (const chunked of [false, true]) {
      await check(`inclusive 4096 bytes, chunked=${chunked}`, {
        chunked, body: serialized + ' '.repeat(4096 - Buffer.byteLength(serialized)),
      }, 200);
      await check(`4097 bytes rejected, chunked=${chunked}`, {
        chunked, body: serialized + ' '.repeat(4097 - Buffer.byteLength(serialized)),
      }, 413, 'HEARTBEAT_REQUEST_INVALID');
    }
    for (const [name, options, status] of [
      ['malformed JSON', { body: '{"test-private-body-sentinel":' }, 400],
      ['scalar JSON', { body: '"test-private-body-sentinel"' }, 400],
      ['unknown top-level key', { body: { ...heartbeat, test_private_body_sentinel: 'discard' } }, 400],
      ['unknown nested key', { body: { ...heartbeat, payload: { ...heartbeat.payload, extra: true } } }, 400],
      ['boolean type violation', { body: { ...heartbeat, payload: { ...heartbeat.payload, db_write_enable: 'true' } } }, 400],
      ['text bound violation', { body: { ...heartbeat, mode: 'x'.repeat(65) } }, 400],
      ['compressed body', { headers: { 'Content-Encoding': 'gzip' } }, 415],
      ['unsupported media', { headers: { 'Content-Type': 'text/plain' } }, 415],
      ['duplicate media header', { headers: { 'Content-Type': ['application/json', 'text/plain'] } }, 415],
    ]) {
      const invalid = await check(name, options, status);
      if (['unknown top-level key', 'unknown nested key', 'boolean type violation', 'text bound violation'].includes(name)) {
        assert.deepEqual(invalid.body, { error: 'Invalid heartbeat payload' }, name);
      } else {
        assert.deepEqual(invalid.body, {
          ok: false, error: { code: 'HEARTBEAT_REQUEST_INVALID', message: 'Heartbeat request is invalid.' },
        }, name);
      }
      assert.equal(invalid.headers['x-confirmation-challenge'], undefined, name);
      assert(!JSON.stringify(invalid.body).includes('test-private-body-sentinel'), name);
    }
    const logFile = path.join(fixture.sandbox, 'logs', 'heartbeat.log');
    assert.equal(existsSync(logFile), false, 'Accepted heartbeat must not create a local log');
    mkdirSync(path.dirname(logFile), { recursive: true });
    const existingLog = 'test-existing-heartbeat-log-must-stay-unchanged\n';
    writeFileSync(logFile, existingLog);
    await check('existing heartbeat log is preserved', {}, 200);
    assert.equal(readFileSync(logFile, 'utf8'), existingLog);
  }
  for (const [route, status] of [['/health', 200], ['/healthz', 200], ['/readyz', 503]]) {
    const response = await check(`public ${route}`, {
      path: route, method: 'GET', auth: false, confirm: false, body: '',
    }, status);
    if (route === '/readyz') {
      assert.equal(response.body.ready, false);
      assert.equal(response.body.checks.find(entry => entry.name === 'startup').code, 'APPLICATION_STARTING');
    } else assert.equal(response.body.status, 'ok');
  }
  const stdout = await fixture.finish();
  const events = stdout.split(/\r?\n/).flatMap(line => {
    try { const entry = JSON.parse(line); return entry.event === 'heartbeat.received' ? [entry] : []; }
    catch { return []; }
  });
  assert.equal(events.length, successes.length, 'Only accepted heartbeats may emit telemetry');
  for (const [index, event] of events.entries()) {
    assert.equal(event.requestId, successes[index].requestId);
    assert.equal(event.traceId, successes[index].traceId);
    assert.deepEqual(event.data, { writeOverride: false, dbWriteEnabled: true });
  }
  for (const sentinel of [token, heartbeat.mode, heartbeat.payload.suppression_level,
    heartbeat.payload.confirmation, 'test-private-body-sentinel']) {
    assert(!stdout.includes(sentinel), 'Caller bodies and bearer must not enter application logs');
  }
  return { scenario, passed: true, requests: observations.length,
    acceptedHeartbeats: successes.length, correlatedEvents: events.length, networkAttempts: 0, observations };
}

const fixtureIndex = process.argv.indexOf('--fixture');
if (fixtureIndex !== -1) {
  await runFixture(process.argv[fixtureIndex + 1]);
} else {
  for (const scenario of scenarios) {
    test(`compiled heartbeat app HTTP: ${scenario}`, { timeout: 60_000 }, async () => {
      const fixture = await startFixture(scenario);
      try {
        const result = await verifyScenario(scenario, fixture);
        console.log(`HEARTBEAT_APP_E2E_RESULT=${JSON.stringify(result)}`);
      } finally { await fixture.cleanup(); }
    });
  }
  test('heartbeat fixture refuses provider credentials before app import', async () => {
    await assert.rejects(startFixture('protocol', { OPENAI_API_KEY: 'test-forbidden-provider-key' }),
      /Fixture environment mismatch: OPENAI_API_KEY/);
  });
  test('heartbeat fixture refuses unknown inherited environment before app import', async () => {
    await assert.rejects(startFixture('protocol', { TEST_HEARTBEAT_INHERITED_CREDENTIAL: 'test-forbidden-value' }),
      /Fixture refuses inherited environment key: TEST_HEARTBEAT_INHERITED_CREDENTIAL/);
  });
}

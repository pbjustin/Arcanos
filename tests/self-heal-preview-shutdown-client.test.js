import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createClient } from 'redis';
import { resolveSelfHealPreviewProfile } from '../scripts/railway-self-heal-preview-profile.mjs';
import { runSelfHealPreviewShutdown, parsePreviewShutdownProcess } from '../scripts/self-heal-preview-shutdown.mjs';
const UUID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT = '22222222-2222-4222-8222-222222222222';
const SERVER = 'c'.repeat(40);
const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const databaseCertificate = readFileSync(new URL('./fixtures/self-heal-preview-database-ca.pem', import.meta.url), 'utf8');
function environment(role, now) {
  return {
    ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1',
    ARCANOS_SELF_HEAL_PREVIEW_RUN_ID: 'shutdown-test-1544',
    ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT: new Date(now - 1_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT: new Date(now + 60_000).toISOString(),
    ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN: 'f'.repeat(64), ARCANOS_SELF_HEAL_PREVIEW_CONTROL_PORT: '8791',
    ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'normal', ARCANOS_SELF_HEAL_PREVIEW_DATABASE_CERTIFICATE_PEM: databaseCertificate,
    ARCANOS_SELF_HEAL_PREVIEW_WEB_SERVICE_ID: id('3'), ARCANOS_SELF_HEAL_PREVIEW_WORKER_SERVICE_ID: id('4'),
    ARCANOS_BACKSTAGE_HEAVY_PROOF_TARGET: 'dedicated-backstage-heavy-preview-v1',
    ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID: 'shutdown-test-1544', ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA: 'a'.repeat(40),
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID: id('6'), ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME: 'Postgres',
    ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST: 'postgres.railway.internal',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID: id('7'), ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_NAME: 'Redis',
    ARCANOS_BACKSTAGE_HEAVY_REDIS_INTERNAL_HOST: 'redis.railway.internal',
    ARCANOS_PROCESS_KIND: role, ARCANOS_PREVIEW_ISOLATION: 'true', NODE_ENV: 'production',
    FORCE_MOCK: 'true', ALLOW_MOCK_OPENAI: 'true', OPENAI_API_KEY_REQUIRED: 'false',
    OPENAI_BASE_URL: role === 'worker' ? 'http://127.0.0.1:8766/v1' : 'http://127.0.0.1:9/v1',
    ...(role === 'worker' ? { ARCANOS_PREVIEW_OPENAI_FIXTURE: 'backstage-heavy-compact-retry-v1' } : {}),
    ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY: `${'A'.repeat(43)}=`,
    ...(role === 'web' ? { ARCANOS_BACKSTAGE_BOOKER_ASYNC_GENERATION_ENABLED: 'true',
      ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN: 'synthetic-web-access-token-purpose-only',
      ARCANOS_JOB_READ_CAPABILITY_SECRET: 'synthetic-job-result-read-purpose-only' } : {}),
    DATABASE_URL: 'postgresql://synthetic-user:synthetic-password@postgres.railway.internal:5432/railway',
    REDIS_URL: 'redis://default:synthetic-redis-password@redis.railway.internal:6379',
    RAILWAY_PROJECT_ID: id('1'), RAILWAY_PROJECT_NAME: 'arc-pr1544-heavy-shutdown',
    RAILWAY_ENVIRONMENT_ID: id('2'), RAILWAY_ENVIRONMENT_NAME: 'backstage-heavy-pr-1544-e2e',
    RAILWAY_SERVICE_ID: id(role === 'worker' ? '4' : '3'), RAILWAY_SERVICE_NAME: `arcanos-${role}-pr1544-heavy`,
    RAILWAY_DEPLOYMENT_ID: DEPLOYMENT,
  };
}
function fixture(config = {}) {
  let clock = Date.now(); let released = false; let signalled = false;
  const commands = [];
  const receipt = { scenario: 'A06', sourceSha: 'a'.repeat(40), processInstanceId: UUID,
    deploymentId: DEPLOYMENT, pid: 1544, redisClientId: '41', events: [] };
  const push = (phase, data = {}) => receipt.events.push({ phase, at: new Date(clock).toISOString(), data });
  const journal = { holdBarrier: jest.fn(async () => undefined), close: jest.fn(async () => undefined),
    append: jest.fn(async (phase, data) => push(phase, data)), read: jest.fn(async () => structuredClone(receipt)),
    releaseBarrier: jest.fn(async () => {
      if (released) return; released = true;
      if (signalled) { push('barrier_released', { signalSeen: true, elapsedMs: 100 });
        push('coordinator_drained', { inFlight: false, redisConnected: true });
        push('redis_stop_begin', { inFlight: false, redisConnected: true });
        push('redis_stopped', { inFlight: false, redisConnected: false }); }
    }),
  };
  const redis = { isOpen: true, on: jest.fn(), connect: jest.fn(async () => undefined), destroy: jest.fn(),
    sendCommand: jest.fn(async args => args[0] === 'INFO' ? `run_id:${config.changedServer ? 'd'.repeat(40) : SERVER}\r\n`
      : released || config.redisAbsent ? '' : 'id=41 addr=redacted\n') };
  const worker = { ready: true, pid: 1544, processInstanceId: UUID, coordinator: { inFlight: false, loopRunning: true },
    shutdownProbe: { armed: false, holding: false, scenario: 'A06', redisClientId: '41' } };
  const options = { verifyArtifact: () => ({ sourceSha: 'a'.repeat(40), compiledSha256: 'b'.repeat(64) }),
    shutdownModule: { PreviewShutdownJournal: { open: async () => journal } },
    createRedisClient: jest.fn(() => redis), now: () => clock, sleep: async ms => { clock += ms; },
    processIdentity: jest.fn(() => released ? null : '12345'), signalTarget: jest.fn(() => ({ pid: 1500, startTime: '12340' })),
    signalProcess: jest.fn(() => { signalled = true; push('shutdown_seen', { signalSeen: true });
      if (config.expired) push('barrier_expired', { elapsedMs: 4500, signalSeen: true }); }),
    fetchImpl: jest.fn(async () => new Response(JSON.stringify({ ready: false, child: 'draining' }), { status: config.readyDuringShutdown ? 200 : 503 })),
    local: jest.fn(async args => {
      const command = args.at(-1); commands.push(command);
      if (args[0] === 'provider') return { observation: { expired: false, inFlight: null, nextFault: null } };
      if (command === 'coordinator_stop') worker.coordinator.loopRunning = false;
      if (command === 'shutdown_prepare_a06') { worker.shutdownProbe.armed = true; push('prepared'); }
      if (command === 'coordinator_start' && !config.neverHeld) {
        worker.shutdownProbe.holding = true; worker.coordinator.inFlight = true; push('evaluation_held', { inFlight: true });
      }
      return { observation: structuredClone(worker) };
    }),
  };
  return { receipt, journal, redis, options, commands, env: environment(config.role ?? 'worker', clock) };
}
describe('closed independent shutdown SSH operation', () => {
  it('requires actual overlap, signals the verified wrapper, and joins independent dependency observations before release', async () => {
    const f = fixture(); const result = await runSelfHealPreviewShutdown('held', 'A06', f.env, f.options);
    expect(result.evidence).toBe('synthetic_injected_dependencies');
    expect(f.options.signalProcess).toHaveBeenCalledWith(1500, 'SIGTERM');
    expect(f.options.signalTarget).toHaveBeenCalledTimes(2);
    expect(f.journal.append).toHaveBeenCalledWith('independent_held_probe', expect.objectContaining({ processAlive: true,
      redisClientPresent: true, providerHealthy: true, drainAbsent: true, readinessWithheld: true, redisServerRunId: SERVER }));
    const phases = result.receipt.events.map(event => event.phase);
    expect(phases.indexOf('independent_held_probe')).toBeLessThan(phases.indexOf('independent_barrier_releasing'));
    expect(phases.indexOf('coordinator_drained')).toBeLessThan(phases.indexOf('redis_stop_begin'));
    expect(phases.at(-1)).toBe('independent_process_exited'); expect(f.redis.destroy).toHaveBeenCalledTimes(1);
    expect(f.redis.sendCommand).toHaveBeenCalledWith(['CLIENT', 'LIST', 'ID', '41'], { timeout: 500 });
    expect(resolveSelfHealPreviewProfile('worker', f.env).proofTarget).not.toHaveProperty('redisUrl');
    expect(f.options.createRedisClient).toHaveBeenCalledWith({ url: f.env.REDIS_URL,
      disableOfflineQueue: true, socket: { connectTimeout: 500, reconnectStrategy: false } });
  });
  it.each(['missing', 'foreign'])('rejects a %s Redis target before acquiring a barrier or invoking clients', async target => {
    const f = fixture();
    if (target === 'missing') delete f.env.REDIS_URL;
    else f.env.REDIS_URL = 'redis://default:synthetic-redis-password@foreign.railway.internal:6379';
    await expect(runSelfHealPreviewShutdown('held', 'A06', f.env, f.options)).rejects.toThrow('BACKSTAGE_HEAVY_PROOF_DATA_URL_INVALID');
    expect(f.journal.holdBarrier).not.toHaveBeenCalled(); expect(f.options.createRedisClient).not.toHaveBeenCalled();
    expect(f.options.local).not.toHaveBeenCalled(); expect(f.options.signalProcess).not.toHaveBeenCalled();
  });
  it.each([{ neverHeld: true }, { expired: true }, { readyDuringShutdown: true }])('preserves missing evidence and releases its own barrier %#', async config => {
    const f = fixture(config);
    await expect(runSelfHealPreviewShutdown('held', 'A06', f.env, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    expect(f.journal.releaseBarrier).toHaveBeenCalled(); expect(f.journal.close).toHaveBeenCalled();
    expect(f.receipt.events.some(event => event.phase === 'independent_held_probe')).toBe(false);
    if (config.neverHeld) { expect(f.options.signalProcess).not.toHaveBeenCalled(); expect(f.commands).toContain('shutdown_cancel'); }
  });
  it('recovers Redis closure independently through Web readback without claiming a Web provider is the Worker provider', async () => {
    const f = fixture({ redisAbsent: true, role: 'web' });
    f.receipt.events.push({ phase: 'independent_held_probe', at: new Date().toISOString(), data: { redisServerRunId: SERVER } },
      { phase: 'redis_stopped', at: new Date().toISOString(), data: { redisConnected: false } });
    const result = await runSelfHealPreviewShutdown('receipt', 'A06', f.env, f.options);
    expect(result.receipt.events.at(-1)).toMatchObject({ phase: 'independent_redis_closed',
      data: { redisClientPresent: false, redisServerRunId: SERVER } });
    expect(f.options.local).not.toHaveBeenCalled(); expect(f.options.signalProcess).not.toHaveBeenCalled();
    expect(f.journal.append.mock.calls[0][1]).not.toHaveProperty('providerHealthy');
    expect(f.options.createRedisClient).toHaveBeenCalledWith({ url: f.env.REDIS_URL,
      disableOfflineQueue: true, socket: { connectTimeout: 500, reconnectStrategy: false } });
  });
  it('rejects Redis server replacement instead of crediting absence on an unrelated server', async () => {
    const f = fixture({ redisAbsent: true, changedServer: true, role: 'web' });
    f.receipt.events.push({ phase: 'independent_held_probe', at: new Date().toISOString(), data: { redisServerRunId: SERVER } },
      { phase: 'redis_stopped', at: new Date().toISOString(), data: { redisConnected: false } });
    await expect(runSelfHealPreviewShutdown('receipt', 'A06', f.env, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    expect(f.journal.append).not.toHaveBeenCalled(); expect(f.redis.destroy).toHaveBeenCalled();
  });
  it('does not signal a process whose identity changes and rejects unclosed selectors', async () => {
    const f = fixture(); f.options.processIdentity.mockReturnValueOnce('12345').mockReturnValueOnce('different-start');
    await expect(runSelfHealPreviewShutdown('held', 'A06', f.env, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    expect(f.options.signalProcess).not.toHaveBeenCalled();
    for (const [operation, scenario, role] of [['held', 'A01', 'worker'], ['arbitrary', 'A06', 'worker'], ['held', 'E06', 'web']]) {
      await expect(runSelfHealPreviewShutdown(operation, scenario, { ...f.env, ARCANOS_PROCESS_KIND: role }, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    }
  });
});
// Real node-redis/TCP reply waits, with only a bounded loopback RESP fixture.
// No Redis process, PostgreSQL server or configured infrastructure is contacted.
describe('shutdown Redis connection and reply deadlines', () => {
  it.each(['connect', 'INFO', 'CLIENT'])('releases the barrier when %s never replies', async withheld => {
    const sockets = new Set();
    const seen = [];
    const server = createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      let buffered = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 4096) { socket.destroy(); return; }
        for (;;) {
          const firstEnd = buffered.indexOf('\r\n');
          if (firstEnd < 0) return;
          const count = Number(buffered.subarray(1, firstEnd).toString());
          if (buffered[0] !== 42 || !Number.isSafeInteger(count) || count < 1 || count > 16) { socket.destroy(); return; }
          let offset = firstEnd + 2; const args = [];
          for (let index = 0; index < count; index += 1) {
            const lengthEnd = buffered.indexOf('\r\n', offset); if (lengthEnd < 0) return;
            const length = Number(buffered.subarray(offset + 1, lengthEnd).toString());
            if (buffered[offset] !== 36 || !Number.isSafeInteger(length) || length < 0 || length > 1024) { socket.destroy(); return; }
            offset = lengthEnd + 2; if (buffered.length < offset + length + 2) return;
            args.push(buffered.subarray(offset, offset + length).toString()); offset += length + 2;
          }
          buffered = buffered.subarray(offset); seen.push(args[0]);
          if (withheld === 'connect' || args[0] === withheld && (withheld !== 'CLIENT' || args[1] === 'LIST')) continue;
          const reply = args[0] === 'INFO' ? `run_id:${SERVER}\r\n` : null;
          socket.write(reply === null ? '+OK\r\n' : `$${Buffer.byteLength(reply)}\r\n${reply}\r\n`);
          if (!buffered.length) break;
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const f = fixture({ role: 'web' });
    f.receipt.events.push({ phase: 'independent_held_probe', at: new Date().toISOString(), data: { redisServerRunId: SERVER } },
      { phase: 'redis_stopped', at: new Date().toISOString(), data: { redisConnected: false } });
    let client; let timer;
    f.options.createRedisClient = settings => {
      client = createClient({ ...settings, url: `redis://127.0.0.1:${server.address().port}` });
      jest.spyOn(client, 'destroy'); return client;
    };
    const started = Date.now();
    const pending = runSelfHealPreviewShutdown('receipt', 'A06', f.env, f.options);
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    try {
      const result = await Promise.race([outcome, new Promise(resolve => {
        timer = setTimeout(() => resolve({ error: new Error('TEST_REDIS_REPLY_DEADLINE_MISSING') }), 900);
      })]);
      expect(result.error?.message).toBe('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
      expect(Date.now() - started).toBeLessThan(900);
      expect(client.destroy).toHaveBeenCalledTimes(1);
      expect(client.isOpen).toBe(false);
      expect(f.journal.releaseBarrier).toHaveBeenCalledTimes(1);
      expect(f.journal.close).toHaveBeenCalledTimes(1);
      expect(f.journal.append).not.toHaveBeenCalled();
      if (withheld !== 'connect') expect(seen).toContain(withheld);
    } finally {
      clearTimeout(timer);
      if (client?.isOpen) client.destroy();
      for (const socket of sockets) socket.destroy();
      await outcome;
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('exact process identity parsing', () => {
  const fields = ['S', '1501', ...Array.from({ length: 17 }, () => '0'), '12345'];
  const stat = `1544 (node) ${fields.join(' ')}`;
  it('accepts only the fixed executable entry and actual numeric process start identity', () => {
    expect(parsePreviewShutdownProcess(1544, stat, '/usr/local/bin/node\0dist/workers/jobRunner.js\0', 'dist/workers/jobRunner.js'))
      .toEqual({ pid: 1544, parentPid: 1501, startTime: '12345' });
  });
  it.each(['foreign.js', 'dist/workers/jobRunner.js --unsafe', '/foreign/dist/workers/jobRunner.js'])('rejects a lookalike entry %s', entry => {
    expect(() => parsePreviewShutdownProcess(1544, stat, `/usr/local/bin/node\0${entry}\0`, 'dist/workers/jobRunner.js'))
      .toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
  });
  it('rejects mismatched PID, arbitrary selector and non-Node processes', () => {
    expect(() => parsePreviewShutdownProcess(1545, stat, '/usr/local/bin/node\0dist/workers/jobRunner.js\0', 'dist/workers/jobRunner.js')).toThrow();
    expect(() => parsePreviewShutdownProcess(1544, stat, '/usr/bin/sh\0dist/workers/jobRunner.js\0', 'dist/workers/jobRunner.js')).toThrow();
    expect(() => parsePreviewShutdownProcess(1544, stat, '/usr/local/bin/node\0foreign.js\0', 'foreign.js')).toThrow();
  });
  it('treats a zombie as the old process having exited', () => {
    expect(parsePreviewShutdownProcess(1544, stat.replace('(node) S', '(node) Z'), '', 'dist/workers/jobRunner.js')).toBeNull();
  });
});

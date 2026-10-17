import { describe, expect, it, jest } from '@jest/globals';
import type {
  SelfHealingInferencePolicy,
  SelfHealingInferenceStore
} from '../src/services/selfImprove/selfHealingInferenceAdmission.js';

const evalMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const environment: Record<string, string> = {
  RAILWAY_PROJECT_ID: 'fixture-project', RAILWAY_ENVIRONMENT_ID: 'fixture-environment'
};
jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: (key: string) => environment[key]
}));
jest.unstable_mockModule('@platform/runtime/redisLifecycle.js', () => ({
  executeRedisOperation: async (callback: (client: { eval: typeof evalMock }) => Promise<unknown>) =>
    callback({ eval: evalMock })
}));
const { createSelfHealingInferenceCoordinator, reserveSelfHealingInference, completeSelfHealingInference } =
  await import('../src/services/selfImprove/selfHealingInferenceAdmission.js');

const START = Date.parse('2026-10-17T18:10:00.000Z');
const policy: SelfHealingInferencePolicy = {
  credential: 'synthetic-fixture-credential', cooldownMs: 60_000, failureCooldownMs: 600_000
};

function sharedStore() {
  let rawState: string | null = null;
  let nowMs = START;
  const store: SelfHealingInferenceStore = {
    read: jest.fn(async () => ({ rawState, nowMs })),
    compareAndSet: jest.fn(async (expected, replacement) => {
      if (rawState !== expected) return false;
      rawState = replacement;
      return true;
    })
  };
  return {
    store,
    advance: (ms: number) => { nowMs += ms; },
    setNow: (value: number) => { nowMs = value; },
    readState: () => rawState === null ? null : JSON.parse(rawState),
    setState: (value: string) => { rawState = value; }
  };
}

async function reserve(coordinator: ReturnType<typeof createSelfHealingInferenceCoordinator>, overrides = {}) {
  const result = await coordinator.reserve({ ...policy, ...overrides });
  if (!result.allowed) throw new Error(`Fixture reservation denied: ${result.reason}`);
  return result.reservation;
}

describe('durable self-healing inference admission (local shared-store fixtures)', () => {
  it('admits one of simultaneous requests from independent runtime instances', async () => {
    const fixture = sharedStore();
    const worker = createSelfHealingInferenceCoordinator(fixture.store);
    const web = createSelfHealingInferenceCoordinator(fixture.store);
    const results = await Promise.all([worker.reserve(policy), web.reserve(policy), worker.reserve(policy)]);
    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results.filter(result => !result.allowed)).toEqual([
      expect.objectContaining({ reason: 'in_flight' }), expect.objectContaining({ reason: 'in_flight' })
    ]);
    expect(fixture.readState().attemptTimestampsMs).toHaveLength(1);
  });

  it('retains the diagnosis timestamp after restart, independent of any provider snapshot', async () => {
    const fixture = sharedStore();
    const first = createSelfHealingInferenceCoordinator(fixture.store);
    const reservation = await reserve(first);
    fixture.advance(5000);
    expect(await first.complete(reservation, { outcome: 'success' })).toBe(true);
    const restarted = createSelfHealingInferenceCoordinator(fixture.store);
    expect(await restarted.reserve(policy)).toEqual({
      allowed: false, reason: 'cooldown', lastAttemptAt: reservation.attemptedAt, failureCooldownActive: false,
      retryAt: new Date(START + 60_000).toISOString()
    });
    expect(fixture.readState().lastAttemptMs).toBe(START);
  });

  it('preserves the currently selected idle and active incident cooldown policies', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    const reservation = await reserve(coordinator, { cooldownMs: 1_800_000 });
    await coordinator.complete(reservation, { outcome: 'success' });
    fixture.advance(60_000);
    expect(await coordinator.reserve({ ...policy, cooldownMs: 1_800_000 }))
      .toMatchObject({ allowed: false, reason: 'cooldown' });
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: true });
  });

  it('preserves failure cooldown from failed completion time and permits expiry retry', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    const reservation = await reserve(coordinator);
    fixture.advance(5000);
    await coordinator.complete(reservation, { outcome: 'failure' });
    fixture.advance(599_999);
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: false, reason: 'cooldown' });
    fixture.advance(1);
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: true });
  });

  it('latches authentication failure durably without repeated revoked-credential retries', async () => {
    const fixture = sharedStore();
    const first = createSelfHealingInferenceCoordinator(fixture.store);
    await first.complete(await reserve(first), { outcome: 'authentication_failure' });
    const restarted = createSelfHealingInferenceCoordinator(fixture.store);
    for (let tick = 0; tick < 20; tick += 1) {
      fixture.advance(3_600_000);
      expect(await restarted.reserve(policy)).toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    }
    expect(fixture.readState().attemptTimestampsMs).toHaveLength(1);
    expect(JSON.stringify(fixture.readState())).not.toContain(policy.credential);
  });

  it('refuses a missing credential without touching the shared store', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    expect(await coordinator.reserve({ ...policy, credential: undefined }))
      .toMatchObject({ allowed: false, reason: 'missing_credential' });
    expect(fixture.store.read).not.toHaveBeenCalled();
  });

  it('enforces the default two-attempt hourly budget across runtimes and restarts', async () => {
    const fixture = sharedStore();
    for (let i = 0; i < 2; i += 1) {
      const instance = createSelfHealingInferenceCoordinator(fixture.store);
      await instance.complete(await reserve(instance), { outcome: 'success' });
      fixture.advance(60_000);
    }
    const restarted = createSelfHealingInferenceCoordinator(fixture.store);
    expect(await restarted.reserve(policy)).toMatchObject({ allowed: false, reason: 'budget_exhausted' });
    fixture.setNow(START + 3_600_000);
    expect(await restarted.reserve(policy)).toMatchObject({ allowed: true });
  });

  it.each([0, 7, Number.NaN, Number.POSITIVE_INFINITY])('rejects an unsafe inference budget %s', async value => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    expect(await coordinator.reserve({ ...policy, maxAttemptsPerHour: value }))
      .toMatchObject({ allowed: false, reason: 'invalid_policy' });
    expect(fixture.store.read).not.toHaveBeenCalled();
  });

  it('keeps the hourly cap rolling across a clock-hour boundary', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    await coordinator.complete(await reserve(coordinator), { outcome: 'success' });
    fixture.setNow(START + 3_500_000);
    await coordinator.complete(await reserve(coordinator), { outcome: 'success' });
    fixture.setNow(START + 3_600_000);
    await coordinator.complete(await reserve(coordinator), { outcome: 'success' });
    fixture.advance(60_000);
    expect(await coordinator.reserve(policy)).toMatchObject({
      allowed: false, reason: 'budget_exhausted', retryAt: new Date(START + 7_100_000).toISOString()
    });
  });

  it.each(['', '{', '{}', '{"version":2}', 'null'])('fails closed on corrupt state %s', async state => {
    const fixture = sharedStore();
    fixture.setState(state);
    expect(await createSelfHealingInferenceCoordinator(fixture.store).reserve(policy))
      .toMatchObject({ allowed: false, reason: 'invalid_state' });
  });

  it('rejects invalid timestamps and never regresses a recorded attempt during clock rollback', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    const reservation = await reserve(coordinator);
    fixture.setNow(START - 30_000);
    await coordinator.complete(reservation, { outcome: 'failure' });
    expect(fixture.readState().lastAttemptMs).toBe(START);
    expect(fixture.readState().lastFailureMs).toBe(START);
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: false, reason: 'clock_regression' });
    fixture.setNow(Number.NaN);
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: false, reason: 'invalid_state' });
    fixture.setNow(START);
    fixture.setState(JSON.stringify({ ...fixture.readState(), lastAttemptMs: 'not-a-timestamp' }));
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: false, reason: 'invalid_state' });
  });

  it('does not expire an uncertain in-flight call or unlock it with a stale reservation', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    const reservation = await reserve(coordinator);
    expect(await coordinator.complete(reservation, { outcome: 'uncertain' })).toBe(false);
    expect(await coordinator.complete({ ...reservation, token: 'wrong-owner' }, { outcome: 'success' })).toBe(false);
    fixture.advance(24 * 3_600_000);
    expect(await createSelfHealingInferenceCoordinator(fixture.store).reserve(policy))
      .toMatchObject({ allowed: false, reason: 'in_flight' });
  });

  it('fails closed when shared storage or atomic reservation is unavailable', async () => {
    const unavailable = createSelfHealingInferenceCoordinator({
      read: async () => { throw new Error('synthetic storage unavailable'); },
      compareAndSet: async () => false
    });
    expect(await unavailable.reserve(policy)).toMatchObject({ allowed: false, reason: 'coordination_unavailable' });
    const fixture = sharedStore();
    fixture.store.compareAndSet = jest.fn(async () => false);
    expect(await createSelfHealingInferenceCoordinator(fixture.store).reserve(policy))
      .toMatchObject({ allowed: false, reason: 'coordination_unavailable' });
    expect(fixture.store.compareAndSet).toHaveBeenCalledTimes(4);
  });

  it('charges uncertain reservation writes but never authorizes the provider', async () => {
    const fixture = sharedStore();
    const originalCas = fixture.store.compareAndSet;
    fixture.store.compareAndSet = async (expected, next) => {
      await originalCas(expected, next);
      throw new Error('synthetic acknowledgement lost');
    };
    expect(await createSelfHealingInferenceCoordinator(fixture.store).reserve(policy))
      .toMatchObject({ allowed: false, reason: 'coordination_unavailable' });
    expect(await createSelfHealingInferenceCoordinator(fixture.store).reserve(policy))
      .toMatchObject({ allowed: false, reason: 'in_flight' });
  });
});

describe('Redis admission adapter (mocked atomic commands, no live Redis)', () => {
  it('shares diagnosis state between services, persists without TTL, and isolates provider probes', async () => {
    const states = new Map<string, string>();
    const scripts: string[] = [];
    evalMock.mockImplementation(async (script, options) => {
      const { keys, arguments: args } = options as { keys: string[]; arguments: string[] };
      scripts.push(String(script));
      if (String(script).includes("redis.call('TIME')")) {
        return [states.has(keys[0]) ? 1 : 0, states.get(keys[0]) ?? '', String(START / 1000), '0'];
      }
      const current = states.get(keys[0]);
      if ((args[0] === 'absent' && current !== undefined)
        || (args[0] === 'present' && current !== args[1])) return 0;
      states.set(keys[0], args[2]);
      return 1;
    });
    environment.RAILWAY_SERVICE_NAME = 'ARCANOS Worker';
    const first = await reserveSelfHealingInference(policy);
    expect(first.allowed).toBe(true);
    environment.RAILWAY_SERVICE_NAME = 'ARCANOS V2';
    expect(await reserveSelfHealingInference(policy)).toMatchObject({ allowed: false, reason: 'in_flight' });
    const probe = await reserveSelfHealingInference({ ...policy, purpose: 'provider_probe' });
    expect(probe.allowed).toBe(true);
    expect(states.size).toBe(2);
    expect(scripts.join('\n')).not.toMatch(/EXPIRE|SETEX|\bPX\b|\bEX\b/);
    if (first.allowed) {
      expect(await completeSelfHealingInference(first.reservation, { outcome: 'success' })).toBe(true);
    }
    expect(await reserveSelfHealingInference(policy)).toMatchObject({ allowed: false, reason: 'cooldown' });
  });
});

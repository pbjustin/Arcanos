import { describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
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

  it('retains rejected credential identities across rotation, whitespace and successful recovery', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    await coordinator.complete(await reserve(coordinator), { outcome: 'authentication_failure' });
    fixture.advance(600_000);
    const rotated = 'synthetic-rotated-credential';
    await coordinator.complete(await reserve(coordinator, { credential: rotated }), { outcome: 'authentication_failure' });
    fixture.advance(600_000);
    for (const credential of [policy.credential, ` ${policy.credential} `, rotated]) {
      expect(await coordinator.reserve({ ...policy, credential }))
        .toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    }
    fixture.advance(3_600_000);
    await coordinator.complete(await reserve(coordinator, { credential: 'synthetic-recovered-credential' }), { outcome: 'success' });
    fixture.advance(3_600_000);
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    expect(fixture.readState().blockedCredentialIdentities).toHaveLength(2);
  });

  it('preserves a legacy rejection and fails closed when the bounded credential history is full or malformed', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    await coordinator.complete(await reserve(coordinator), { outcome: 'authentication_failure' });
    const legacy = fixture.readState();
    delete legacy.blockedCredentialIdentities;
    fixture.setState(JSON.stringify(legacy));
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    const blockedCredentialIdentities = [legacy.blockedCredentialIdentity, ...Array.from({ length: 31 }, (_, index) =>
      createHash('sha256').update(`synthetic-rejected-${index}`).digest('hex'))];
    fixture.setState(JSON.stringify({ ...legacy, blockedCredentialIdentities }));
    fixture.advance(3_600_000);
    expect(await coordinator.reserve({ ...policy, credential: 'synthetic-new-credential' }))
      .toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    fixture.setState(JSON.stringify({ ...legacy, blockedCredentialIdentities: [] }));
    expect(await coordinator.reserve(policy)).toMatchObject({ allowed: false, reason: 'invalid_state' });
  });

  it('permits a rotated probe after 60 seconds while preserving its rolling budget and unresolved reservation', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    const probePolicy = { ...policy, purpose: 'provider_probe' as const, failureCooldownMs: 60_000, maxAttemptsPerHour: 2 };
    const first = await reserve(coordinator, probePolicy);
    await coordinator.complete(first, { outcome: 'authentication_failure' });
    const rotatedPolicy = { ...probePolicy, credential: 'synthetic-rotated-credential' };
    fixture.advance(59_999);
    expect(await coordinator.reserve(rotatedPolicy)).toMatchObject({ allowed: false, reason: 'cooldown' });
    fixture.advance(1);
    const second = await reserve(coordinator, rotatedPolicy);
    fixture.advance(60_000);
    expect(await coordinator.reserve({ ...rotatedPolicy, credential: 'synthetic-third-credential' }))
      .toMatchObject({ allowed: false, reason: 'in_flight' });
    await coordinator.complete(second, { outcome: 'success' });
    expect(await coordinator.reserve({ ...rotatedPolicy, credential: 'synthetic-third-credential' }))
      .toMatchObject({ allowed: false, reason: 'budget_exhausted' });
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

  it('reconciles a proven terminal reservation by ownership without deleting cooldown, budget or credential evidence', async () => {
    const fixture = sharedStore();
    const coordinator = createSelfHealingInferenceCoordinator(fixture.store);
    const reservation = await reserve(coordinator);
    await coordinator.complete(reservation, { outcome: 'uncertain' });
    const attempts = fixture.readState().attemptTimestampsMs;
    fixture.advance(24 * 3_600_000);
    const restarted = createSelfHealingInferenceCoordinator(fixture.store);
    expect(await restarted.complete({ ...reservation, token: 'stale-owner' }, { outcome: 'failure' })).toBe(false);
    // Only a separately reviewed operator's terminal evidence permits this
    // existing completion transition; no elapsed-time/reset path calls it.
    expect(await restarted.complete(reservation, { outcome: 'authentication_failure' })).toBe(true);
    expect(fixture.readState()).toMatchObject({ inFlight: null, attemptTimestampsMs: attempts,
      lastAttemptMs: START, lastFailureMs: START + 24 * 3_600_000 });
    expect(await restarted.reserve(policy)).toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    expect(await restarted.reserve({ ...policy, credential: 'synthetic-new-credential' }))
      .toMatchObject({ allowed: false, reason: 'cooldown' });
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
  function redisLedgerFixture() {
    const states = new Map<string, string>();
    let nowMs = START;
    let beforeCompare: ((keys: string[]) => void) | null = null;
    evalMock.mockImplementation(async (script, options) => {
      const { keys, arguments: args } = options as { keys: string[]; arguments: string[] };
      expect(keys).toHaveLength(2);
      if (String(script).includes("redis.call('TIME')")) {
        return [states.has(keys[0]) ? 1 : 0, states.get(keys[0]) ?? '',
          states.has(keys[1]) ? 1 : 0, states.get(keys[1]) ?? '', String(Math.floor(nowMs / 1000)), String((nowMs % 1000) * 1000)];
      }
      expect(String(script)).toContain("local related = redis.call('GET', KEYS[2])");
      expect(args).toHaveLength(5);
      const callback = beforeCompare;
      beforeCompare = null;
      callback?.(keys);
      const current = states.get(keys[0]);
      const related = states.get(keys[1]);
      if ((args[0] === 'absent' && current !== undefined)
        || (args[0] === 'present' && current !== args[1])
        || (args[3] === 'absent' && related !== undefined)
        || (args[3] === 'present' && related !== args[4])) return 0;
      states.set(keys[0], args[2]);
      return 1;
    });
    return { states, advance: (ms: number) => { nowMs += ms; },
      beforeCompare: (callback: (keys: string[]) => void) => { beforeCompare = callback; } };
  }

  it.each(['diagnosis', 'provider_probe'] as const)('shares a %s rejection across purposes but permits another credential under separate budgets', async purpose => {
    const fixture = redisLedgerFixture();
    const first = await reserveSelfHealingInference({ ...policy, purpose });
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error('Fixture reservation denied.');
    await completeSelfHealingInference(first.reservation, { outcome: 'authentication_failure' });
    const otherPurpose = purpose === 'diagnosis' ? 'provider_probe' : 'diagnosis';
    expect(await reserveSelfHealingInference({ ...policy, purpose: otherPurpose }))
      .toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    expect(fixture.states.size).toBe(1);
    const rotated = await reserveSelfHealingInference({ ...policy, purpose: otherPurpose, credential: 'synthetic-rotated-credential' });
    expect(rotated.allowed).toBe(true);
    if (!rotated.allowed) throw new Error('Fixture rotation denied.');
    await completeSelfHealingInference(rotated.reservation, { outcome: 'success' });
    expect(await reserveSelfHealingInference({ ...policy, purpose: otherPurpose, credential: 'synthetic-rotated-credential' }))
      .toMatchObject({ allowed: false, reason: 'cooldown' });
    expect(await reserveSelfHealingInference({ ...policy, purpose: otherPurpose }))
      .toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    expect(JSON.parse(fixture.states.get(first.reservation.coordinationScope!)!).attemptTimestampsMs).toHaveLength(1);
  });

  it.each([false, true])('rejects an authentication race between reading and reserving with an existing own ledger: %s', async existingOwnLedger => {
    const rejectedFixture = sharedStore();
    const rejectedCoordinator = createSelfHealingInferenceCoordinator(rejectedFixture.store);
    await rejectedCoordinator.complete(await reserve(rejectedCoordinator), { outcome: 'authentication_failure' });
    const rejection = JSON.stringify(rejectedFixture.readState());
    const fixture = redisLedgerFixture();
    let ownKey: string | undefined;
    if (existingOwnLedger) {
      const first = await reserveSelfHealingInference(policy);
      if (!first.allowed) throw new Error('Fixture reservation denied.');
      ownKey = first.reservation.coordinationScope;
      await completeSelfHealingInference(first.reservation, { outcome: 'success' });
      fixture.advance(60_000);
    }
    const before = ownKey ? fixture.states.get(ownKey) : undefined;
    fixture.beforeCompare(keys => {
      ownKey = keys[0];
      fixture.states.set(keys[1], rejection);
    });
    expect(await reserveSelfHealingInference(policy)).toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    expect(fixture.states.get(ownKey!)).toBe(before);
  });

  it('fails closed on malformed or saturated sibling rejection history without creating an opposite reservation', async () => {
    const fixture = redisLedgerFixture();
    const first = await reserveSelfHealingInference(policy);
    if (!first.allowed) throw new Error('Fixture reservation denied.');
    await completeSelfHealingInference(first.reservation, { outcome: 'authentication_failure' });
    const key = first.reservation.coordinationScope!;
    const valid = JSON.parse(fixture.states.get(key)!);
    fixture.states.set(key, '{}');
    expect(await reserveSelfHealingInference({ ...policy, purpose: 'provider_probe' }))
      .toMatchObject({ allowed: false, reason: 'invalid_state' });
    fixture.states.set(key, JSON.stringify({ ...valid,
      blockedCredentialIdentities: [valid.blockedCredentialIdentity, ...Array.from({ length: 31 }, (_, index) =>
        createHash('sha256').update(`synthetic-rejected-${index}`).digest('hex'))] }));
    expect(await reserveSelfHealingInference({ ...policy, purpose: 'provider_probe', credential: 'synthetic-new-credential' }))
      .toMatchObject({ allowed: false, reason: 'authentication_blocked' });
    expect(fixture.states.size).toBe(1);
  });

  it('shares diagnosis state between services, persists without TTL, and isolates provider probes', async () => {
    const states = new Map<string, string>();
    const scripts: string[] = [];
    evalMock.mockImplementation(async (script, options) => {
      const { keys, arguments: args } = options as { keys: string[]; arguments: string[] };
      scripts.push(String(script));
      if (String(script).includes("redis.call('TIME')")) {
        return [states.has(keys[0]) ? 1 : 0, states.get(keys[0]) ?? '',
          states.has(keys[1]) ? 1 : 0, states.get(keys[1]) ?? '', String(START / 1000), '0'];
      }
      const current = states.get(keys[0]);
      if ((args[0] === 'absent' && current !== undefined)
        || (args[0] === 'present' && current !== args[1])) return 0;
      const related = states.get(keys[1]);
      if ((args[3] === 'absent' && related !== undefined)
        || (args[3] === 'present' && related !== args[4])) return 0;
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
      environment.RAILWAY_ENVIRONMENT_ID = 'another-fixture-environment';
      expect(await completeSelfHealingInference(first.reservation, { outcome: 'success' })).toBe(false);
      environment.RAILWAY_ENVIRONMENT_ID = 'fixture-environment';
      expect(await completeSelfHealingInference(first.reservation, { outcome: 'success' })).toBe(true);
    }
    expect(await reserveSelfHealingInference(policy)).toMatchObject({ allowed: false, reason: 'cooldown' });
  });

  it('binds read and CAS to one ledger and withholds admission if environment scope changes during Redis I/O', async () => {
    const calledKeys: string[] = [];
    const states = new Map<string, string>();
    evalMock.mockImplementation(async (script, options) => {
      const { keys, arguments: args } = options as { keys: string[]; arguments: string[] };
      calledKeys.push(keys[0]);
      if (String(script).includes("redis.call('TIME')")) {
        environment.RAILWAY_ENVIRONMENT_ID = 'changed-while-awaiting';
        return [0, '', 0, '', String(START / 1000), '0'];
      }
      states.set(keys[0], args[2]);
      return 1;
    });
    try {
      expect(await reserveSelfHealingInference(policy)).toMatchObject({ allowed: false, reason: 'coordination_unavailable' });
      expect(calledKeys).toHaveLength(2);
      expect(calledKeys[0]).toBe(calledKeys[1]);
      expect(JSON.parse(states.get(calledKeys[0])!).inFlight).not.toBe(null);
    } finally {
      environment.RAILWAY_ENVIRONMENT_ID = 'fixture-environment';
    }
  });
});

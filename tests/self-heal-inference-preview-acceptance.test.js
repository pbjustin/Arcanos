import { describe, expect, it } from '@jest/globals';
import { attestSelfHealInferenceController, attestSelfHealInferenceQuietWindow, runSelfHealInferenceAcceptanceCase,
  SELF_HEAL_INFERENCE_ACCEPTANCE_CASES } from '../scripts/self-heal-inference-preview-acceptance.mjs';

const NOW = Date.parse('2026-10-17T20:00:00.000Z');
const id = value => `${String(value).padStart(8, '0')}-1111-4111-8111-111111111111`;
function manifest(prNumber = 1557) {
  const names = { web: `arcanos-web-pr${prNumber}-heavy`, worker: `arcanos-worker-pr${prNumber}-heavy`, postgres: 'Postgres', redis: 'Redis' };
  const services = Object.keys(names).map((role, index) => ({ role, serviceId: id(index + 3), deploymentId: id(index + 7),
    imageDigest: `sha256:${'d'.repeat(64)}`, compiledSha256: ['web', 'worker'].includes(role) ? 'c'.repeat(64) : null }));
  const expiresAt = new Date(NOW + 7_200_000).toISOString();
  return { version: 1, budgetUsd: 3, controllerSha: 'b'.repeat(40), cleanupArmedUntil: expiresAt, services,
    receipt: { version: 1, owner: 'pbjustin', repository: 'pbjustin/Arcanos', prNumber, sourceSha: 'a'.repeat(40),
      runId: `self-heal-run-${prNumber}`, projectId: id(1), projectName: `arc-pr${prNumber}-heavy-test`,
      workspaceId: '1c9265a3-986f-4304-ad3e-5a874caab039', environmentId: id(2), environmentName: `backstage-heavy-pr-${prNumber}-e2e`,
      issuedAt: new Date(NOW).toISOString(), expiresAt,
      resources: { services: services.map(service => ({ id: service.serviceId, name: names[service.role] })), volumes: [
        { id: id(11), name: 'pg-test', serviceId: id(5), mountPath: '/var/lib/postgresql/data' },
        { id: id(12), name: 'redis-test', serviceId: id(6), mountPath: '/data' },
      ] } } };
}
function snapshot(evaluations = 0, running = false) {
  return { ready: true, processInstanceId: id(30), coordinator: { loopRunning: true, inFlight: false },
    scheduler: { callbacks: evaluations, intervalMs: 30_000 }, policy: { selfImproveEnabled: false, actuatorMode: 'daemon',
      autonomyLevel: 3, frozen: false, killSwitch: { frozen: false, autonomyLevel: 3 },
      predictiveEnabled: false, predictiveDryRun: false, predictiveAutoExecute: false }, claimBoundary: { faultRemaining: 0 },
    containment: { evidence: 'production_health_telemetry_and_redis', run: null, counters: { complete: true,
      evaluations, healthyEvaluations: evaluations, incidentEvaluations: 0, providerAttempts: 0, repairAttempts: 0, actionsExecuted: 0 },
    health: { unexpectedWorkerCount: 0, queue: { pending: 0, running: running ? 1 : 0, stalledRunning: 0 },
      workers: Array.from({ length: 8 }, (_, index) => ({ slot: index + 1, operationalStatus: 'healthy', stale: false,
        watchdogTriggered: false, restartRecommended: false, busy: running && index === 0,
        inactivityMs: 180_000, idleThresholdMs: 120_000 })) }, ledgers: [] } };
}
const fixture = receipts => ({ providerRequests: receipts.length, providerWireRequests: receipts.length, receipts, inFlight: null });

describe('PR1557 fixed hosted acceptance cases', () => {
  it.each(['head', 'origin', 'dirty'])('rejects local controller%s drift before hosted effects', async drift => {
    const value = manifest(); value.controllerSha = value.receipt.sourceSha;
    const command = async (_program, argv) => ({ stdout: argv[0] === 'rev-parse' ? (drift === 'head' ? 'b'.repeat(40) : value.controllerSha)
      : argv[0] === 'config' ? (drift === 'origin' ? 'https://github.com/foreign/repository.git' : 'https://github.com/pbjustin/Arcanos.git')
        : drift === 'dirty' ? ' M scripts/self-heal-inference-preview-acceptance.mjs' : '' });
    await expect(attestSelfHealInferenceController(value, { command })).rejects.toThrow('CONTROLLER_SOURCE_DRIFT');
  });
  it('binds the same clean canonical local commit to hosted source and controller identities', async () => {
    const value = manifest(); value.controllerSha = value.receipt.sourceSha;
    const command = async (_program, argv) => ({ stdout: argv[0] === 'rev-parse' ? value.controllerSha
      : argv[0] === 'config' ? 'git@github.com:pbjustin/Arcanos.git' : '' });
    await expect(attestSelfHealInferenceController(value, { command })).resolves.toMatchObject({ clean: true, sourceSha: value.receipt.sourceSha });
  });
  it('does not reuse the32coordinator cases or accept arbitrary scenarios', async () => {
    expect(SELF_HEAL_INFERENCE_ACCEPTANCE_CASES).toHaveLength(8);
    await expect(runSelfHealInferenceAcceptanceCase('A01', manifest(), { now: () => NOW })).rejects.toThrow('SCENARIO_INVALID');
    await expect(runSelfHealInferenceAcceptanceCase('idle_off', manifest(1544), { now: () => NOW })).rejects.toThrow('PROFILE_MISMATCH');
  });
  it('requires both explicit transport gates and remains inert in dry run', async () => {
    await expect(runSelfHealInferenceAcceptanceCase('idle_off', manifest(), { now: () => NOW })).resolves.toMatchObject({ executed: false, classification: 'NOT_RUN' });
    await expect(runSelfHealInferenceAcceptanceCase('idle_off', manifest(), { now: () => NOW, execute: true })).rejects.toThrow('NETWORK_GATES_REQUIRED');
  });
  it.each([false, true])('proves20healthy evaluations with%sone legitimate running job', running => {
    const paidJob = running ? [{ endpoint: 'responses', purpose: 'synthetic-completion' }] : [];
    expect(attestSelfHealInferenceQuietWindow(snapshot(0, running), snapshot(20, running), fixture(paidJob), fixture(paidJob),
      { running, scheduled: !running })).toMatchObject({ evaluations: 20, inferenceRequests: 0, repairAttempts: 0,
      degradationIncidents: 0, busySlots: running ? 1 : 0, idleSlots: running ? 7 : 8 });
  });
  it.each([
    state => { state.containment.counters.complete = false; },
    state => { state.containment.counters.incidentEvaluations = 1; },
    state => { state.containment.counters.providerAttempts = 1; },
    state => { state.containment.counters.repairAttempts = 1; },
    state => { state.containment.counters.actionsExecuted = 1; },
    state => { state.containment.health.workers[0].operationalStatus = 'degraded'; },
    state => { state.containment.health.workers[0].stale = true; },
    state => { state.containment.health.unexpectedWorkerCount = 1; },
    state => { state.containment.health.workers.pop(); },
    state => { state.containment.health.workers[7].slot = 1; },
    state => { state.containment.health.queue.pending = 1; },
    state => { state.containment.health.workers[3].inactivityMs = 119_999; },
    state => { state.scheduler.callbacks = 19; },
    state => { state.processInstanceId = id(31); },
  ])('rejects missing, degraded, incomplete or effectful quiet-window evidence %#', mutate => {
    const after = snapshot(20); mutate(after);
    expect(() => attestSelfHealInferenceQuietWindow(snapshot(), after, fixture([]), fixture([]), { scheduled: true })).toThrow();
  });
  it('rejects independent paid requests even when telemetry counters claim zero', () => {
    expect(() => attestSelfHealInferenceQuietWindow(snapshot(), snapshot(20), fixture([]),
      fixture([{ endpoint: 'responses' }]), { scheduled: true })).toThrow('UNEXPECTED_PROVIDER_REQUEST');
    expect(() => attestSelfHealInferenceQuietWindow(snapshot(), snapshot(20), fixture([]),
      fixture([{ endpoint: 'models' }]), { scheduled: true })).toThrow('UNEXPECTED_PROVIDER_REQUEST');
    expect(() => attestSelfHealInferenceQuietWindow(snapshot(), snapshot(20), fixture([]),
      { ...fixture([]), providerWireRequests: 1 }, { scheduled: true })).toThrow('UNEXPECTED_PROVIDER_REQUEST');
  });
  function harness(change) {
    let clock = NOW; let state = snapshot(); let elapsed = 0; const calls = []; const receipts = [];
    const transport = { targets: async () => ({}), remote: async (role, argv) => {
      calls.push([role, ...argv]);
      if (argv[0] === 'artifact') return { artifact: { compiledSha256: 'c'.repeat(64) } };
      if (argv[0] === 'provider') return { observation: fixture([]) };
      if (argv[0] === 'command') {
        if (argv[1].startsWith('containment_predictive_')) {
          state.policy.selfImproveEnabled = true; state.policy.predictiveEnabled = argv[1] === 'containment_predictive_on';
        }
        if (argv[1] === 'coordinator_stop') state.coordinator.loopRunning = false;
        if (argv[1] === 'coordinator_start') state.coordinator.loopRunning = true;
        if (argv[1] === 'policy_restore') state.policy.selfImproveEnabled = false;
      }
      return { observation: structuredClone(state) };
    } };
    return { calls, receipts, now: () => clock, transport, execute: true, allowNetwork: true,
      sleep: async ms => {
        clock += ms; elapsed += ms;
        if (state.policy.selfImproveEnabled && elapsed >= 30_000) {
          const ticks = Math.floor(elapsed / 30_000); elapsed %= 30_000;
          state.scheduler.callbacks += ticks; state.containment.counters.evaluations += ticks;
          state.containment.counters.healthyEvaluations += ticks;
          change?.(state);
        }
      }, onReceipt: value => receipts.push(value) };
  }
  it.each(['idle_off', 'idle_on'])('labels mocked%s execution synthetic and captures20real-timing-shaped samples', async scenario => {
    const env = harness(); const result = await runSelfHealInferenceAcceptanceCase(scenario, manifest(), env);
    expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', restoration: 'SYNTHETIC_ONLY',
      sourceSha: 'a'.repeat(40), productionAcceptanceProven: false, realExternalProviderRecoveryProven: false,
      proof: { scheduledCallbacks: 20, evaluations: 20, inferenceRequests: 0 } });
    expect(env.calls).not.toContainEqual(['worker', 'command', 'tick']);
    expect(env.receipts.some(receipt => receipt.kind === 'proof')).toBe(true);
    expect(env.calls).toContainEqual(['worker', 'command', 'policy_restore']);
  });
  it('does not conceal a transient unhealthy poll even if later callbacks could recover', async () => {
    const env = harness(state => { state.containment.health.workers[0].operationalStatus = 'degraded'; });
    const result = await runSelfHealInferenceAcceptanceCase('idle_on', manifest(), env);
    expect(result).toMatchObject({ classification: 'FAILED', errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_HEALTHY_FLEET_NOT_PROVEN' });
    expect(env.calls).toContainEqual(['worker', 'command', 'policy_restore']);
  });
  it('requires the effective predictive mode rather than trusting command acknowledgement', async () => {
    const env = harness(state => { state.policy.predictiveEnabled = false; });
    const result = await runSelfHealInferenceAcceptanceCase('idle_on', manifest(), env);
    expect(result).toMatchObject({ classification: 'FAILED', errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_QUIET_POLICY_NOT_PROVEN' });
  });
  it.each(['frozen', 'autonomy'])('rejects a shared kill-switch%s override during quiet-window proof', async override => {
    const env = harness(state => {
      if (override === 'frozen') state.policy.killSwitch.frozen = true;
      else state.policy.killSwitch.autonomyLevel = 2;
    });
    const result = await runSelfHealInferenceAcceptanceCase('idle_on', manifest(), env);
    expect(result).toMatchObject({ classification: 'FAILED', errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_QUIET_POLICY_NOT_PROVEN' });
  });
  it('does not mark rejected credential restoration as successful cleanup', async () => {
    const env = harness(); const remote = env.transport.remote;
    env.transport.remote = async (role, argv) => {
      const receipt = await remote(role, argv);
      return argv[1] === 'containment_credential_restore' ? { observation: { rejected: true, inspection: receipt.observation } } : receipt;
    };
    const result = await runSelfHealInferenceAcceptanceCase('idle_off', manifest(), env);
    expect(result).toMatchObject({ classification: 'BLOCKED', restoration: 'FAILED' });
  });
  it('restores the Web policy when an applied command loses its acknowledgement', async () => {
    const env = harness(); const remote = env.transport.remote;
    env.transport.remote = async (role, argv) => {
      const receipt = await remote(role, argv);
      if (role === 'web' && argv[1] === 'policy_predictive_no_execute') throw new Error('Acknowledgement lost.');
      return receipt;
    };
    const result = await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), env);
    expect(result.classification).toBe('BLOCKED');
    expect(env.calls).toContainEqual(['web', 'command', 'containment_cancel']);
    expect(env.calls).toContainEqual(['web', 'command', 'policy_restore']);
  });

  function orchestrationHarness() {
    let clock = NOW; let serial = 0; let fault = null; let credential = 'original'; let blockedOriginal = false;
    const states = { worker: snapshot(), web: snapshot() }; const fixtures = { worker: fixture([]), web: fixture([]) };
    const jobs = new Map(); const ledgers = new Map(); const calls = [];
    const key = (scenario, attempt) => `${scenario}:${attempt}`;
    const state = role => {
      states[role].containment.ledgers = [...ledgers.values()].map(value => ({ ...value }));
      return structuredClone(states[role]);
    };
    const wire = (role, endpoint, extra = {}) => {
      const value = fixtures[role]; value.providerRequests += 1; value.providerWireRequests += 1;
      const receipt = { requestId: `request-${++serial}`, endpoint, credential: role === 'worker' ? credential : 'original',
        outcome: 'completed', model: 'synthetic-core-model', startedAt: clock, endedAt: clock, ...extra };
      value.receipts.push(receipt); return receipt;
    };
    const completedJob = job => Object.assign(job, { status: 'completed', completionVerified: true,
      matchingClaimEvents: 1, matchingCompletionEvents: 1, literalObserved: job.literal });
    const finishDiagnosis = () => {
      states.worker.containment.run.status = 'completed';
      states.worker.containment.run.audit = { advisor: 'arcanos_core_v1', attempted: false, mode: 'recommend_only' };
      Object.assign(ledgers.get('diagnosis'), { inFlight: false, stateSha256: 'settled-diagnosis', lastCompletedMs: clock });
    };
    const transport = {
      targets: async () => ({}),
      restart: async () => {
        calls.push(['restart', 'worker']); states.worker = snapshot(); states.worker.processInstanceId = id(31);
        fixtures.worker = fixture([]); credential = 'original'; return { restartRequested: true };
      },
      remote: async (role, argv) => {
        calls.push([role, ...argv]); clock += 1;
        if (argv[0] === 'artifact') return { artifact: { compiledSha256: 'c'.repeat(64) } };
        if (argv[0] === 'provider') {
          if (argv[1] === 'set_healthy') fault = null;
          else if (argv[1] === 'release') {
            const held = fixtures.worker.receipts.find(receipt => receipt.requestId === fixtures.worker.inFlight);
            if (held) { held.outcome = 'completed'; held.endedAt = clock; }
            fixtures.worker.inFlight = null;
            if (states.worker.containment.run?.operation === 'diagnosis' && states.worker.containment.run.status === 'running') finishDiagnosis();
            for (const job of jobs.values()) if (job.status === 'running') completedJob(job);
            states.worker.containment.health.queue.running = 0;
            states.worker.containment.health.workers.forEach(worker => { worker.busy = false; });
          } else if (argv[1] !== 'inspect') fault = argv[1];
          return { observation: structuredClone(fixtures[role]) };
        }
        if (argv[0] === 'fenced-job') {
          const identity = key(argv[2], argv[3]);
          if (argv[1] === 'create') {
            const literal = argv[2] === 'I03';
            jobs.set(identity, { id: id(40 + jobs.size), literal, status: literal ? 'pending' : 'running', completionVerified: false });
            if (literal) states.worker.containment.health.queue.pending = 1;
            else {
              states.worker.containment.health.queue.running = 1; states.worker.containment.health.workers[0].busy = true;
              const receipt = wire('worker', 'responses', { purpose: 'synthetic-completion', fault: 'hold', outcome: 'in_flight' });
              fixtures.worker.inFlight = receipt.requestId; fault = null;
            }
          }
          return { fencedJob: { job: structuredClone(jobs.get(identity) ?? null) } };
        }
        if (argv[0] === 'command') {
          const name = argv[1]; const current = states[role];
          if (name === 'coordinator_stop') current.coordinator.loopRunning = false;
          if (name === 'coordinator_start') current.coordinator.loopRunning = true;
          if (name === 'policy_disabled' || name === 'policy_restore') current.policy.selfImproveEnabled = false;
          if (name.startsWith('containment_predictive_') || name === 'policy_predictive_no_execute') {
            current.policy.selfImproveEnabled = true;
            current.policy.predictiveEnabled = name !== 'containment_predictive_off';
          }
          if (name === 'containment_credential_rotate') credential = 'rotated';
          if (name === 'containment_credential_restore') credential = 'original';
          if (name === 'containment_dependency_failure') {
            states.worker.containment.health.workers[0].claimAcceptance = 'dependency_failure';
            states.worker.claimBoundary.faultRemaining = 64;
          }
          if (name === 'containment_dependency_restore') {
            states.worker.containment.health.workers[0].claimAcceptance = 'accepting';
            states.worker.claimBoundary.faultRemaining = 0; states.worker.containment.health.queue.pending = 0;
            for (const job of jobs.values()) if (job.status === 'pending') completedJob(job);
          }
          if (name === 'containment_tick_batch') {
            current.containment.counters.evaluations += 20; current.containment.counters.healthyEvaluations += 20;
            current.containment.run = { operation: 'tick_batch', status: 'completed', startedAt: new Date(clock).toISOString(), ticksCompleted: 20 };
          }
          if (name === 'containment_diagnose') {
            const existing = ledgers.get('diagnosis');
            current.containment.run = { operation: 'diagnosis', status: 'completed', startedAt: new Date(clock).toISOString() };
            if (existing) {
              current.containment.run.audit = { advisor: 'rules_fallback_v1', attempted: false, mode: 'recommend_only',
                timestamp: new Date(clock).toISOString(),
                inferenceReason: existing.inFlight ? 'in_flight' : 'active_incident_backoff' };
            } else {
              ledgers.set('diagnosis', { purpose: 'diagnosis', versionRecognized: true, stateSha256: 'held-diagnosis',
                inFlight: true, ttlMs: -1, attemptCount: 1, lastAttemptMs: clock, lastCompletedMs: null });
              const receipt = wire(role, 'responses', { purpose: 'predictive-decision', maxOutputTokens: 512,
                fault: fault === 'inference_cancel_next' ? 'cancel' : 'hold',
                outcome: fault === 'inference_cancel_next' ? 'transport_cancelled' : 'in_flight' });
              if (fault === 'inference_cancel_next') current.containment.run.audit = { advisor: 'rules_fallback_v1', attempted: false, mode: 'recommend_only' };
              else { current.containment.run.status = 'running'; fixtures.worker.inFlight = receipt.requestId; }
              fault = null;
            }
          }
          if (name === 'containment_probe') {
            const prior = ledgers.get('provider_probe'); const currentCredential = role === 'worker' ? credential : 'original';
            let failureReason = blockedOriginal && currentCredential === 'original' ? 'authentication_blocked'
              : prior && clock < prior.lastCompletedMs + 60_000 ? 'cooldown'
                : prior?.attemptCount >= 2 ? 'budget_exhausted' : null;
            current.containment.run = { operation: 'provider_probe', status: 'completed', startedAt: new Date(clock).toISOString(),
              provider: { failureReason, completionHealthy: false } };
            if (!failureReason) {
              const metadataFailure = ['models_auth_failure_next', 'models_timeout_next'].includes(fault);
              wire(role, 'models', { outcome: metadataFailure ? 'synthetic_failure' : 'completed' });
              if (fault === 'models_auth_failure_next') {
                blockedOriginal = true; current.containment.run.provider.failureStatus = 401;
              } else if (fault === 'models_timeout_next') current.containment.run.provider.failureCategory = 'timeout';
              else {
                wire(role, 'responses', { maxOutputTokens: 16 }); current.containment.run.provider.completionHealthy = true;
              }
              ledgers.set('provider_probe', { purpose: 'provider_probe', versionRecognized: true, inFlight: false,
                attemptCount: (prior?.attemptCount ?? 0) + 1, lastCompletedMs: clock,
                rejectedCredentialCount: blockedOriginal ? 1 : 0 }); fault = null;
            }
          }
        }
        return { observation: state(role) };
      },
    };
    return { execute: true, allowNetwork: true, transport, now: () => clock, sleep: async ms => { clock += ms; }, calls, ledgers };
  }
  it.each(['running_off', 'running_on', 'diagnosis_once', 'probe_rotation', 'metadata_recovery', 'uncertain_restart'])(
    'executes bounded%s orchestration with injected evidence and labels it synthetic', async scenario => {
      const env = orchestrationHarness();
      const result = await runSelfHealInferenceAcceptanceCase(scenario, manifest(), env);
      expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', restoration: 'SYNTHETIC_ONLY', errorCode: null,
        realExternalProviderRecoveryProven: false, productionAcceptanceProven: false });
      if (scenario === 'diagnosis_once') expect(result.proof).toMatchObject({ concurrentReservationDenialProven: true, pendingJobRecovered: true });
      if (scenario === 'probe_rotation' || scenario === 'metadata_recovery') expect(result.proof.hourlyBudgetDeniedAfterCooldown).toBe(true);
      if (scenario === 'uncertain_restart') expect(result.proof).toMatchObject({ operatorReconciliation: 'REQUIRED_NOT_PERFORMED', automaticReservationDeletion: false });
    });
  it('rejects a cross-process denial outside the independently recorded provider window', async () => {
    const env = orchestrationHarness(); const remote = env.transport.remote;
    env.transport.remote = async (role, argv) => {
      const receipt = await remote(role, argv);
      if (role === 'web' && receipt.observation?.containment?.run?.audit) {
        receipt.observation.containment.run.audit.timestamp = new Date(NOW - 1000).toISOString();
      }
      return receipt;
    };
    const result = await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), env);
    expect(result).toMatchObject({ classification: 'FAILED', errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_CONCURRENT_PROVIDER_WINDOW_NOT_PROVEN' });
  });
  it('blocks a consumed diagnosis budget rather than resetting it for the uncertain case', async () => {
    const env = orchestrationHarness();
    env.ledgers.set('diagnosis', { purpose: 'diagnosis', versionRecognized: true, inFlight: false, stateSha256: 'retained', attemptCount: 1 });
    const result = await runSelfHealInferenceAcceptanceCase('uncertain_restart', manifest(), env);
    expect(result).toMatchObject({ classification: 'BLOCKED', errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_UNCERTAIN_DIAGNOSIS_NOT_ADMITTED' });
    expect(env.ledgers.get('diagnosis').stateSha256).toBe('retained');
    expect(env.calls.some(call => call[0] === 'restart')).toBe(false);
  });
});

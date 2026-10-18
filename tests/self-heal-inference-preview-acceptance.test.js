import { describe, expect, it } from '@jest/globals';
import { attestSelfHealInferenceController, attestSelfHealInferenceQuietWindow, attestSelfHealInferenceLateCompletion, runSelfHealInferenceAcceptanceCase,
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
  return { ready: true, processInstanceId: id(30), receipts: [], coordinator: { loopRunning: true, inFlight: false },
    scheduler: { callbacks: evaluations, intervalMs: 30_000 }, policy: { selfImproveEnabled: false, actuatorMode: 'daemon',
      autonomyLevel: 3, frozen: false, killSwitch: { frozen: false, autonomyLevel: 3 },
      predictiveEnabled: false, predictiveDryRun: false, predictiveAutoExecute: false, predictiveStaleAfterMs: 120_000 }, claimBoundary: {
      evidence: 'actual_worker_before_claim_hook', attempts: 0, injectedFailures: 0,
      lastAttemptAt: null, lastInjectedFailureAt: null, faultUntil: null, faultRemaining: 0 },
    containment: { evidence: 'production_health_telemetry_and_redis', run: null, counters: { complete: true,
      evaluations, healthyEvaluations: evaluations, incidentEvaluations: 0, providerAttempts: 0, repairAttempts: 0, actionsExecuted: 0 },
    health: { unexpectedWorkerCount: 0, queue: { pending: 0, running: running ? 1 : 0, stalledRunning: 0 },
      workers: Array.from({ length: 8 }, (_, index) => ({ slot: index + 1, operationalStatus: 'healthy', stale: false,
        watchdogTriggered: false, restartRecommended: false, busy: running && index === 0,
        inactivityMs: 180_000, idleThresholdMs: 120_000 })) }, ledgers: [] } };
}
const fixture = receipts => ({ providerRequests: receipts.length, providerWireRequests: receipts.length, receipts, inFlight: null, nextFault: null });

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
    expect(SELF_HEAL_INFERENCE_ACCEPTANCE_CASES).toHaveLength(9);
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
    state => { state.containment.health = null; },
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

  const unknownDrainStates = [
    ['missing coordinator', value => { delete value.coordinator; }],
    ['null coordinator', value => { value.coordinator = null; }],
    ['missing inFlight', value => { delete value.coordinator.inFlight; }],
    ['null inFlight', value => { value.coordinator.inFlight = null; }],
    ['numeric inFlight', value => { value.coordinator.inFlight = 0; }],
    ['string inFlight', value => { value.coordinator.inFlight = ''; }],
    ['missing containment', value => { delete value.containment; }],
    ['missing run', value => { delete value.containment.run; }],
    ['unknown run status', value => { value.containment.run = { status: 'unknown' }; }],
    ['running operation', value => { value.containment.run = { status: 'running' }; }],
  ];
  describe.each(['worker', 'web'])('%s restoration drain', role => {
    it.each(unknownDrainStates)('continues safe restoration and publishes a blocked receipt for %s', async (_label, mutate) => {
      const env = orchestrationHarness(); const remote = env.transport.remote;
      const restores = []; const results = []; let cancelled = 0;
      env.onResult = result => { results.push(result); };
      env.transport.restore = async (argv, target) => {
        restores.push([target, ...argv]);
        const receipt = await remote(target, argv);
        if (target === role && argv[1] === 'containment_cancel') {
          cancelled += 1; mutate(receipt.observation);
          // Exercise both supported receipt projections through the same restoration path.
          if (role === 'web') return { observation: { inspection: receipt.observation } };
        }
        return receipt;
      };
      const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
      expect(result).toMatchObject({ classification: 'BLOCKED', restoration: 'FAILED',
        errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_RESTORATION_FAILED', productionAcceptanceProven: false });
      expect(cancelled).toBe(41); // Initial cancellation, then the unchanged bounded forty drain attempts.
      expect(restores).toContainEqual(['worker', 'command', 'containment_credential_restore']);
      expect(restores).toContainEqual(['web', 'command', 'containment_credential_restore']);
      expect(restores.at(-1)).toEqual(['worker', 'command', 'coordinator_start']);
      expect(results).toEqual([result]);
    });
    it('waits for a later explicit quiescent receipt instead of accepting unknown state', async () => {
      const env = orchestrationHarness(); const remote = env.transport.remote; let cancelled = 0;
      env.transport.restore = async (argv, target) => {
        const receipt = await remote(target, argv);
        if (target === role && argv[1] === 'containment_cancel' && ++cancelled <= 3) delete receipt.observation.coordinator;
        return receipt;
      };
      const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
      expect(cancelled).toBe(4);
      expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', restoration: 'SYNTHETIC_ONLY', errorCode: null });
    });
  });
  it.each(['inFlight', 'run'])('rejects unknown final Web %s evidence after a proven drain while publishing the result', async missing => {
    const env = orchestrationHarness(); const remote = env.transport.remote; const results = [];
    env.onResult = result => { results.push(result); };
    env.transport.restore = async (argv, role) => {
      const receipt = await remote(role, argv);
      if (role === 'web' && argv[1] === 'containment_credential_restore') {
        if (missing === 'inFlight') delete receipt.observation.coordinator.inFlight;
        else delete receipt.observation.containment.run;
      }
      return receipt;
    };
    const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
    expect(result).toMatchObject({ classification: 'BLOCKED', restoration: 'FAILED',
      errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_RESTORATION_FAILED' });
    expect(env.calls.at(-1)).toEqual(['worker', 'command', 'coordinator_start']);
    expect(results).toEqual([result]);
  });

  function orchestrationHarness(options = {}) {
    let clock = NOW; let serial = 0; let fault = null; let credential = 'original'; let blockedOriginal = false;
    const states = { worker: snapshot(), web: snapshot() }; const fixtures = { worker: fixture([]), web: fixture([]) };
    const jobs = new Map(); const ledgers = new Map(); const calls = []; let dependencyClaimAt = null;
    const startJob = job => {
      job.status = 'running'; states.worker.containment.health.queue.pending = 0;
      states.worker.containment.health.queue.running = 1; states.worker.containment.health.workers[0].busy = true;
      const receipt = wire('worker', 'responses', { purpose: 'synthetic-completion', fault: 'hold', outcome: 'in_flight' });
      fixtures.worker.inFlight = receipt.requestId; fault = null;
    };
    const advance = () => {
      const boundary = states.worker.claimBoundary;
      if (dependencyClaimAt !== null && clock >= dependencyClaimAt && clock < Date.parse(boundary.faultUntil)) {
        boundary.attempts += 1; boundary.injectedFailures += 1; boundary.faultRemaining -= 1;
        boundary.lastAttemptAt = new Date(clock).toISOString(); boundary.lastInjectedFailureAt = boundary.lastAttemptAt;
        states.worker.containment.health.workers[0].claimAcceptance = 'dependency_failure'; dependencyClaimAt = null;
      }
      for (const job of jobs.values()) {
        if (!job.literal && job.status === 'pending' && clock >= job.claimAt) startJob(job);
        if (job.literal && job.status === 'pending' && Number.isFinite(job.completeAt) && clock >= job.completeAt) completedJob(job);
      }
      for (const value of Object.values(fixtures)) {
        const active = value.receipts.find(receipt => receipt.requestId === value.inFlight);
        if (active?.fault === 'late_completion' && clock >= active.providerWorkDeadlineAt) {
          active.providerWorkCompletedAt = clock; active.endedAt = clock;
          active.outcome = active.clientClosedAt !== null ? 'synthetic_work_completed_after_client_close' : 'completed';
          active.responseDelivered = active.clientClosedAt === null; value.inFlight = null;
        }
      }
    };
    const key = (scenario, attempt) => `${scenario}:${attempt}`;
    const state = role => {
      states[role].policy.observedAt = new Date(clock).toISOString();
      states[role].containment.ledgers = ['diagnosis', 'provider_probe'].map(purpose => ({ ...(ledgers.get(purpose)
        ?? { purpose, versionRecognized: true, present: false, ttlMs: -2, stateSha256: null,
          inFlight: false, attemptCount: 0, lastAttemptMs: null, lastCompletedMs: null, rejectedCredentialCount: 0 }) }));
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
      states.worker.containment.run.completedAt = new Date(clock).toISOString();
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
        calls.push([role, ...argv]); clock += argv[0] === 'inspect' ? (options.inspectLatencyMs ?? 1) : 1; advance();
        if (argv[0] === 'artifact') return { artifact: { compiledSha256: 'c'.repeat(64) } };
        if (argv[0] === 'provider') {
          if (argv[1] === 'set_healthy') fault = null;
          else if (argv[1] === 'release') {
            const held = fixtures.worker.receipts.find(receipt => receipt.requestId === fixtures.worker.inFlight);
            if (held?.fault === 'late_completion') return { observation: structuredClone(fixtures[role]) };
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
            jobs.set(identity, { id: id(40 + jobs.size), literal, status: 'pending', completionVerified: false,
              claimAt: clock + (options.jobClaimDelayMs ?? 0) });
            states.worker.containment.health.queue.pending = 1;
            advance();
          }
          return { fencedJob: { job: structuredClone(jobs.get(identity) ?? null) } };
        }
        if (argv[0] === 'command') {
          const name = argv[1]; const current = states[role];
          current.receipts.push({ sequence: current.receipts.length + 1, event: `command:${name}`, at: new Date(clock).toISOString() });
          if (name === 'coordinator_stop') current.coordinator.loopRunning = false;
          if (name === 'coordinator_start') current.coordinator.loopRunning = true;
          if (name === 'policy_disabled' || name === 'policy_restore') current.policy.selfImproveEnabled = false;
          if (name.startsWith('containment_predictive_') || name === 'policy_predictive_no_execute') {
            current.policy.selfImproveEnabled = true;
            current.policy.predictiveEnabled = name !== 'containment_predictive_off';
          }
          if (name === 'containment_credential_rotate') credential = 'rotated';
          if (name === 'containment_credential_restore') credential = 'original';
          if (name === 'containment_cancel') {
            const active = fixtures[role].receipts.find(receipt => receipt.requestId === fixtures[role].inFlight);
            if (active?.fault === 'late_completion') {
              active.clientClosedAt ??= clock;
              current.containment.run.status = 'failed'; current.containment.run.completedAt = new Date(clock).toISOString();
            }
          }
          if (name === 'containment_dependency_failure') {
            states.worker.claimBoundary.faultRemaining = 64;
            states.worker.claimBoundary.faultUntil = new Date(clock + 45_000).toISOString();
            dependencyClaimAt = clock + (options.dependencyClaimDelayMs ?? 0);
            advance();
          }
          if (name === 'containment_dependency_restore') {
            states.worker.containment.health.workers[0].claimAcceptance = 'accepting';
            states.worker.claimBoundary.faultRemaining = 0; states.worker.claimBoundary.faultUntil = null;
            dependencyClaimAt = null; states.worker.containment.health.queue.pending = 0;
            for (const job of jobs.values()) if (job.status === 'pending') {
              job.completeAt = clock + (options.literalCompletionDelayMs ?? 0);
              if (job.completeAt === clock) completedJob(job);
            }
          }
          if (name === 'containment_tick_batch') {
            current.containment.counters.evaluations += 20; current.containment.counters.healthyEvaluations += 20;
            current.policy.observedAt = new Date(clock).toISOString();
            current.containment.run = { operation: 'tick_batch', status: 'completed', startedAt: new Date(clock).toISOString(), ticksCompleted: 20 };
          }
          if (name === 'containment_diagnose_no_ai') {
            current.containment.run = { operation: 'diagnosis', status: 'completed', startedAt: new Date(clock).toISOString(),
              completedAt: new Date(clock).toISOString(), processInstanceId: current.processInstanceId,
              inferenceAuthorization: 'disabled', executionAuthorized: false,
              audit: { source: 'self-heal.preview.measured-runtime', advisor: 'rules_fallback_v1', inferenceReason: 'inference_not_requested',
                selectedAction: 'heal_worker_runtime', attempted: false, mode: 'recommend_only',
                featureFlags: { enabled: true, dryRun: false, autoExecute: false } } };
          }
          if (name === 'containment_diagnose') {
            const existing = ledgers.get('diagnosis');
            current.containment.run = { operation: 'diagnosis', status: 'completed', startedAt: new Date(clock).toISOString(),
              completedAt: new Date(clock).toISOString(), processInstanceId: current.processInstanceId,
              inferenceAuthorization: 'manual', executionAuthorized: false };
            if (current.containment.providerHealth?.lastFailureCategory === 'timeout'
              && clock - Date.parse(current.containment.providerHealth.lastFailureAt) > 120_000) {
              current.containment.run.audit = { source: 'self-heal.preview.measured-runtime', advisor: 'rules_fallback_v1',
                attempted: false, mode: 'recommend_only', timestamp: new Date(clock).toISOString(),
                inferenceReason: 'no_actionable_incident', selectedAction: 'reinitialize_ai_provider' };
            } else if (existing) {
              current.containment.run.audit = { advisor: 'rules_fallback_v1', attempted: false, mode: 'recommend_only',
                timestamp: new Date(clock).toISOString(),
                inferenceReason: existing.inFlight ? 'in_flight' : 'active_incident_backoff' };
            } else {
              ledgers.set('diagnosis', { purpose: 'diagnosis', versionRecognized: true, stateSha256: 'e'.repeat(64),
                inFlight: true, ttlMs: -1, attemptCount: 1, lastAttemptMs: clock, lastCompletedMs: null });
              const receipt = wire(role, 'responses', { purpose: 'predictive-decision', maxOutputTokens: 512,
                fault: fault === 'inference_cancel_next' ? 'cancel' : fault === 'inference_late_completion_next' ? 'late_completion' : 'hold',
                outcome: fault === 'inference_cancel_next' ? 'transport_cancelled' : 'in_flight' });
              if (fault === 'inference_late_completion_next') Object.assign(receipt, { providerWorkKind: 'bounded_synthetic_completion',
                providerWorkStartedAt: clock, providerWorkDeadlineAt: clock + 40_000, clientClosedAt: null,
                providerWorkCompletedAt: null, providerWorkCancelledAt: null, responseDelivered: false, endedAt: null });
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
              current.containment.providerHealth = { evidence: 'production_merged_provider_health',
                lastAttemptAt: metadataFailure ? null : new Date(clock).toISOString(), lastSuccessAt: metadataFailure ? null : new Date(clock).toISOString(),
                lastFailureAt: metadataFailure ? new Date(clock).toISOString() : current.containment.providerHealth.lastFailureAt,
                lastFailureCategory: metadataFailure ? (fault === 'models_auth_failure_next' ? 'authentication' : 'timeout') : null,
                lastFailureStatus: fault === 'models_auth_failure_next' ? 401 : null,
                reachable: !metadataFailure, authenticated: !metadataFailure, completionHealthy: !metadataFailure };
              ledgers.set('provider_probe', { purpose: 'provider_probe', versionRecognized: true, inFlight: false,
                present: true, ttlMs: -1, stateSha256: 'f'.repeat(64), lastAttemptMs: clock,
                attemptCount: (prior?.attemptCount ?? 0) + 1, lastCompletedMs: clock,
                rejectedCredentialCount: blockedOriginal ? 1 : 0 }); fault = null;
            }
          }
        }
        return { observation: state(role) };
      },
    };
    return { execute: true, allowNetwork: true, transport, now: () => clock, sleep: async ms => { clock += ms; advance(); }, calls, ledgers, states, fixtures };
  }
  it.each(['running_off', 'running_on', 'diagnosis_once', 'probe_rotation', 'metadata_recovery', 'uncertain_restart'])(
    'executes bounded%s orchestration with injected evidence and labels it synthetic', async scenario => {
      const env = orchestrationHarness();
      const result = await runSelfHealInferenceAcceptanceCase(scenario, manifest(), env);
      expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', restoration: 'SYNTHETIC_ONLY', errorCode: null,
        realExternalProviderRecoveryProven: false, productionAcceptanceProven: false });
      if (scenario === 'diagnosis_once') expect(result.proof).toMatchObject({ concurrentReservationDenialProven: true, pendingJobRecovered: true,
        explicitDisabledInferenceDenied: true, disabledInferenceProviderRequests: 0, disabledInferenceLedgerUnchanged: true });
      if (scenario === 'probe_rotation' || scenario === 'metadata_recovery') expect(result.proof).toMatchObject({
        hourlyBudgetDeniedAfterCooldown: true, staleFailureSupersededByNewerSuccess: true, deniedProbesPreservedRecoveredHealth: true });
      if (scenario === 'uncertain_restart') expect(result.proof).toMatchObject({ operatorReconciliation: 'REQUIRED_NOT_PERFORMED', automaticReservationDeletion: false });
    });
  it('denies the no-AI request before arming the paid window and preserves existing probe history', async () => {
    const env = orchestrationHarness();
    env.ledgers.set('provider_probe', { purpose: 'provider_probe', versionRecognized: true, present: true,
      ttlMs: -1, stateSha256: 'a'.repeat(64), attemptCount: 2, inFlight: false });
    const result = await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), env);
    expect(result.classification).toBe('SYNTHETIC_ONLY');
    const denial = env.calls.findIndex(call => call[2] === 'containment_diagnose_no_ai');
    const hold = env.calls.findIndex(call => call[2] === 'inference_hold_next');
    expect(denial).toBeGreaterThan(0); expect(hold).toBeGreaterThan(denial);
    expect(env.fixtures.worker.receipts.filter(receipt => receipt.endpoint === 'responses')).toHaveLength(1);
    expect(env.ledgers.get('provider_probe').stateSha256).toBe('a'.repeat(64));
  });
  it.each(['not_actionable', 'wrong_reason', 'manual', 'dry_run', 'missing_incident', 'incomplete', 'provider_event', 'repair', 'ledger', 'wire'])(
    'rejects invalid disabled-AI proof before spending the authorized request: %s', async drift => {
      const env = orchestrationHarness(); const remote = env.transport.remote;
      env.transport.remote = async (role, argv) => {
        const result = await remote(role, argv);
        if (argv[1] === 'containment_diagnose_no_ai') {
          const value = result.observation.containment;
          if (drift === 'not_actionable') value.run.audit.selectedAction = 'none';
          if (drift === 'wrong_reason') value.run.audit.inferenceReason = 'no_actionable_incident';
          if (drift === 'manual') value.run.inferenceAuthorization = 'manual';
          if (drift === 'dry_run') value.run.audit.featureFlags.dryRun = true;
          if (drift === 'missing_incident') value.health.queue.pending = 0;
          if (drift === 'incomplete') value.counters.complete = false;
          if (drift === 'provider_event') value.counters.providerAttempts += 1;
          if (drift === 'repair') value.counters.repairAttempts += 1;
          if (drift === 'ledger') value.ledgers[0].attemptCount += 1;
          if (drift === 'wire') env.fixtures.worker.providerWireRequests += 1;
        }
        return result;
      };
      const result = await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), env);
      expect(result.classification).toBe('FAILED');
      expect(result.errorCode).toContain('DISABLED_INFERENCE');
      expect(env.calls).not.toContainEqual(['worker', 'provider', 'inference_hold_next']);
      expect(env.calls).not.toContainEqual(['worker', 'command', 'containment_diagnose']);
    });
  it.each(['older_success', 'equal_success', 'cleared_history', 'uncleared_category', 'uncleared_status', 'unhealthy',
    'missing_projection', 'cooldown_rewrite', 'budget_rewrite'])(
    'rejects invalid recovered provider history or denied-probe mutation: %s', async drift => {
      const env = orchestrationHarness(); const remote = env.transport.remote; let probes = 0;
      env.transport.remote = async (role, argv) => {
        const result = await remote(role, argv);
        if (role === 'worker' && argv[1] === 'containment_probe') {
          probes += 1;
          const health = result.observation.containment.providerHealth;
          if (probes === 2) {
            if (drift === 'older_success') health.lastSuccessAt = new Date(Date.parse(health.lastFailureAt) - 1).toISOString();
            if (drift === 'equal_success') health.lastSuccessAt = health.lastFailureAt;
            if (drift === 'cleared_history') health.lastFailureAt = null;
            if (drift === 'uncleared_category') health.lastFailureCategory = 'timeout';
            if (drift === 'uncleared_status') health.lastFailureStatus = 503;
            if (drift === 'unhealthy') health.completionHealthy = false;
            if (drift === 'missing_projection') result.observation.containment.providerHealth = null;
          }
          if ((probes === 3 && drift === 'cooldown_rewrite') || (probes === 4 && drift === 'budget_rewrite')) {
            health.lastAttemptAt = new Date(Date.parse(health.lastAttemptAt) + 1).toISOString();
          }
        }
        return result;
      };
      const result = await runSelfHealInferenceAcceptanceCase('metadata_recovery', manifest(), env);
      expect(result.classification).toBe('FAILED');
      expect(result.errorCode).toMatch(/RECOVERED_PROVIDER_HISTORY_NOT_PROVEN|DENIED_PROBE_CHANGED_PROVIDER_HEALTH/u);
    });

  it('naturally ages a real metadata failure before an effect-free manual diagnosis and preserves recovery', async () => {
    const env = orchestrationHarness();
    const result = await runSelfHealInferenceAcceptanceCase('metadata_recovery', manifest(), env);
    expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', errorCode: null, proof: {
      staleProviderFailureDeniedInference: true, providerFreshnessWindowMs: 120_000,
      historicalProviderDiagnosisRequests: 0, historicalProviderLedgersUnchanged: true,
      authorizedRecoverySucceeded: true, inferenceRequests: 1, probeAttempts: 2 } });
    expect(result.proof.providerFailureAgeMs).toBeGreaterThan(120_000);
    expect(Date.parse(result.proof.deniedDiagnosisAt) - Date.parse(result.proof.historicalFailureAt)).toBe(result.proof.providerFailureAgeMs);
    const diagnosis = env.calls.findIndex(call => call[0] === 'worker' && call[2] === 'containment_diagnose');
    const probes = env.calls.map((call, index) => call[0] === 'worker' && call[2] === 'containment_probe' ? index : -1).filter(index => index >= 0);
    expect(diagnosis).toBeGreaterThan(probes[0]); expect(diagnosis).toBeLessThan(probes[1]);
    expect(env.ledgers.has('diagnosis')).toBe(false);
  });

  it.each(['cooldown', 'wrong_action', 'wrong_advisor', 'automatic', 'execution', 'provider_attempt', 'repair',
    'incomplete', 'worker_drift', 'failure_changed', 'diagnosis_ledger', 'probe_ledger', 'wire_request'])(
    'rejects a false historical-provider denial proof: %s', async drift => {
      const env = orchestrationHarness(); const remote = env.transport.remote;
      env.transport.remote = async (role, argv) => {
        const result = await remote(role, argv);
        if (role === 'worker' && argv[1] === 'containment_diagnose') {
          const state = result.observation; const run = state.containment.run;
          if (drift === 'cooldown') run.audit.inferenceReason = 'idle_window_backoff';
          if (drift === 'wrong_action') run.audit.selectedAction = 'none';
          if (drift === 'wrong_advisor') run.audit.advisor = 'arcanos_core_v1';
          if (drift === 'automatic') run.inferenceAuthorization = 'automatic';
          if (drift === 'execution') run.executionAuthorized = true;
          if (drift === 'provider_attempt') state.containment.counters.providerAttempts += 1;
          if (drift === 'repair') state.containment.counters.repairAttempts += 1;
          if (drift === 'incomplete') state.containment.counters.complete = false;
          if (drift === 'worker_drift') state.containment.health.workers[0].operationalStatus = 'degraded';
          if (drift === 'failure_changed') state.containment.providerHealth.lastFailureAt = new Date(env.now()).toISOString();
          if (drift === 'diagnosis_ledger') state.containment.ledgers[0].attemptCount += 1;
          if (drift === 'probe_ledger') state.containment.ledgers[1].stateSha256 = 'd'.repeat(64);
          if (drift === 'wire_request') env.fixtures.worker.providerWireRequests += 1;
        }
        return result;
      };
      const result = await runSelfHealInferenceAcceptanceCase('metadata_recovery', manifest(), env);
      expect(result.classification).toBe('FAILED');
      expect(result.errorCode).toMatch(/HISTORICAL_PROVIDER|HEALTHY_FLEET/u);
      expect(env.calls.filter(call => call[0] === 'worker' && call[2] === 'containment_probe')).toHaveLength(1);
    });

  it.each(['missing_policy', 'changed_policy', 'future_failure', 'new_failure', 'unaged_runtime_clock', 'exact_window_boundary'])(
    'refuses guessed or changed provider freshness before diagnosis: %s', async drift => {
      const env = orchestrationHarness(); const remote = env.transport.remote;
      env.transport.remote = async (role, argv) => {
        const result = await remote(role, argv); const state = result.observation;
        if (role === 'worker' && state?.containment?.providerHealth?.lastFailureCategory === 'timeout') {
          if (drift === 'missing_policy') delete state.policy.predictiveStaleAfterMs;
          if (drift === 'changed_policy') state.policy.predictiveStaleAfterMs = 60_000;
          if (drift === 'future_failure') state.containment.providerHealth.lastFailureAt = new Date(NOW + 600_000).toISOString();
          if (argv[0] === 'inspect' && drift === 'new_failure') state.containment.providerHealth.lastFailureAt = new Date(env.now()).toISOString();
          if (drift === 'unaged_runtime_clock') state.policy.observedAt = state.containment.providerHealth.lastFailureAt;
          if (drift === 'exact_window_boundary') state.policy.observedAt = new Date(Date.parse(state.containment.providerHealth.lastFailureAt) + 120_000).toISOString();
        }
        return result;
      };
      const result = await runSelfHealInferenceAcceptanceCase('metadata_recovery', manifest(), env);
      expect(['FAILED', 'BLOCKED']).toContain(result.classification);
      expect(env.calls).not.toContainEqual(['worker', 'command', 'containment_diagnose']);
      expect(env.calls.filter(call => call[0] === 'worker' && call[2] === 'containment_probe')).toHaveLength(1);
    });
  it.each(['diagnosis_once', 'uncertain_restart', 'late_completion'])(
    'waits through the real thirty-second idle-claim backoff and delayed snapshot for%s', async scenario => {
      const env = orchestrationHarness({ dependencyClaimDelayMs: 30_000, inspectLatencyMs: 3500 });
      const result = await runSelfHealInferenceAcceptanceCase(scenario, manifest(), env);
      expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', errorCode: null, restoration: 'SYNTHETIC_ONLY' });
      expect(env.calls).toContainEqual(['worker', 'command', 'containment_diagnose']);
    });
  it.each(['running_off', 'running_on'])(
    'observes%s job pickup after thirty seconds without extending its provider hold', async scenario => {
      const env = orchestrationHarness({ jobClaimDelayMs: 30_000, inspectLatencyMs: 3500 });
      const result = await runSelfHealInferenceAcceptanceCase(scenario, manifest(), env);
      expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', proof: { evaluations: 20,
        ordinaryJobCompletedOnce: true, inferenceRequests: 0, repairAttempts: 0, degradationIncidents: 0 } });
      const request = env.fixtures.worker.receipts.find(value => value.endpoint === 'responses');
      expect(request.startedAt - NOW).toBeGreaterThanOrEqual(30_000);
      expect(request.endedAt - request.startedAt).toBeLessThan(30_000);
    });
  it.each(['diagnosis_once', 'uncertain_restart', 'late_completion'])(
    'retains the sixty-second%s recovery window for a delayed ordinary literal-job claim', async scenario => {
      const env = orchestrationHarness({ literalCompletionDelayMs: 30_000 });
      const result = await runSelfHealInferenceAcceptanceCase(scenario, manifest(), env);
      expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', errorCode: null, restoration: 'SYNTHETIC_ONLY' });
      expect(env.calls.filter(call => call[1] === 'fenced-job' && call[2] === 'create')).toHaveLength(1);
      if (scenario !== 'uncertain_restart') expect(result.proof.pendingJobRecovered).toBe(true);
    });
  it('renews a proven fault before creating pending work when the initial observation is near expiry', async () => {
    const env = orchestrationHarness({ dependencyClaimDelayMs: 44_000 }); const events = []; env.onReceipt = value => events.push(value);
    const result = await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), env);
    expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', proof: { pendingJobRecovered: true } });
    const created = env.calls.findIndex(call => call[1] === 'fenced-job' && call[2] === 'create');
    const absent = env.calls.findIndex(call => call[1] === 'fenced-job' && call[2] === 'inspect');
    const firstArm = env.calls.findIndex(call => call[2] === 'containment_dependency_failure');
    expect(absent).toBeLessThan(firstArm);
    expect(env.calls[created - 1]).toEqual(['worker', 'command', 'containment_dependency_failure']);
    const arms = events.filter(event => event.kind === 'operation' && event.value.argv[1] === 'containment_dependency_failure');
    expect(Date.parse(arms[1].observedAt) - Date.parse(arms[0].observedAt)).toBeGreaterThanOrEqual(44_000);
    expect(Date.parse(arms[1].value.receipt.observation.claimBoundary.faultUntil) - Date.parse(arms[1].observedAt)).toBe(45_000);
  });
  it('uses a fresh failure already present in the arm acknowledgement without another pre-job poll', async () => {
    const env = orchestrationHarness();
    expect((await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), env)).classification).toBe('SYNTHETIC_ONLY');
    const arm = env.calls.findIndex(call => call[2] === 'containment_dependency_failure');
    expect(env.calls.slice(arm + 1, arm + 3)).toEqual([
      ['worker', 'command', 'containment_dependency_failure'], ['worker', 'fenced-job', 'create', 'I03', '1'],
    ]);
  });
  it.each(['rejected', 'lost_acknowledgement', 'missing_arm_receipt', 'expired_at_snapshot'])(
    'does not create a pending job after a%s pre-job re-arm', async fault => {
      const env = orchestrationHarness(); const remote = env.transport.remote; let arms = 0;
      env.transport.remote = async (role, argv) => {
        const receipt = await remote(role, argv);
        if (argv[1] === 'containment_dependency_failure' && ++arms === 2) {
          if (fault === 'rejected') return { observation: { rejected: true } };
          if (fault === 'lost_acknowledgement') throw new Error('Synthetic lost acknowledgement after bounded arm.');
          if (fault === 'missing_arm_receipt') receipt.observation.receipts = [];
          if (fault === 'expired_at_snapshot') receipt.observation.policy.observedAt = receipt.observation.claimBoundary.faultUntil;
        }
        return receipt;
      };
      const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
      expect(result).toMatchObject({ classification: 'BLOCKED', restoration: 'SYNTHETIC_ONLY', proof: null });
      expect(env.calls.some(call => call[1] === 'fenced-job' && call[2] === 'create')).toBe(false);
      expect(env.calls).not.toContainEqual(['worker', 'command', 'containment_diagnose']);
      expect(env.fixtures.worker.providerWireRequests).toBe(0);
      expect(env.ledgers.size).toBe(0);
    });
  it('does not spend or create a job when stale worker failure never produces a fresh claim failure', async () => {
    const env = orchestrationHarness({ dependencyClaimDelayMs: 45_000 });
    env.states.worker.containment.health.workers[0].claimAcceptance = 'dependency_failure';
    env.states.worker.claimBoundary.injectedFailures = 1;
    env.states.worker.claimBoundary.lastInjectedFailureAt = new Date(NOW - 1000).toISOString();
    const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
    expect(result).toMatchObject({ classification: 'BLOCKED', restoration: 'SYNTHETIC_ONLY',
      errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_OBSERVATION_NOT_ESTABLISHED', proof: null });
    expect(env.calls.filter(call => call[2] === 'containment_dependency_failure')).toHaveLength(1);
    expect(env.calls.some(call => call[1] === 'fenced-job' && call[2] === 'create')).toBe(false);
    expect(env.calls).not.toContainEqual(['worker', 'command', 'containment_diagnose']);
    expect(env.fixtures.worker.providerWireRequests).toBe(0);
    expect(env.ledgers.size).toBe(0);
  });
  it.each(['stale_counter', 'stale_timestamp', 'different_process', 'expired_fault', 'exhausted_fault', 'changed_arm'])(
    'does not accept%s as evidence of the current dependency arm', async fault => {
      const env = orchestrationHarness({ dependencyClaimDelayMs: 5000 }); const remote = env.transport.remote;
      env.transport.remote = async (role, argv) => {
        const receipt = await remote(role, argv); const value = receipt.observation;
        if (role === 'worker' && value?.claimBoundary?.faultUntil) {
          if (fault === 'stale_counter') value.claimBoundary.injectedFailures = 0;
          if (fault === 'stale_timestamp') value.claimBoundary.lastInjectedFailureAt = new Date(NOW - 1000).toISOString();
          if (fault === 'different_process') value.processInstanceId = id(31);
          if (fault === 'expired_fault') value.policy.observedAt = value.claimBoundary.faultUntil;
          if (fault === 'exhausted_fault') value.claimBoundary.faultRemaining = 0;
          if (fault === 'changed_arm' && argv[0] === 'inspect') value.claimBoundary.faultUntil = new Date(NOW + 90_000).toISOString();
        }
        return receipt;
      };
      const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
      expect(result).toMatchObject({ classification: 'BLOCKED', proof: null });
      expect(env.calls.some(call => call[1] === 'fenced-job' && call[2] === 'create')).toBe(false);
      expect(env.calls).not.toContainEqual(['worker', 'command', 'containment_diagnose']);
      expect(env.fixtures.worker.providerWireRequests).toBe(0);
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
  it('reads independent running baselines concurrently and releases immediately after the busy tick snapshot', async () => {
    const env = orchestrationHarness(); const remote = env.transport.remote;
    let releaseWorkerBaseline; let workerBaselineStarted = false; let observedParallelBaseline = false;
    env.transport.remote = async (role, argv) => {
      const receipt = await remote(role, argv);
      if (role === 'worker' && argv[0] === 'provider' && argv[1] === 'inspect' && !workerBaselineStarted) {
        workerBaselineStarted = true;
        return new Promise(resolve => { releaseWorkerBaseline = () => resolve(receipt); });
      }
      if (role === 'web' && argv[0] === 'provider' && argv[1] === 'inspect' && releaseWorkerBaseline) {
        observedParallelBaseline = true; releaseWorkerBaseline(); releaseWorkerBaseline = null;
      }
      return receipt;
    };
    const result = await runSelfHealInferenceAcceptanceCase('running_off', manifest(), env);
    expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', proof: { evaluations: 20, ordinaryJobCompletedOnce: true } });
    expect(observedParallelBaseline).toBe(true);
    const batch = env.calls.findIndex(call => call[2] === 'containment_tick_batch');
    const release = env.calls.findIndex(call => call[0] === 'worker' && call[1] === 'provider' && call[2] === 'release');
    expect(env.calls.slice(batch + 1, release)).toEqual([]);
    expect(env.calls[release + 1]).toEqual(['web', 'provider', 'inspect']);
  });
  it.each(['timeout', 'client_closed', 'different_request', 'early_terminal'])(
    'does not accept a%s held request as the ordinary running-job completion', async failure => {
      const env = orchestrationHarness(); const remote = env.transport.remote;
      env.transport.remote = async (role, argv) => {
        const receipt = await remote(role, argv);
        if (role === 'worker' && argv[0] === 'provider' && argv[1] === 'release') {
          const terminal = receipt.observation.receipts.at(-1);
          if (failure === 'different_request') terminal.requestId = 'test-unrelated-request';
          else if (failure === 'early_terminal') terminal.endedAt = NOW - 1000;
          else terminal.outcome = failure;
        }
        return receipt;
      };
      const result = await runSelfHealInferenceAcceptanceCase('running_off', manifest(), env);
      expect(result).toMatchObject({ classification: 'FAILED' });
      expect(result.proof?.ordinaryJobCompletedOnce).not.toBe(true);
    });
  it('keeps the Core deadline for overlap and release by using the completed Web acknowledgement', async () => {
    const env = orchestrationHarness();
    const result = await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), env);
    expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', proof: { concurrentReservationDenialProven: true } });
    const armed = env.calls.findIndex(call => call[2] === 'inference_hold_next');
    const overlap = env.calls.findIndex(call => call[0] === 'web' && call[2] === 'containment_diagnose');
    const release = env.calls.findIndex(call => call[0] === 'worker' && call[2] === 'release');
    expect(env.calls.slice(armed + 1, release)).not.toContainEqual(['worker', 'command', 'containment_dependency_failure']);
    expect(env.calls.slice(overlap + 1, release)).toEqual([]);
  });
  it('still polls a running initial operation and rejects a mismatched terminal operation', async () => {
    const running = orchestrationHarness(); const runRemote = running.transport.remote;
    running.transport.remote = async (role, argv) => {
      const receipt = await runRemote(role, argv);
      if (argv[2] === undefined && argv[1] === 'containment_tick_batch') receipt.observation.containment.run.status = 'running';
      return receipt;
    };
    expect((await runSelfHealInferenceAcceptanceCase('running_off', manifest(), running)).classification).toBe('SYNTHETIC_ONLY');
    const batch = running.calls.findIndex(call => call[2] === 'containment_tick_batch');
    expect(running.calls[batch + 1]).toEqual(['worker', 'inspect']);
    const wrong = orchestrationHarness(); const wrongRemote = wrong.transport.remote;
    wrong.transport.remote = async (role, argv) => {
      const receipt = await wrongRemote(role, argv);
      if (role === 'web' && argv[1] === 'containment_diagnose') receipt.observation.containment.run.operation = 'provider_probe';
      return receipt;
    };
    expect(await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), wrong)).toMatchObject({
      classification: 'BLOCKED', errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_OPERATION_NOT_STARTED' });
  });
  it('blocks a consumed diagnosis budget rather than resetting it for the uncertain case', async () => {
    const env = orchestrationHarness();
    env.ledgers.set('diagnosis', { purpose: 'diagnosis', versionRecognized: true, inFlight: false, stateSha256: 'retained', attemptCount: 1 });
    const result = await runSelfHealInferenceAcceptanceCase('uncertain_restart', manifest(), env);
    expect(result).toMatchObject({ classification: 'BLOCKED', errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_UNCERTAIN_DIAGNOSIS_NOT_ADMITTED' });
    expect(env.ledgers.get('diagnosis').stateSha256).toBe('retained');
    expect(env.calls.some(call => call[0] === 'restart')).toBe(false);
  });
  it.each(['health', 'ledgers'])('rejects unavailable%s telemetry as diagnosis proof even when commands acknowledge effects', async field => {
    const env = orchestrationHarness(); const remote = env.transport.remote;
    env.transport.remote = async (role, argv) => {
      const receipt = await remote(role, argv);
      if (receipt.observation?.containment) receipt.observation.containment[field] = null;
      return receipt;
    };
    const result = await runSelfHealInferenceAcceptanceCase('diagnosis_once', manifest(), env);
    expect(['FAILED', 'BLOCKED']).toContain(result.classification);
    expect(result.proof).toBeNull();
    expect(env.calls).toContainEqual(['worker', 'command', 'policy_restore']);
    expect(env.calls.some(call => call[0] === 'restart')).toBe(false);
  });
  it('retains the same reservation through cancellation, late work and restart without claiming synthetic evidence as hosted', async () => {
    const env = orchestrationHarness(); const events = []; env.onReceipt = value => events.push(value);
    const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
    expect(result).toMatchObject({ classification: 'SYNTHETIC_ONLY', restoration: 'SYNTHETIC_ONLY', errorCode: null,
      proof: { explicitOperatorCancellation: true, acceptedInferenceRequests: 1, responseDelivered: false,
        crossProcessDeniedWhileWorkActive: true, reservationSurvivedLateCompletion: true, reservationSurvivedRestart: true,
        repairAttempts: 0, operatorReconciliation: 'REQUIRED_NOT_PERFORMED' } });
    expect(env.calls.filter(call => call[0] === 'restart')).toHaveLength(1);
    const terminal = events.find(event => event.kind === 'operation' && event.value.argv[0] === 'provider'
      && event.value.receipt.observation.receipts.some(receipt => receipt.outcome === 'synthetic_work_completed_after_client_close'));
    expect(terminal.sequence).toBeLessThan(events.find(event => event.kind === 'restart').sequence);
    expect(env.calls).toContainEqual(['web', 'command', 'containment_credential_restore']);
  });
  it.each(['used_scope', 'queued_fault', 'running_operation', 'changed_hold', 'hidden_wire', 'missing_cancel', 'late_cancel', 'wrong_request', 'extra_repair'])(
    'rejects late-work%s evidence and never restarts to manufacture terminal completion', async fault => {
      const env = orchestrationHarness(); const remote = env.transport.remote;
      if (fault === 'used_scope') env.ledgers.set('diagnosis', { purpose: 'diagnosis', versionRecognized: true,
        stateSha256: 'f'.repeat(64), inFlight: false, attemptCount: 1 });
      env.transport.remote = async (role, argv) => {
        const receipt = await remote(role, argv); const value = receipt.observation;
        if (fault === 'queued_fault' && argv[0] === 'provider' && argv[1] === 'inspect') value.nextFault = { kind: 'hold' };
        if (fault === 'running_operation' && role === 'web' && argv[0] === 'inspect') value.consumerRun = { status: 'running' };
        if (role === 'worker' && argv[1] === 'containment_cancel' && value?.containment?.run?.operation === 'diagnosis') {
          if (fault === 'missing_cancel') value.receipts = [];
          if (fault === 'late_cancel') value.receipts.filter(item => item.event === 'command:containment_cancel')
            .forEach(item => { item.at = new Date(env.now() + 26_000).toISOString(); });
        }
        const completed = value?.receipts?.find(item => item.outcome === 'synthetic_work_completed_after_client_close');
        if (completed) {
          if (fault === 'changed_hold') env.ledgers.get('diagnosis').stateSha256 = 'f'.repeat(64);
          if (fault === 'hidden_wire') value.providerWireRequests += 1;
          if (fault === 'wrong_request') completed.requestId = 'unrelated-request';
        }
        if (fault === 'extra_repair' && value?.containment?.run?.status === 'failed') value.containment.counters.repairAttempts += 1;
        return receipt;
      };
      const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
      expect(['FAILED', 'BLOCKED']).toContain(result.classification);
      expect(env.calls.some(call => call[0] === 'restart')).toBe(false);
      if (fault === 'used_scope') expect(env.calls).not.toContainEqual(['worker', 'provider', 'inference_late_completion_next']);
    });
  it('rejects a paid request during Worker startup before taking the new provider baseline', async () => {
    const env = orchestrationHarness(); const remote = env.transport.remote; const restart = env.transport.restart;
    let restarted = false;
    env.transport.restart = async () => { const result = await restart(); restarted = true; return result; };
    env.transport.remote = async (role, argv) => {
      const receipt = await remote(role, argv);
      if (restarted && role === 'worker' && argv[0] === 'provider') {
        receipt.observation.receipts.push({ endpoint: 'responses', requestId: 'test-unexpected-startup-request' });
        receipt.observation.providerRequests += 1; receipt.observation.providerWireRequests += 1;
      }
      return receipt;
    };
    const result = await runSelfHealInferenceAcceptanceCase('late_completion', manifest(), env);
    expect(result).toMatchObject({ classification: 'FAILED', errorCode: 'SELF_HEAL_ACCEPTANCE_INFERENCE_LATE_WORK_RESTART_PROVIDER_REQUEST' });
  });
});

describe('late synthetic completion receipt ordering', () => {
  const evidence = () => ({ request: { requestId: 'test-late-request', endpoint: 'responses', purpose: 'predictive-decision',
    credential: 'rotated', fault: 'late_completion', providerWorkKind: 'bounded_synthetic_completion',
    outcome: 'synthetic_work_completed_after_client_close', responseDelivered: false, providerWorkCancelledAt: null,
    maxOutputTokens: 512, startedAt: NOW, providerWorkStartedAt: NOW, providerWorkDeadlineAt: NOW + 40_000,
    clientClosedAt: NOW + 6000, providerWorkCompletedAt: NOW + 40_000, endedAt: NOW + 40_000 },
  run: { status: 'failed', inferenceAuthorization: 'manual', executionAuthorized: false,
    startedAt: new Date(NOW - 100).toISOString(), completedAt: new Date(NOW + 5000).toISOString() },
  cancellationAt: NOW + 4000, overlappingAt: NOW + 10_000 });
  it('allows the client-close and operation-completion callbacks in either order', () => {
    for (const completedAt of [NOW + 5000, NOW + 7000]) {
      const value = evidence(); value.run.completedAt = new Date(completedAt).toISOString();
      value.request.endedAt += 1;
      expect(attestSelfHealInferenceLateCompletion(value.request, value.run, value.cancellationAt, value.overlappingAt))
        .toMatchObject({ responseDelivered: false, workEvidence: 'bounded_synthetic_completion_after_client_cancellation' });
    }
  });
  it.each([
    value => { value.request.responseDelivered = true; },
    value => { value.request.providerWorkCancelledAt = NOW + 40_000; },
    value => { value.request.providerWorkCompletedAt = NOW + 39_999; },
    value => { value.request.providerWorkDeadlineAt = NOW + 30_000; },
    value => { value.request.clientClosedAt = NOW + 30_000; },
    value => { value.request.clientClosedAt = NOW + 11_900; },
    value => { value.request.clientClosedAt = NOW + 3000; },
    value => { value.cancellationAt = NOW + 26_000; value.request.clientClosedAt = NOW + 27_000;
      value.run.completedAt = new Date(NOW + 28_000).toISOString(); value.overlappingAt = NOW + 29_000; },
    value => { value.run.completedAt = new Date(NOW + 40_001).toISOString(); },
    value => { value.run.executionAuthorized = true; },
    value => { value.run.audit = { attempted: true }; },
    value => { value.overlappingAt = NOW + 40_000; },
    value => { value.request.outcome = 'synthetic_work_cancelled'; },
  ])('rejects invalid or ambiguous late-work proof %#', mutate => {
    const value = evidence(); mutate(value);
    expect(() => attestSelfHealInferenceLateCompletion(value.request, value.run, value.cancellationAt, value.overlappingAt)).toThrow();
  });
});

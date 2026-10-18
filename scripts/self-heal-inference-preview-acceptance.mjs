#!/usr/bin/env node
/** Fixed PR1557 cases over the existing receipt-bound Railway transport. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  createSelfHealAcceptanceTransport, isRealSelfHealAcceptanceTransport,
  publishSelfHealAcceptanceReceipt, sanitizeSelfHealAcceptanceEvidence,
  SelfHealAcceptanceError, validateSelfHealAcceptanceManifest,
} from './self-heal-preview-acceptance.mjs';

export const SELF_HEAL_INFERENCE_ACCEPTANCE_CASES = Object.freeze([
  'idle_off', 'idle_on', 'running_off', 'running_on', 'diagnosis_once',
  'probe_rotation', 'metadata_recovery', 'uncertain_restart', 'late_completion',
]);
const CLEANUP_RESERVE_MS = 10 * 60_000;
// Ordinary empty-queue polling can sleep thirty seconds; leave fifteen seconds for observation transport.
const WORKER_CLAIM_OBSERVATION_MS = 45_000;
// The fixed predictive path uses Trinity's direct-answer stage, whose deadline precedes the 30-second SDK cap.
const PREDICTIVE_CORE_DEADLINE_MS = 12_000;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inspection = receipt => receipt?.observation?.inspection ?? receipt?.observation;
const fail = (code, classification = 'FAILED') => { throw new SelfHealAcceptanceError(`INFERENCE_${code}`, classification); };
const requireProof = (condition, code) => { if (!condition) fail(code); };
const block = code => fail(code, 'BLOCKED');
const paid = fixture => fixture.receipts.filter(receipt => receipt.endpoint !== 'models');
const sameWireCount = (before, after) => Number.isSafeInteger(before?.providerWireRequests)
  && after?.providerWireRequests === before.providerWireRequests;
const ledger = (state, purpose) => state.containment.ledgers?.find(value => value.purpose === purpose);
const idleWorkersAged = state => state?.containment?.health?.workers?.filter(worker => !worker.busy)
  .every(worker => Number.isFinite(worker.inactivityMs) && Number.isFinite(worker.idleThresholdMs)
    && worker.idleThresholdMs > 0 && worker.inactivityMs >= worker.idleThresholdMs) === true;

/** Local controller bytes must be the same clean, canonical commit as the hosted source. */
export async function attestSelfHealInferenceController(manifest, options = {}) {
  const command = options.command ?? promisify(execFile);
  const read = async argv => {
    const result = await command('git', argv, { cwd: ROOT, timeout: 10_000,
      maxBuffer: 65_536, windowsHide: true, encoding: 'utf8' });
    if (typeof result?.stdout !== 'string') block('CONTROLLER_ATTESTATION_UNAVAILABLE');
    return result.stdout.trim();
  };
  const head = await read(['rev-parse', 'HEAD']);
  const origin = await read(['config', '--get', 'remote.origin.url']);
  const changes = await read(['status', '--porcelain', '--untracked-files=normal']);
  if (head !== manifest.controllerSha || head !== manifest.receipt.sourceSha || changes !== ''
    || !['https://github.com/pbjustin/Arcanos.git', 'https://github.com/pbjustin/Arcanos',
      'git@github.com:pbjustin/Arcanos.git', 'ssh://git@github.com/pbjustin/Arcanos.git'].includes(origin)) block('CONTROLLER_SOURCE_DRIFT');
  return { sourceSha: head, controllerSha: head, repository: 'pbjustin/Arcanos', clean: true };
}

function attestFleet(state, running) {
  const health = state?.containment?.health;
  requireProof(state?.containment?.evidence === 'production_health_telemetry_and_redis'
    && state.containment.counters.complete === true && health?.unexpectedWorkerCount === 0
    && health.workers?.length === 8 && new Set(health.workers.map(worker => worker.slot)).size === 8
    && health.workers.every(worker => Number.isInteger(worker.slot) && worker.slot >= 1 && worker.slot <= 8
      && worker.operationalStatus === 'healthy' && worker.stale === false
      && worker.watchdogTriggered === false && worker.restartRecommended === false)
    && health.queue?.pending === 0 && health.queue.stalledRunning === 0
    && health.queue.running === (running ? 1 : 0)
    && health.workers.filter(worker => worker.busy).length === (running ? 1 : 0), 'HEALTHY_FLEET_NOT_PROVEN');
  requireProof(idleWorkersAged(state), 'IDLE_INACTIVITY_THRESHOLD_NOT_REACHED');
}

function attestQuietPolicy(state, predictiveEnabled, scheduled = false) {
  requireProof(state.policy?.selfImproveEnabled === true && state.policy.actuatorMode === 'daemon'
    && state.policy.autonomyLevel === 3 && state.policy.frozen === false
    && state.policy.killSwitch?.frozen === false && state.policy.killSwitch.autonomyLevel >= 3
    && state.policy.predictiveEnabled === predictiveEnabled && state.policy.predictiveDryRun === false
    && state.policy.predictiveAutoExecute === false, 'QUIET_POLICY_NOT_PROVEN');
  if (scheduled) requireProof(state.coordinator?.loopRunning === true && state.scheduler?.intervalMs === 30_000,
    'ORDINARY_SCHEDULER_NOT_PROVEN');
}

/** Every successful tick case needs eight healthy owned slots and uninterrupted counters. */
export function attestSelfHealInferenceQuietWindow(before, after, beforeProvider, afterProvider, options = {}) {
  const running = options.running === true;
  for (const state of [before, after]) attestFleet(state, running);
  if (typeof options.predictiveEnabled === 'boolean') {
    for (const state of [before, after]) attestQuietPolicy(state, options.predictiveEnabled, options.scheduled);
  }
  requireProof(before.processInstanceId === after.processInstanceId, 'PROCESS_CHANGED');
  const first = before.containment.counters; const last = after.containment.counters;
  for (const field of ['incidentEvaluations', 'providerAttempts', 'repairAttempts', 'actionsExecuted']) {
    requireProof(Number.isSafeInteger(first[field]) && last[field] === first[field], 'QUIET_WINDOW_EFFECT');
  }
  requireProof(last.evaluations - first.evaluations >= 20 && last.healthyEvaluations - first.healthyEvaluations >= 20,
    'TWENTY_HEALTHY_EVALUATIONS_NOT_PROVEN');
  if (options.scheduled === true) requireProof(after.scheduler.callbacks - before.scheduler.callbacks >= 20,
    'TWENTY_SCHEDULED_CALLBACKS_NOT_PROVEN');
  requireProof(Number.isSafeInteger(beforeProvider.providerRequests)
    && afterProvider.providerRequests === beforeProvider.providerRequests
    && sameWireCount(beforeProvider, afterProvider)
    && paid(afterProvider).length === paid(beforeProvider).length, 'UNEXPECTED_PROVIDER_REQUEST');
  return { evaluations: last.evaluations - first.evaluations,
    scheduledCallbacks: after.scheduler.callbacks - before.scheduler.callbacks,
    providerRequests: 0, inferenceRequests: 0, repairAttempts: 0, degradationIncidents: 0,
    timingEvidence: options.scheduled ? 'actual_thirty_second_scheduler' : 'twenty_serial_production_evaluations',
    busySlots: running ? 1 : 0, idleSlots: running ? 7 : 8 };
}

/** A genuine incident can still be diagnosed by rules without authorizing a provider attempt. */
function attestDisabledInference(before, after) {
  const run = after.containment?.run; const audit = run?.audit;
  for (const value of [before, after]) {
    requireProof(value.containment?.health?.queue?.pending === 1
      && value.containment.health.workers.some(worker => worker.claimAcceptance === 'dependency_failure')
      && value.containment.counters.complete === true, 'DISABLED_INFERENCE_INCIDENT_NOT_PROVEN');
    attestQuietPolicy(value, true);
  }
  requireProof(before.processInstanceId === after.processInstanceId && run?.processInstanceId === after.processInstanceId
    && run.status === 'completed' && run.inferenceAuthorization === 'disabled' && run.executionAuthorized === false
    && audit?.source === 'self-heal.preview.measured-runtime' && audit.advisor === 'rules_fallback_v1'
    && audit.inferenceReason === 'inference_not_requested' && audit.selectedAction && audit.selectedAction !== 'none'
    && audit.attempted === false && audit.mode === 'recommend_only'
    && audit.featureFlags?.enabled === true && audit.featureFlags.dryRun === false && audit.featureFlags.autoExecute === false,
  'DISABLED_INFERENCE_DENIAL_NOT_PROVEN');
  for (const field of ['providerAttempts', 'repairAttempts', 'actionsExecuted']) {
    requireProof(Number.isSafeInteger(before.containment.counters[field])
      && after.containment.counters[field] === before.containment.counters[field], 'DISABLED_INFERENCE_EFFECT');
  }
  for (const purpose of ['diagnosis', 'provider_probe']) {
    const first = ledger(before, purpose); const last = ledger(after, purpose);
    requireProof(first?.versionRecognized === true && last?.versionRecognized === true
      && Number.isSafeInteger(first.attemptCount) && first.attemptCount >= 0
      && (first.present === false ? first.stateSha256 === null && first.ttlMs === -2
        : first.present === true && /^[a-f0-9]{64}$/u.test(first.stateSha256) && first.ttlMs === -1)
      && hash(first) === hash(last), 'DISABLED_INFERENCE_LEDGER_CHANGED');
  }
}

/** Retained failure history must not override a strictly newer successful probe. */
function attestRecoveredProviderHistory(failed, recovered) {
  const first = failed.containment?.providerHealth; const last = recovered.containment?.providerHealth;
  requireProof(first?.evidence === 'production_merged_provider_health'
    && last?.evidence === 'production_merged_provider_health'
    && Number.isFinite(Date.parse(first.lastFailureAt)) && first.lastFailureCategory !== null
    && first.completionHealthy === false && last.lastFailureAt === first.lastFailureAt
    && Date.parse(last.lastSuccessAt) > Date.parse(first.lastFailureAt)
    && Date.parse(last.lastAttemptAt) > Date.parse(first.lastFailureAt)
    && (first.lastAttemptAt === null || Date.parse(last.lastAttemptAt) >= Date.parse(first.lastAttemptAt))
    && Date.parse(last.lastSuccessAt) >= Date.parse(last.lastAttemptAt)
    && last.lastFailureCategory === null && last.lastFailureStatus === null
    && last.reachable === true && last.authenticated === true && last.completionHealthy === true,
  'RECOVERED_PROVIDER_HISTORY_NOT_PROVEN');
  return last;
}

/** Prove finite provider work finished after operator cancellation without claiming delivery or billing. */
export function attestSelfHealInferenceLateCompletion(request, run, cancellationAt, overlappingAt) {
  const runStartedAt = Date.parse(run?.startedAt);
  const completedAt = Date.parse(run?.completedAt);
  requireProof(request?.endpoint === 'responses' && request.purpose === 'predictive-decision'
    && request.credential === 'rotated' && request.fault === 'late_completion'
    && request.providerWorkKind === 'bounded_synthetic_completion'
    && request.outcome === 'synthetic_work_completed_after_client_close'
    && request.responseDelivered === false && request.providerWorkCancelledAt === null
    && Number.isInteger(request.maxOutputTokens) && request.maxOutputTokens > 0 && request.maxOutputTokens <= 512,
  'LATE_WORK_TERMINAL_RECEIPT_INVALID');
  for (const value of [request.startedAt, request.providerWorkStartedAt, request.providerWorkDeadlineAt,
    request.clientClosedAt, request.providerWorkCompletedAt, request.endedAt, cancellationAt, runStartedAt, completedAt, overlappingAt]) {
    requireProof(Number.isSafeInteger(value), 'LATE_WORK_TIMESTAMPS_INVALID');
  }
  requireProof(request.startedAt <= request.providerWorkStartedAt
    && request.providerWorkDeadlineAt === request.providerWorkStartedAt + 40_000
    && request.providerWorkStartedAt <= cancellationAt && cancellationAt <= request.clientClosedAt
    && cancellationAt <= completedAt && request.clientClosedAt < request.providerWorkCompletedAt
    && completedAt < request.providerWorkCompletedAt && request.providerWorkCompletedAt >= request.providerWorkDeadlineAt
    && request.endedAt >= request.providerWorkCompletedAt
    && overlappingAt >= cancellationAt && overlappingAt < request.providerWorkCompletedAt, 'LATE_WORK_ORDER_NOT_PROVEN');
  // Run entry is earlier than stage dispatch, so this conservatively excludes Core's automatic timeout.
  if (cancellationAt >= runStartedAt + PREDICTIVE_CORE_DEADLINE_MS
    || request.clientClosedAt >= runStartedAt + PREDICTIVE_CORE_DEADLINE_MS) block('EARLY_OPERATOR_CANCELLATION_NOT_PROVEN');
  requireProof(['completed', 'failed'].includes(run?.status) && run.inferenceAuthorization === 'manual'
    && run.executionAuthorized === false && (!run.audit || run.audit.attempted === false), 'LATE_WORK_EXECUTION_NOT_CONTAINED');
  return { requestId: request.requestId, providerWorkStartedAt: request.providerWorkStartedAt,
    cancellationAt, clientClosedAt: request.clientClosedAt, containmentRunCompletedAt: completedAt,
    providerWorkCompletedAt: request.providerWorkCompletedAt, responseDelivered: false,
    workEvidence: 'bounded_synthetic_completion_after_client_cancellation', maxOutputTokens: request.maxOutputTokens };
}

/** No scenario resets a budget, rejection history or unresolved reservation. */
export async function runSelfHealInferenceAcceptanceCase(scenario, manifest, options = {}) {
  if (!SELF_HEAL_INFERENCE_ACCEPTANCE_CASES.includes(scenario)) block('SCENARIO_INVALID');
  manifest = validateSelfHealAcceptanceManifest(manifest, options);
  if (manifest.receipt.prNumber !== 1557) block('PROFILE_MISMATCH');
  if (options.execute !== true && options.allowNetwork !== true) return { scenario, classification: 'NOT_RUN',
    executed: false, sourceSha: manifest.receipt.sourceSha };
  if (options.execute !== true || options.allowNetwork !== true) block('NETWORK_GATES_REQUIRED');
  const now = options.now ?? Date.now; const wait = options.sleep ?? sleep;
  const transport = options.transport ?? createSelfHealAcceptanceTransport(manifest, options);
  const real = isRealSelfHealAcceptanceTransport(transport, manifest) && !options.now && !options.sleep;
  const events = []; let sequence = 0; let classification = 'BLOCKED'; let errorCode = null;
  let proof = null; let restoration = 'NOT_RUN'; let webTouched = false;
  const emit = async (kind, value) => {
    const event = sanitizeSelfHealAcceptanceEvidence({ scenario, sequence: ++sequence,
      observedAt: new Date(now()).toISOString(), kind, value });
    await options.onReceipt?.(event);
    events.push({ sequence: event.sequence, observedAt: event.observedAt, kind, receiptSha256: hash(event) });
    return value;
  };
  const remote = async (role, argv) => emit('operation', { role, argv, receipt: await transport.remote(role, argv) }).then(value => value.receipt);
  const inspect = async (role = 'worker') => inspection(await remote(role, ['inspect']));
  const provider = async (role = 'worker') => inspection(await remote(role, ['provider', 'inspect']));
  const command = async (name, role = 'worker') => {
    // Remember mutation intent even if transport or receipt publication fails after application.
    if (role === 'web') webTouched = true;
    const receipt = await remote(role, ['command', name]);
    if (receipt?.observation?.rejected === true) block('COMMAND_REJECTED');
    return inspection(receipt);
  };
  const poll = async (read, predicate, timeoutMs, intervalMs = 1000, transient = false) => {
    const deadline = Math.min(now() + timeoutMs, Date.parse(manifest.receipt.expiresAt) - CLEANUP_RESERVE_MS);
    for (let attempt = 0; attempt < 800 && now() < deadline; attempt += 1) {
      try { const result = await read(); if (predicate(result)) return result; }
      catch (error) {
        if (!transient || !(error instanceof SelfHealAcceptanceError)
          || !['SELF_HEAL_ACCEPTANCE_TARGET_NOT_RUNNING', 'SELF_HEAL_ACCEPTANCE_TRANSPORT_UNAVAILABLE'].includes(error.message)) throw error;
      }
      await wait(Math.min(intervalMs, Math.max(1, deadline - now())));
    }
    block('OBSERVATION_NOT_ESTABLISHED');
  };
  const operation = async (name, role = 'worker') => {
    const initial = await command(name, role); const startedAt = initial?.containment?.run?.startedAt;
    const expected = { containment_diagnose: 'diagnosis', containment_diagnose_no_ai: 'diagnosis',
      containment_probe: 'provider_probe', containment_tick_batch: 'tick_batch' }[name];
    if (!startedAt || !expected || initial.containment.run.operation !== expected) block('OPERATION_NOT_STARTED');
    if (['completed', 'failed'].includes(initial.containment.run.status)) return initial;
    return poll(() => inspect(role), value => value.containment?.run?.startedAt === startedAt
      && value.containment.run.operation === expected
      && ['completed', 'failed'].includes(value.containment.run.status), 45_000);
  };
  const armDependency = async processInstanceId => {
    const armed = await command('containment_dependency_failure');
    const arm = armed.receipts?.findLast(value => value.event === 'command:containment_dependency_failure');
    const armedAt = Date.parse(arm?.at); const expiresAt = Date.parse(armed.claimBoundary?.faultUntil);
    const observedAt = Date.parse(armed.policy?.observedAt);
    if (typeof processInstanceId !== 'string' || processInstanceId.length === 0
      || armed.processInstanceId !== processInstanceId || armed.claimBoundary?.evidence !== 'actual_worker_before_claim_hook'
      || !Number.isSafeInteger(armed.claimBoundary.faultRemaining) || armed.claimBoundary.faultRemaining <= 0 || armed.claimBoundary.faultRemaining > 64
      || !Number.isFinite(armedAt) || !Number.isFinite(expiresAt) || expiresAt <= armedAt
      || !Number.isFinite(observedAt) || observedAt < armedAt || observedAt >= expiresAt) block('DEPENDENCY_ARM_NOT_PROVEN');
    return { armed, armedAt, expiresAt };
  };
  const dependency = async () => {
    const before = await inspect();
    if (before.claimBoundary?.evidence !== 'actual_worker_before_claim_hook'
      || !Number.isSafeInteger(before.claimBoundary.attempts) || before.claimBoundary.attempts < 0
      || !Number.isSafeInteger(before.claimBoundary.injectedFailures) || before.claimBoundary.injectedFailures < 0) block('DEPENDENCY_ARM_NOT_PROVEN');
    const { armed, armedAt, expiresAt } = await armDependency(before.processInstanceId);
    const observed = value => {
      const boundary = value.claimBoundary; const failureAt = Date.parse(boundary?.lastInjectedFailureAt);
      const observedAt = Date.parse(value.policy?.observedAt);
      return value.processInstanceId === before.processInstanceId
        && boundary?.evidence === 'actual_worker_before_claim_hook'
        && boundary.faultUntil === armed.claimBoundary.faultUntil && boundary.faultRemaining > 0 && boundary.faultRemaining < 64
        && Number.isSafeInteger(boundary.attempts) && boundary.attempts > before.claimBoundary.attempts
        && Number.isSafeInteger(boundary.injectedFailures) && boundary.injectedFailures > before.claimBoundary.injectedFailures
        && Number.isFinite(failureAt) && failureAt >= armedAt && failureAt < expiresAt
        && Number.isFinite(observedAt) && observedAt >= failureAt && observedAt < expiresAt
        && value.containment?.health?.workers?.some(worker => worker.claimAcceptance === 'dependency_failure');
    };
    if (observed(armed)) return armed;
    return poll(inspect, observed, WORKER_CLAIM_OBSERVATION_MS);
  };
  const stopped = async () => {
    await command('coordinator_stop'); await command('policy_disabled');
    return poll(inspect, value => !value.coordinator.inFlight && value.coordinator.loopRunning === false, 40_000);
  };
  const naturallyAgedIdle = async () => poll(inspect, value => value.containment?.health?.workers?.length === 8
    && value.containment.health.workers.every(worker => !worker.busy) && idleWorkersAged(value)
    && value.containment.health.queue?.pending === 0 && value.containment.health.queue.running === 0, 5 * 60_000, 15_000);
  // Refuse an untrusted local controller before entering any restoration path.
  if (real) await emit('controller', await attestSelfHealInferenceController(manifest));
  try {
    await transport.targets();
    await remote('worker', ['artifact']); await remote('web', ['artifact']);
    if (scenario.startsWith('idle_')) {
      if (Date.parse(manifest.receipt.expiresAt) - now() < 5 * 60_000 + 22 * 30_000 + CLEANUP_RESERVE_MS) block('INSUFFICIENT_LEASE_FOR_SCHEDULED_TICKS');
      await naturallyAgedIdle();
      await command(scenario === 'idle_on' ? 'containment_predictive_on' : 'containment_predictive_off');
      await command('coordinator_start');
      const before = await poll(inspect, value => !value.coordinator.inFlight && value.ready === true, 35_000);
      attestFleet(before, false);
      attestQuietPolicy(before, scenario === 'idle_on', true);
      const beforeProvider = await provider(); const beforeWebProvider = await provider('web');
      await emit('baseline', before);
      const after = await poll(inspect, value => {
        attestFleet(value, false);
        attestQuietPolicy(value, scenario === 'idle_on', true);
        const counters = value.containment?.counters;
        if (!counters || !counters.complete) block('TELEMETRY_GAP');
        for (const field of ['incidentEvaluations', 'providerAttempts', 'repairAttempts', 'actionsExecuted']) {
          requireProof(counters[field] === before.containment.counters[field], 'QUIET_WINDOW_EFFECT');
        }
        return value.scheduler.callbacks - before.scheduler.callbacks >= 20
          && counters.evaluations - before.containment.counters.evaluations >= 20 && !value.coordinator.inFlight;
      }, 22 * 30_000, 15_000);
      proof = attestSelfHealInferenceQuietWindow(before, after, beforeProvider, await provider(), { scheduled: true, predictiveEnabled: scenario === 'idle_on' });
      requireProof(sameWireCount(beforeWebProvider, await provider('web')), 'UNEXPECTED_WEB_PROVIDER_REQUEST');
    } else if (scenario.startsWith('running_')) {
      await stopped();
      await naturallyAgedIdle();
      await command(scenario === 'running_on' ? 'containment_predictive_on' : 'containment_predictive_off');
      const slot = scenario === 'running_on' ? 'I02' : 'I01';
      const absent = await remote('worker', ['fenced-job', 'inspect', slot, '1']);
      if (absent.fencedJob?.job !== null) block('RUNNING_JOB_ALREADY_USED');
      await remote('worker', ['provider', 'inference_hold_next']);
      await remote('worker', ['fenced-job', 'create', slot, '1']);
      const before = await poll(inspect, value => value.containment?.health?.queue?.running === 1
        && value.containment.health.queue.pending === 0 && value.containment.health.workers.filter(worker => worker.busy).length === 1, WORKER_CLAIM_OBSERVATION_MS, 250);
      const [beforeProvider, beforeWebProvider] = await Promise.all([provider(), provider('web')]);
      requireProof(beforeProvider.inFlight !== null && paid(beforeProvider).at(-1)?.fault === 'hold', 'RUNNING_PROVIDER_NOT_HELD');
      await emit('baseline', before);
      const after = await operation('containment_tick_batch');
      requireProof(after.containment.run.status === 'completed' && after.containment.run.ticksCompleted === 20, 'TICK_BATCH_INCOMPLETE');
      // Capture all twenty evaluations while the job is busy, then release within the existing provider deadline.
      const afterProvider = inspection(await remote('worker', ['provider', 'release']));
      const terminal = afterProvider.receipts?.find(receipt => receipt.requestId === beforeProvider.inFlight);
      requireProof(afterProvider.inFlight === null && terminal?.outcome === 'completed'
        && Number.isFinite(terminal.endedAt), 'RUNNING_PROVIDER_COMPLETION_NOT_PROVEN');
      const observedAt = after.policy?.observedAt ?? after.containment.run.completedAt;
      if (observedAt !== undefined) requireProof(Number.isFinite(Date.parse(observedAt))
        && Date.parse(observedAt) <= terminal.endedAt, 'RUNNING_OBSERVATION_AFTER_PROVIDER_COMPLETION');
      proof = attestSelfHealInferenceQuietWindow(before, after, beforeProvider, afterProvider, { running: true, predictiveEnabled: scenario === 'running_on' });
      requireProof(sameWireCount(beforeWebProvider, await provider('web')), 'UNEXPECTED_WEB_PROVIDER_REQUEST');
      const completed = await poll(() => remote('worker', ['fenced-job', 'inspect', slot, '1']), value => value.fencedJob?.job?.completionVerified === true, 60_000);
      requireProof(completed.fencedJob.job.matchingClaimEvents === 1 && completed.fencedJob.job.matchingCompletionEvents === 1, 'ORDINARY_JOB_COMPLETION_NOT_PROVEN');
      proof.ordinaryJobCompletedOnce = true;
    } else if (scenario === 'diagnosis_once') {
      await stopped(); await command('containment_predictive_on');
      await command('policy_predictive_no_execute', 'web');
      const beforeProvider = await provider(); const beforeWeb = await provider('web');
      const absent = await remote('worker', ['fenced-job', 'inspect', 'I03', '1']);
      if (absent.fencedJob?.job !== null) block('DIAGNOSIS_PENDING_JOB_ALREADY_USED');
      const initialDependency = await dependency();
      // The first observation can arrive near expiry; arm a fresh bounded window before creating pending work.
      await armDependency(initialDependency.processInstanceId);
      await remote('worker', ['fenced-job', 'create', 'I03', '1']);
      await dependency();
      const beforeDisabled = await poll(inspect, value => value.containment.health.queue?.pending === 1, 10_000);
      const disabled = await operation('containment_diagnose_no_ai');
      attestDisabledInference(beforeDisabled, disabled);
      const [afterDisabledProvider, afterDisabledWeb] = await Promise.all([provider(), provider('web')]);
      requireProof(sameWireCount(beforeProvider, afterDisabledProvider) && sameWireCount(beforeWeb, afterDisabledWeb),
        'DISABLED_INFERENCE_PROVIDER_REQUEST');
      // Refresh before the paid request starts; leave the twelve-second Core window for overlap and release.
      const refreshed = await command('containment_dependency_failure');
      requireProof(refreshed.containment.health.queue?.pending === 1
        && refreshed.containment.health.workers.some(worker => worker.claimAcceptance === 'dependency_failure'), 'OVERLAPPING_INCIDENT_NOT_PROVEN');
      await remote('worker', ['provider', 'inference_hold_next']);
      const started = await command('containment_diagnose');
      const [heldProvider, held] = await Promise.all([
        poll(provider, value => value.inFlight !== null
          && paid(value).at(-1)?.fault === 'hold' && paid(value).at(-1)?.purpose === 'predictive-decision', 15_000, 250),
        poll(inspect, value => ledger(value, 'diagnosis')?.inFlight === true, 15_000, 250),
      ]);
      const heldState = ledger(held, 'diagnosis');
      requireProof(heldState?.inFlight === true && heldState.ttlMs === -1, 'IN_FLIGHT_RESERVATION_NOT_PROVEN');
      requireProof(held.containment.health.queue?.pending === 1
        && held.containment.health.workers.some(worker => worker.claimAcceptance === 'dependency_failure'), 'OVERLAPPING_INCIDENT_NOT_PROVEN');
      const overlapping = await operation('containment_diagnose', 'web');
      requireProof(overlapping.containment.run?.audit?.advisor === 'rules_fallback_v1'
        && overlapping.containment.run.audit.inferenceReason === 'in_flight'
        && ledger(overlapping, 'diagnosis')?.stateSha256 === heldState.stateSha256, 'CONCURRENT_SHARED_DENIAL_NOT_PROVEN');
      await remote('worker', ['provider', 'release']);
      requireProof(sameWireCount(beforeWeb, await provider('web')), 'DUPLICATE_WEB_PROVIDER_REQUEST');
      const result = await poll(inspect, value => value.containment.run?.startedAt === started.containment.run?.startedAt
        && ['completed', 'failed'].includes(value.containment.run.status), 40_000);
      const audit = result.containment.run?.audit;
      if (audit?.advisor !== 'arcanos_core_v1') block('ELIGIBLE_DIAGNOSIS_NOT_ADMITTED');
      requireProof(audit.attempted === false && audit.mode === 'recommend_only', 'REPAIR_EXECUTION_NOT_CONTAINED');
      const afterProvider = await provider();
      const requests = paid(afterProvider).slice(paid(beforeProvider).length);
      requireProof(requests.length === 1 && requests[0].purpose === 'predictive-decision'
        && requests[0].requestId === heldProvider.inFlight && requests[0].outcome === 'completed'
        && requests[0].maxOutputTokens > 0 && requests[0].maxOutputTokens <= 512, 'BOUNDED_CORE_REQUEST_NOT_PROVEN');
      const overlappingAt = Date.parse(overlapping.containment.run.audit.timestamp);
      requireProof(Number.isFinite(overlappingAt) && Number.isFinite(requests[0].startedAt)
        && Number.isFinite(requests[0].endedAt) && requests[0].startedAt <= overlappingAt
        && overlappingAt <= requests[0].endedAt, 'CONCURRENT_PROVIDER_WINDOW_NOT_PROVEN');
      // Refresh the bounded real claim failure while a different process reads the same ledger.
      await dependency();
      await poll(inspect, value => value.containment.health.queue?.pending === 1, 10_000);
      const denied = await operation('containment_diagnose', 'web');
      requireProof(denied.containment.run?.audit?.advisor === 'rules_fallback_v1'
        && denied.containment.run.audit.inferenceReason === 'active_incident_backoff', 'SHARED_DIAGNOSIS_DENIAL_NOT_PROVEN');
      requireProof(sameWireCount(beforeWeb, await provider('web')), 'DUPLICATE_WEB_PROVIDER_REQUEST');
      const state = ledger(result, 'diagnosis'); const otherState = ledger(denied, 'diagnosis');
      requireProof(state?.versionRecognized === true && state.inFlight === false && state.stateSha256 === otherState?.stateSha256, 'SHARED_LEDGER_NOT_PROVEN');
      await command('containment_dependency_restore');
      const completed = await poll(() => remote('worker', ['fenced-job', 'inspect', 'I03', '1']), value => value.fencedJob?.job?.completionVerified === true, 60_000);
      requireProof(completed.fencedJob.job.literalObserved === true && completed.fencedJob.job.matchingClaimEvents === 1,
        'PENDING_JOB_RECOVERY_NOT_PROVEN');
      proof = { diagnosisDetected: true, inferenceRequests: 1, maxOutputTokens: requests[0].maxOutputTokens,
        model: requests[0].model, advisor: audit.advisor, executionAuthorized: false,
        crossProcessDenied: true, crossProcessEvidence: 'overlapping_in_flight_and_sequential_cooldown_denials',
        concurrentReservationDenialProven: true, pendingJobRecovered: true,
        explicitDisabledInferenceDenied: true, disabledInferenceProviderRequests: 0, disabledInferenceLedgerUnchanged: true,
        faultEvidence: 'bounded_actual_worker_claim_dependency_failure_with_owned_pending_job' };
    } else if (scenario === 'probe_rotation' || scenario === 'metadata_recovery') {
      await stopped();
      const beforeProvider = await provider(); const beforeWeb = await provider('web');
      await remote('worker', ['provider', scenario === 'probe_rotation' ? 'models_auth_failure_next' : 'models_timeout_next']);
      const failed = await operation('containment_probe');
      const failure = failed.containment.run?.provider;
      if (scenario === 'probe_rotation' ? failure?.failureStatus !== 401 : !['timeout', 'transient'].includes(failure?.failureCategory)) block('FIRST_PROBE_NOT_ADMITTED');
      const failedProvider = await provider();
      requireProof(paid(failedProvider).length === paid(beforeProvider).length, 'METADATA_FAILURE_SPENT_INFERENCE');
      const state = ledger(failed, 'provider_probe');
      requireProof(state?.versionRecognized === true && state.inFlight === false && Number.isFinite(state.lastCompletedMs), 'METADATA_RESERVATION_NOT_SETTLED');
      if (scenario === 'probe_rotation') requireProof(state.rejectedCredentialCount >= 1, 'REVOKED_IDENTITY_NOT_RETAINED');
      const denied = await operation('containment_probe', 'web');
      requireProof(['authentication_blocked', 'cooldown', 'provider_authentication_or_circuit_blocked'].includes(denied.containment.run?.provider?.failureReason), 'CROSS_PROCESS_PROBE_DENIAL_NOT_PROVEN');
      requireProof(sameWireCount(beforeWeb, await provider('web')), 'DUPLICATE_WEB_PROVIDER_REQUEST');
      const retryAt = state.lastCompletedMs + 60_001;
      if (retryAt >= Date.parse(manifest.receipt.expiresAt) - CLEANUP_RESERVE_MS) block('INSUFFICIENT_LEASE_FOR_PROBE_COOLDOWN');
      while (now() < retryAt) await wait(Math.min(30_000, retryAt - now()));
      if (scenario === 'probe_rotation') await command('containment_credential_rotate');
      const recovered = await operation('containment_probe');
      if (recovered.containment.run?.provider?.completionHealthy !== true) block('RECOVERY_PROBE_NOT_ADMITTED');
      const recoveredHealth = attestRecoveredProviderHistory(failed, recovered);
      const afterProvider = await provider(); const requests = paid(afterProvider).slice(paid(beforeProvider).length);
      requireProof(requests.length === 1 && requests[0].maxOutputTokens === 16
        && (scenario !== 'probe_rotation' || requests[0].credential === 'rotated'), 'BOUNDED_RECOVERY_PROBE_NOT_PROVEN');
      const probeLedger = ledger(recovered, 'provider_probe');
      requireProof(probeLedger?.attemptCount === 2 && probeLedger.inFlight === false, 'TWO_PROBE_BUDGET_NOT_PROVEN');
      const immediate = await operation('containment_probe');
      requireProof(['cooldown', 'budget_exhausted'].includes(immediate.containment.run?.provider?.failureReason), 'PROBE_RETRY_NOT_DENIED');
      requireProof(hash(immediate.containment?.providerHealth ?? null) === hash(recoveredHealth), 'DENIED_PROBE_CHANGED_PROVIDER_HEALTH');
      requireProof(sameWireCount(afterProvider, await provider()), 'RETRY_STORM');
      const budgetCheckAt = probeLedger.lastCompletedMs + 60_001;
      if (budgetCheckAt >= Date.parse(manifest.receipt.expiresAt) - CLEANUP_RESERVE_MS) block('INSUFFICIENT_LEASE_FOR_HOURLY_BUDGET_CHECK');
      while (now() < budgetCheckAt) await wait(Math.min(30_000, budgetCheckAt - now()));
      const exhausted = await operation('containment_probe');
      requireProof(exhausted.containment.run?.provider?.failureReason === 'budget_exhausted'
        && sameWireCount(afterProvider, await provider()), 'HOURLY_PROBE_BUDGET_NOT_PROVEN');
      requireProof(hash(exhausted.containment?.providerHealth ?? null) === hash(recoveredHealth), 'DENIED_PROBE_CHANGED_PROVIDER_HEALTH');
      proof = { unpaidFailureReleasedReservation: true, revokedIdentityRetained: scenario === 'probe_rotation',
        authorizedRecoverySucceeded: true, inferenceRequests: 1, probeAttempts: 2, hourlyBudgetDeniedAfterCooldown: true,
        maxOutputTokens: 16, crossProcessDenied: true, staleFailureSupersededByNewerSuccess: true,
        deniedProbesPreservedRecoveredHealth: true, providerHealth: recoveredHealth };
    } else if (scenario === 'late_completion') {
      if (Date.parse(manifest.receipt.expiresAt) - now() < CLEANUP_RESERVE_MS + 5 * 60_000) block('INSUFFICIENT_LEASE_FOR_LATE_WORK');
      await stopped(); await command('containment_predictive_on'); await command('containment_credential_rotate');
      await command('coordinator_stop', 'web'); await command('policy_predictive_no_execute', 'web');
      await command('containment_credential_rotate', 'web');
      const before = await inspect(); const beforeWebState = await inspect('web');
      const beforeProvider = await provider(); const beforeWeb = await provider('web');
      if (ledger(before, 'diagnosis')?.inFlight || ledger(before, 'diagnosis')?.attemptCount > 0) block('FRESH_DIAGNOSIS_SCOPE_REQUIRED');
      requireProof(before.containment.health.queue?.pending === 0 && before.containment.health.queue.running === 0
        && before.containment.health.queue.stalledRunning === 0 && beforeProvider.inFlight === null
        && beforeProvider.nextFault === null && beforeWeb.inFlight === null && beforeWeb.nextFault === null
        && [before, beforeWebState].every(state => state.containment.run?.status !== 'running'
          && state.consumerRun?.status !== 'running' && state.predictiveRun?.status !== 'running'
          && state.coordinator.loopRunning === false && state.coordinator.inFlight === false), 'LATE_WORK_BASELINE_NOT_IDLE');
      const noRepairs = (state, initial = before) => requireProof(initial.containment.counters.complete === true
        && state.containment.counters.complete === true
        && Number.isSafeInteger(initial.containment.counters.repairAttempts)
        && Number.isSafeInteger(initial.containment.counters.actionsExecuted)
        && state.containment.counters.repairAttempts === initial.containment.counters.repairAttempts
        && state.containment.counters.actionsExecuted === initial.containment.counters.actionsExecuted, 'LATE_WORK_REPAIR_EFFECT');
      const absent = await remote('worker', ['fenced-job', 'inspect', 'I03', '1']);
      if (absent.fencedJob?.job !== null) block('LATE_WORK_PENDING_JOB_ALREADY_USED');
      const initialDependency = await dependency();
      await armDependency(initialDependency.processInstanceId);
      await remote('worker', ['fenced-job', 'create', 'I03', '1']);
      await dependency(); await poll(inspect, value => value.containment.health.queue?.pending === 1, 10_000);
      await remote('worker', ['provider', 'inference_late_completion_next']);
      const started = await command('containment_diagnose');
      const startedAt = started.containment.run?.startedAt;
      requireProof(typeof startedAt === 'string' && started.containment.run?.operation === 'diagnosis'
        && started.containment.run.processInstanceId === before.processInstanceId, 'LATE_WORK_RUN_NOT_BOUND');
      const [heldProvider, held] = await Promise.all([
        poll(provider, value => value.inFlight !== null && paid(value).at(-1)?.fault === 'late_completion', 15_000, 250),
        poll(inspect, value => ledger(value, 'diagnosis')?.inFlight === true, 15_000, 250),
      ]);
      const requestId = heldProvider.inFlight; const heldState = ledger(held, 'diagnosis');
      requireProof(heldState?.versionRecognized === true && heldState.inFlight === true && heldState.ttlMs === -1
        && /^[0-9a-f]{64}$/u.test(heldState.stateSha256), 'LATE_WORK_RESERVATION_NOT_PROVEN');
      const receiptSequence = Math.max(0, ...(held.receipts ?? []).map(value => value.sequence));
      const cancelled = await command('containment_cancel');
      const cancelReceipt = cancelled.receipts?.find(value => value.sequence > receiptSequence && value.event === 'command:containment_cancel');
      const cancellationAt = Date.parse(cancelReceipt?.at);
      requireProof(Number.isFinite(cancellationAt), 'LATE_WORK_CANCELLATION_RECEIPT_MISSING');
      const ended = await poll(inspect, value => value.containment.run?.startedAt === startedAt
        && ['completed', 'failed'].includes(value.containment.run.status), 15_000, 250);
      requireProof(ended.processInstanceId === before.processInstanceId
        && ended.containment.run.processInstanceId === before.processInstanceId
        && ledger(ended, 'diagnosis')?.stateSha256 === heldState.stateSha256, 'LATE_WORK_HOLD_CHANGED');
      noRepairs(ended);
      const stillActive = await provider();
      requireProof(stillActive.inFlight === requestId && Number.isSafeInteger(paid(stillActive).at(-1)?.clientClosedAt),
        'LATE_WORK_AFTER_CLOSE_NOT_OBSERVED');
      const refreshed = await command('containment_dependency_failure');
      requireProof(refreshed.containment.health.queue?.pending === 1
        && refreshed.containment.health.workers.some(worker => worker.claimAcceptance === 'dependency_failure'), 'LATE_WORK_INCIDENT_NOT_LIVE');
      const overlapping = await operation('containment_diagnose', 'web');
      requireProof(overlapping.containment.run?.audit?.inferenceReason === 'in_flight'
        && overlapping.containment.run.audit.attempted === false
        && ledger(overlapping, 'diagnosis')?.stateSha256 === heldState.stateSha256, 'LATE_WORK_CROSS_PROCESS_HOLD_NOT_PROVEN');
      noRepairs(overlapping, beforeWebState);
      const workStartedAt = paid(heldProvider).find(receipt => receipt.requestId === requestId)?.providerWorkStartedAt;
      requireProof(Number.isSafeInteger(workStartedAt), 'LATE_WORK_START_NOT_PROVEN');
      const terminalProvider = await poll(provider, value => value.inFlight === null
        && value.receipts.some(receipt => receipt.requestId === requestId && Number.isSafeInteger(receipt.providerWorkCompletedAt)),
      Math.max(1, Math.min(45_000, workStartedAt + 45_000 - now())), 1000);
      const requests = paid(terminalProvider).slice(paid(beforeProvider).length);
      requireProof(requests.length === 1 && requests[0].requestId === requestId
        && requests[0].providerWorkStartedAt >= Date.parse(startedAt), 'LATE_WORK_SINGLE_REQUEST_NOT_PROVEN');
      const workProof = attestSelfHealInferenceLateCompletion(requests[0], ended.containment.run,
        cancellationAt, Date.parse(overlapping.containment.run.audit.timestamp));
      const terminal = await inspect(); noRepairs(terminal);
      requireProof(ledger(terminal, 'diagnosis')?.stateSha256 === heldState.stateSha256
        && ledger(terminal, 'diagnosis')?.inFlight === true && ledger(terminal, 'diagnosis')?.ttlMs === -1,
      'LATE_WORK_TERMINAL_HOLD_CHANGED');
      requireProof(terminalProvider.providerWireRequests - beforeProvider.providerWireRequests
        === terminalProvider.providerRequests - beforeProvider.providerRequests
        && sameWireCount(beforeWeb, await provider('web')), 'LATE_WORK_HIDDEN_PROVIDER_REQUEST');
      await command('containment_dependency_restore');
      const completed = await poll(() => remote('worker', ['fenced-job', 'inspect', 'I03', '1']), value => value.fencedJob?.job?.completionVerified === true, 60_000);
      requireProof(completed.fencedJob.job.literalObserved === true && completed.fencedJob.job.matchingClaimEvents === 1
        && completed.fencedJob.job.matchingCompletionEvents === 1, 'LATE_WORK_PENDING_JOB_RECOVERY_NOT_PROVEN');
      // Restart only after the independent fixture proves terminal work, never to manufacture completion.
      await emit('restart', await transport.restart('worker'));
      const restarted = await poll(inspect, value => value.ready === true && value.processInstanceId !== before.processInstanceId, 120_000, 2000, true);
      requireProof(ledger(restarted, 'diagnosis')?.stateSha256 === heldState.stateSha256
        && ledger(restarted, 'diagnosis')?.inFlight === true && ledger(restarted, 'diagnosis')?.ttlMs === -1,
      'LATE_WORK_RESERVATION_LOST_ON_RESTART');
      await stopped(); await command('containment_predictive_on'); await command('containment_credential_rotate');
      await dependency(); const restartProvider = await provider();
      requireProof(paid(restartProvider).length === 0, 'LATE_WORK_RESTART_PROVIDER_REQUEST');
      const denied = await operation('containment_diagnose');
      requireProof(denied.containment.run?.audit?.inferenceReason === 'in_flight'
        && denied.containment.run.audit.attempted === false
        && ledger(denied, 'diagnosis')?.stateSha256 === heldState.stateSha256
        && ledger(denied, 'diagnosis')?.inFlight === true && ledger(denied, 'diagnosis')?.ttlMs === -1
        && sameWireCount(restartProvider, await provider()) && sameWireCount(beforeWeb, await provider('web')),
      'LATE_WORK_RESTART_DUPLICATE_NOT_DENIED');
      noRepairs(denied, restarted); noRepairs(await inspect('web'), beforeWebState);
      proof = { ...workProof, acceptedInferenceRequests: 1, explicitOperatorCancellation: true,
        crossProcessDeniedWhileWorkActive: true, reservationSurvivedLateCompletion: true,
        reservationSurvivedRestart: true, reservationTtlMs: -1, duplicateDenied: true, repairAttempts: 0,
        pendingJobRecovered: true, operatorReconciliation: 'REQUIRED_NOT_PERFORMED', automaticReservationDeletion: false };
    } else if (scenario === 'uncertain_restart') {
      await stopped(); await command('containment_predictive_on'); await command('containment_credential_rotate');
      const absent = await remote('worker', ['fenced-job', 'inspect', 'I03', '2']);
      if (absent.fencedJob?.job !== null) block('UNCERTAIN_PENDING_JOB_ALREADY_USED');
      const initialDependency = await dependency();
      await armDependency(initialDependency.processInstanceId);
      await remote('worker', ['fenced-job', 'create', 'I03', '2']);
      await dependency();
      await poll(inspect, value => value.containment.health.queue?.pending === 1, 10_000);
      const beforeProvider = await provider();
      await remote('worker', ['provider', 'inference_cancel_next']);
      const uncertain = await operation('containment_diagnose');
      const requests = paid(await provider()).slice(paid(beforeProvider).length);
      if (requests.length === 0) block('UNCERTAIN_DIAGNOSIS_NOT_ADMITTED');
      requireProof(requests.length === 1 && requests[0].outcome === 'transport_cancelled', 'PAID_UNCERTAINTY_NOT_PROVEN');
      const state = ledger(uncertain, 'diagnosis');
      requireProof(state?.versionRecognized === true && state.inFlight === true && state.ttlMs === -1, 'DURABLE_RESERVATION_NOT_PROVEN');
      await command('containment_dependency_restore');
      const completed = await poll(() => remote('worker', ['fenced-job', 'inspect', 'I03', '2']), value => value.fencedJob?.job?.completionVerified === true, 60_000);
      requireProof(completed.fencedJob.job.literalObserved === true, 'UNCERTAIN_PENDING_JOB_RECOVERY_NOT_PROVEN');
      await emit('restart', await transport.restart('worker'));
      const restarted = await poll(inspect, value => value.ready === true && value.processInstanceId !== uncertain.processInstanceId, 120_000, 2000, true);
      requireProof(ledger(restarted, 'diagnosis')?.stateSha256 === state.stateSha256, 'RESERVATION_LOST_ON_RESTART');
      await stopped(); await command('containment_predictive_on'); await command('containment_credential_rotate');
      await dependency(); const restartProvider = await provider();
      const denied = await operation('containment_diagnose');
      requireProof(denied.containment.run?.audit?.inferenceReason === 'in_flight'
        && sameWireCount(restartProvider, await provider()), 'UNCERTAIN_DUPLICATE_NOT_DENIED');
      proof = { acceptedInferenceRequests: 1, reservationSurvivedRestart: true, reservationTtlMs: -1,
        duplicateDenied: true, operatorReconciliation: 'REQUIRED_NOT_PERFORMED', automaticReservationDeletion: false };
    }
    classification = real ? 'VERIFIED' : 'SYNTHETIC_ONLY';
    await emit('proof', proof);
  } catch (error) {
    classification = error instanceof SelfHealAcceptanceError ? error.classification : 'BLOCKED';
    errorCode = error instanceof SelfHealAcceptanceError ? error.message : 'SELF_HEAL_ACCEPTANCE_INFERENCE_UNAVAILABLE';
    await emit('failure', { classification, errorCode });
  } finally {
    const failures = []; let restoredState = null; let restoredWebState = null;
    const restore = async (role, argv) => {
      try {
        const receipt = transport.restore ? await transport.restore(argv, role) : await transport.remote(role, argv);
        await emit('restoration', { role, argv, receipt });
        if (receipt?.observation?.rejected === true) throw new Error('Restoration command was rejected.');
        if (role === 'worker' && argv[0] === 'command') restoredState = inspection(receipt);
        if (role === 'web' && argv[0] === 'command') restoredWebState = inspection(receipt);
        return inspection(receipt);
      }
      catch { failures.push(`${role}:${argv.join(':')}`); }
      return null;
    };
    for (const argv of [['command', 'containment_cancel'], ['provider', 'release'], ['provider', 'set_healthy'],
      ['command', 'containment_dependency_restore'], ['command', 'policy_restore']]) await restore('worker', argv);
    if (scenario === 'late_completion') {
      // Release cannot accelerate accepted synthetic work; do not attest restoration until its finite timer drains.
      try { await poll(provider, value => value.inFlight === null && value.nextFault === null, 45_000); }
      catch { failures.push('worker:late-provider-work-drain'); }
    }
    if (webTouched) { await restore('web', ['command', 'containment_cancel']); await restore('web', ['command', 'policy_restore']); }
    for (const role of webTouched ? ['worker', 'web'] : ['worker']) {
      let drained = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = await restore(role, ['command', 'containment_cancel']);
        if (state && state.containment?.run?.status !== 'running' && !state.coordinator.inFlight) { drained = true; break; }
        await wait(1000);
      }
      if (!drained) failures.push(`${role}:drain`);
    }
    await restore('worker', ['command', 'containment_credential_restore']);
    if (scenario === 'late_completion' && webTouched) await restore('web', ['command', 'containment_credential_restore']);
    await restore('worker', ['command', 'coordinator_start']);
    try {
      const final = restoredState;
      requireProof(final.policy.selfImproveEnabled === false && final.claimBoundary?.faultRemaining === 0
        && final.containment?.run?.status !== 'running' && failures.length === 0, 'FAULT_RESTORATION_INCOMPLETE');
      if (webTouched) requireProof(restoredWebState?.policy?.selfImproveEnabled === false
        && restoredWebState.containment?.run?.status !== 'running' && !restoredWebState.coordinator.inFlight, 'WEB_RESTORATION_INCOMPLETE');
      restoration = real ? 'VERIFIED' : 'SYNTHETIC_ONLY';
    } catch { restoration = 'FAILED'; classification = 'BLOCKED'; errorCode ??= 'SELF_HEAL_ACCEPTANCE_INFERENCE_RESTORATION_FAILED'; }
  }
  const result = sanitizeSelfHealAcceptanceEvidence({ version: 1, scenario, classification, executed: true,
    sourceSha: manifest.receipt.sourceSha, controllerSha: manifest.controllerSha, runId: manifest.receipt.runId,
    projectId: manifest.receipt.projectId, environmentId: manifest.receipt.environmentId,
    proof, restoration, errorCode, providerBoundary: 'synthetic_loopback_adapter',
    realExternalProviderRecoveryProven: false, productionAcceptanceProven: false, eventReceipts: events });
  await options.onResult?.(result); return result;
}

async function main() {
  const argv = process.argv.slice(2); const args = {};
  const allowed = new Set(['--manifest', '--evidence-directory', '--case', '--execute', '--allow-network']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]; if (!allowed.has(key) || Object.hasOwn(args, key)) block('ARGUMENT_INVALID');
    args[key] = ['--execute', '--allow-network'].includes(key) ? true : argv[++index];
  }
  if (!isAbsolute(args['--manifest'] ?? '') || !isAbsolute(args['--evidence-directory'] ?? '')
    || !SELF_HEAL_INFERENCE_ACCEPTANCE_CASES.includes(args['--case'])) block('ARGUMENT_INVALID');
  const stat = lstatSync(args['--manifest']);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) block('MANIFEST_INVALID');
  const manifest = JSON.parse(readFileSync(args['--manifest'], 'utf8')); let sequence = 0;
  const result = await runSelfHealInferenceAcceptanceCase(args['--case'], manifest, {
    execute: args['--execute'] === true, allowNetwork: args['--allow-network'] === true,
    onReceipt: receipt => publishSelfHealAcceptanceReceipt(args['--evidence-directory'], ++sequence, receipt),
    onResult: receipt => publishSelfHealAcceptanceReceipt(args['--evidence-directory'], ++sequence, receipt),
  });
  console.log(JSON.stringify({ scenario: result.scenario, classification: result.classification, errorCode: result.errorCode ?? null }));
  if (!['VERIFIED', 'NOT_RUN'].includes(result.classification)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => {
  console.error('SELF_HEAL_INFERENCE_ACCEPTANCE_FAILED'); process.exitCode = 1;
});

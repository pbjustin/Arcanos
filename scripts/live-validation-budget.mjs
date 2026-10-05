import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LIVE_VALIDATION_BUDGET_CAPS = Object.freeze({ maxSpendMicroUsd: 2_000_000,
  maxRequests: 32, maxWorkflows: 2, durationMs: 600_000 });
const VERSION = 'arcanos-live-validation-budget/v1';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const CASES = new Set(['gaming-guide-positive', 'gaming-guide-negative']);
const STAGES = new Set(['generation', 'answer_audit', 'metadata']);
const STATUSES = new Set(['completed', 'failed', 'timed_out']);
const STOP_REASONS = new Set(['expired', 'interrupted', 'clock_invalid', 'budget_exhausted',
  'failed', 'timed_out', 'settlement_invalid', 'operator_stop']);
const LIMIT_KEYS = ['maxRequests', 'maxInputTokensPerRequest', 'maxOutputTokensPerRequest',
  'maxTotalTokens', 'durationMs', 'maxSpendMicroUsd'];
const USAGE_KEYS = ['requests', 'metadataRequests', 'reservedInputTokens', 'reservedOutputTokens', 'reservedTotalTokens',
  'reservedSpendMicroUsd', 'observedInputTokens', 'observedOutputTokens', 'observedTotalTokens', 'observedSpendMicroUsd'];
const FILE_LIMIT = 256 * 1024;

export class LiveValidationBudgetError extends Error {
  constructor(code) { super(code); this.name = 'LiveValidationBudgetError'; this.code = code; }
}
function requireBudget(condition, code) { if (!condition) throw new LiveValidationBudgetError(code); }
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => Object.hasOwn(item, 'value') && item.enumerable);
}
function validateLimits(limits) {
  requireBudget(exactKeys(limits, LIMIT_KEYS)
    && integer(limits.maxRequests, 1, LIVE_VALIDATION_BUDGET_CAPS.maxRequests)
    && integer(limits.maxInputTokensPerRequest, 1, 1_000_000)
    && integer(limits.maxOutputTokensPerRequest, 1, 100_000) && integer(limits.maxTotalTokens, 2, 4_000_000)
    && integer(limits.durationMs, 1, LIVE_VALIDATION_BUDGET_CAPS.durationMs)
    && integer(limits.maxSpendMicroUsd, 1, LIVE_VALIDATION_BUDGET_CAPS.maxSpendMicroUsd),
  'LIVE_VALIDATION_BUDGET_LIMITS_INVALID');
}
function validateModels(models) {
  requireBudget(Array.isArray(models) && models.length > 0 && models.length <= 8
    && models.every(model => exactKeys(model, ['id', 'inputMicroUsdPerToken', 'outputMicroUsdPerToken'])
      && typeof model.id === 'string' && MODEL.test(model.id)
      && [model.inputMicroUsdPerToken, model.outputMicroUsdPerToken].every(rate =>
        typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate <= 100_000))
    && new Set(models.map(model => model.id)).size === models.length, 'LIVE_VALIDATION_BUDGET_MODELS_INVALID');
}
function validateBinding(value) {
  requireBudget(typeof value.runId === 'string' && ID.test(value.runId) && SHA.test(value.commitSha)
    && integer(value.prNumber, 1, 1_000_000_000) && UUID.test(value.runtimeDeploymentId) && HASH.test(value.profileHash),
  'LIVE_VALIDATION_BUDGET_BINDING_INVALID');
}
function spend(model, inputTokens, outputTokens) {
  const amount = Math.ceil(inputTokens * model.inputMicroUsdPerToken + outputTokens * model.outputMicroUsdPerToken);
  requireBudget(integer(amount), 'LIVE_VALIDATION_BUDGET_PRICE_INVALID');
  return amount;
}
function emptyUsage() { return Object.fromEntries(USAGE_KEYS.map(key => [key, 0])); }
function protectedStat(stat, directory = false) {
  requireBudget(typeof process.getuid === 'function' && stat.uid === process.getuid()
    && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) && (stat.mode & 0o077) === 0,
  'LIVE_VALIDATION_BUDGET_PATH_UNSAFE');
}
function protectedDirectory(directory, repositoryRoot) {
  requireBudget(typeof directory === 'string' && path.isAbsolute(directory)
    && typeof repositoryRoot === 'string' && path.isAbsolute(repositoryRoot), 'LIVE_VALIDATION_BUDGET_PATH_UNSAFE');
  requireBudget(!lstatSync(directory).isSymbolicLink(), 'LIVE_VALIDATION_BUDGET_PATH_UNSAFE');
  const resolved = realpathSync(directory);
  const relative = path.relative(realpathSync(repositoryRoot), resolved);
  requireBudget(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
    'LIVE_VALIDATION_BUDGET_PATH_UNSAFE');
  protectedStat(lstatSync(resolved), true);
  return resolved;
}
function syncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function writeExclusive(filePath, data) {
  const descriptor = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, data, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  syncDirectory(path.dirname(filePath));
}
function readProtected(filePath) {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor); protectedStat(stat);
    requireBudget(stat.size > 0 && stat.size <= FILE_LIMIT, 'LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
    return readFileSync(descriptor, 'utf8');
  } finally { closeSync(descriptor); }
}
function atomicWrite(directory, runId, state) {
  const temporary = path.join(directory, '.' + runId + '.' + randomUUID() + '.tmp');
  writeExclusive(temporary, JSON.stringify(state) + '\n');
  renameSync(temporary, path.join(directory, runId + '.json'));
  syncDirectory(directory);
}

function validateState(state, runId) {
  requireBudget(exactKeys(state, ['version', 'runId', 'commitSha', 'prNumber', 'runtimeDeploymentId', 'profileHash',
    'createdAtMs', 'lastSeenAtMs', 'expiresAtMs', 'limits', 'models', 'status', 'stopReason', 'revision',
    'workflows', 'reservations', 'usage']) && state.version === VERSION && state.runId === runId,
  'LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
  validateBinding(state); validateLimits(state.limits); validateModels(state.models);
  requireBudget(integer(state.createdAtMs, 1) && integer(state.lastSeenAtMs, state.createdAtMs)
    && integer(state.expiresAtMs, state.createdAtMs + 1, state.createdAtMs + state.limits.durationMs)
    && integer(state.revision) && ['active', 'stopped'].includes(state.status)
    && (state.status === 'active' ? state.stopReason === null : STOP_REASONS.has(state.stopReason))
    && Array.isArray(state.workflows) && state.workflows.length <= LIVE_VALIDATION_BUDGET_CAPS.maxWorkflows
    && new Set(state.workflows).size === state.workflows.length && state.workflows.every(item => CASES.has(item))
    && Array.isArray(state.reservations) && state.reservations.length <= state.limits.maxRequests
    && exactKeys(state.usage, USAGE_KEYS) && Object.values(state.usage).every(value => integer(value)),
  'LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
  const usage = emptyUsage(); const ids = new Set(); let pending = 0;
  for (const reservation of state.reservations) {
    const model = state.models.find(item => item.id === reservation?.model);
    requireBudget(exactKeys(reservation, ['id', 'stage', 'model', 'status', 'reservedInputTokens', 'reservedOutputTokens',
      'reservedSpendMicroUsd', 'inputTokens', 'outputTokens', 'spendMicroUsd', 'createdAtMs', 'settledAtMs', 'reason'])
      && UUID.test(reservation.id) && !ids.has(reservation.id) && model && STAGES.has(reservation.stage)
      && (reservation.status === 'pending' || STATUSES.has(reservation.status))
      && integer(reservation.reservedInputTokens, 0, state.limits.maxInputTokensPerRequest)
      && integer(reservation.reservedOutputTokens, 0, state.limits.maxOutputTokensPerRequest)
      && (reservation.stage === 'metadata' ? reservation.reservedInputTokens === 0 && reservation.reservedOutputTokens === 0
        : reservation.reservedInputTokens > 0 && reservation.reservedOutputTokens > 0 && state.workflows.length > 0)
      && reservation.reservedSpendMicroUsd === spend(model, reservation.reservedInputTokens, reservation.reservedOutputTokens)
      && integer(reservation.createdAtMs, state.createdAtMs, state.lastSeenAtMs), 'LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
    ids.add(reservation.id);
    if (reservation.status === 'pending') {
      pending += 1;
      requireBudget(reservation.inputTokens === null && reservation.outputTokens === null && reservation.spendMicroUsd === null
        && reservation.settledAtMs === null && reservation.reason === null, 'LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
    } else {
      requireBudget(integer(reservation.inputTokens, 0, reservation.reservedInputTokens)
        && integer(reservation.outputTokens, 0, reservation.reservedOutputTokens)
        && reservation.spendMicroUsd === spend(model, reservation.inputTokens, reservation.outputTokens)
        && integer(reservation.settledAtMs, reservation.createdAtMs, state.lastSeenAtMs)
        && (reservation.reason === null || STOP_REASONS.has(reservation.reason)), 'LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
      usage.observedInputTokens += reservation.inputTokens; usage.observedOutputTokens += reservation.outputTokens;
      usage.observedTotalTokens += reservation.inputTokens + reservation.outputTokens;
      usage.observedSpendMicroUsd += reservation.spendMicroUsd;
    }
    usage.requests += 1; usage.metadataRequests += Number(reservation.stage === 'metadata');
    usage.reservedInputTokens += reservation.reservedInputTokens; usage.reservedOutputTokens += reservation.reservedOutputTokens;
    usage.reservedTotalTokens += reservation.reservedInputTokens + reservation.reservedOutputTokens;
    usage.reservedSpendMicroUsd += reservation.reservedSpendMicroUsd;
  }
  requireBudget(pending <= 1 && (state.status !== 'stopped' || pending === 0)
    && (state.status !== 'active' || state.reservations.every(item => ['pending', 'completed'].includes(item.status)))
    && USAGE_KEYS.every(key => state.usage[key] === usage[key])
    && usage.reservedTotalTokens <= state.limits.maxTotalTokens && usage.reservedSpendMicroUsd <= state.limits.maxSpendMicroUsd,
  'LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
}

function stopState(state, reason, timestamp) {
  if (state.status === 'stopped') return;
  state.status = 'stopped'; state.stopReason = reason;
  for (const reservation of state.reservations.filter(item => item.status === 'pending')) {
    Object.assign(reservation, { status: 'failed', inputTokens: 0, outputTokens: 0, spendMicroUsd: 0,
      settledAtMs: timestamp, reason });
  }
}
function summary(state) {
  return structuredClone({ runId: state.runId, commitSha: state.commitSha, prNumber: state.prNumber,
    runtimeDeploymentId: state.runtimeDeploymentId, profileHash: state.profileHash, createdAtMs: state.createdAtMs,
    expiresAtMs: state.expiresAtMs, status: state.status, stopReason: state.stopReason, limits: state.limits, models: state.models,
    workflowIds: state.workflows, counts: { workflows: state.workflows.length, requests: state.usage.requests,
      metadataRequests: state.usage.metadataRequests, pendingRequests: state.reservations.filter(item => item.status === 'pending').length },
    usage: state.usage, outcomes: state.reservations.map(({ id, ...item }) => ({ reservationId: id, ...item })) });
}

/** Supervisor-only protected volume. Locks have no stale recovery; claims are permanent and never deleted. */
export function createLiveValidationBudget({ directory, repositoryRoot, now = Date.now } = {}) {
  const root = protectedDirectory(directory, repositoryRoot);
  requireBudget(typeof now === 'function', 'LIVE_VALIDATION_BUDGET_CLOCK_INVALID');
  const ownedReservations = new Set();
  function timestamp() {
    const value = now(); requireBudget(integer(value, 1), 'LIVE_VALIDATION_BUDGET_CLOCK_INVALID'); return value;
  }
  function withLock(runId, action) {
    requireBudget(typeof runId === 'string' && ID.test(runId), 'LIVE_VALIDATION_BUDGET_RUN_ID_INVALID');
    requireBudget(protectedDirectory(directory, repositoryRoot) === root, 'LIVE_VALIDATION_BUDGET_PATH_UNSAFE');
    const lockPath = path.join(root, runId + '.lock');
    try { writeExclusive(lockPath, 'locked\n'); }
    catch (error) {
      if (error.code === 'EEXIST') throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_LOCKED');
      throw error;
    }
    try { return action(); }
    finally { unlinkSync(lockPath); syncDirectory(root); }
  }
  function mutate(runId, action) {
    return withLock(runId, () => {
      requireBudget(readProtected(path.join(root, runId + '.claim')) === 'claimed\n', 'LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
      let state;
      try { state = JSON.parse(readProtected(path.join(root, runId + '.json'))); }
      catch (error) {
        if (error instanceof LiveValidationBudgetError) throw error;
        throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_LEDGER_INVALID');
      }
      validateState(state, runId);
      const original = JSON.stringify(state); const current = timestamp();
      if (current < state.lastSeenAtMs) stopState(state, 'clock_invalid', state.lastSeenAtMs);
      else {
        state.lastSeenAtMs = current;
        if (current >= state.expiresAtMs) stopState(state, 'expired', current);
        else if (state.reservations.some(item => item.status === 'pending' && !ownedReservations.has(item.id))) {
          stopState(state, 'interrupted', current);
        }
      }
      let result; let failure;
      try { result = action(state, state.lastSeenAtMs); } catch (error) { failure = error; }
      if (JSON.stringify(state) !== original) { state.revision += 1; validateState(state, runId); atomicWrite(root, runId, state); }
      if (failure) throw failure;
      return result;
    });
  }
  function requireActive(state) {
    requireBudget(state.status === 'active', state.stopReason === 'expired'
      ? 'LIVE_VALIDATION_BUDGET_EXPIRED' : 'LIVE_VALIDATION_BUDGET_STOPPED');
  }
  return Object.freeze({
    register(spec) {
      requireBudget(exactKeys(spec, ['runId', 'commitSha', 'prNumber', 'runtimeDeploymentId', 'profileHash', 'expiresAtMs', 'limits', 'models']),
        'LIVE_VALIDATION_BUDGET_REGISTRATION_INVALID');
      validateBinding(spec); validateLimits(spec.limits); validateModels(spec.models);
      const current = timestamp();
      requireBudget(integer(spec.expiresAtMs, current + 1) && integer(current + spec.limits.durationMs, current + 1),
        'LIVE_VALIDATION_BUDGET_EXPIRED');
      return withLock(spec.runId, () => {
        try { writeExclusive(path.join(root, spec.runId + '.claim'), 'claimed\n'); }
        catch (error) {
          if (error.code === 'EEXIST') throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_REPLAY');
          throw error;
        }
        // An orphan ledger also fails closed; neither it nor the permanent claim is reset.
        try { lstatSync(path.join(root, spec.runId + '.json')); throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_REPLAY'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const state = { version: VERSION, ...structuredClone(spec), createdAtMs: current, lastSeenAtMs: current,
          expiresAtMs: Math.min(spec.expiresAtMs, current + spec.limits.durationMs), status: 'active', stopReason: null,
          revision: 0, workflows: [], reservations: [], usage: emptyUsage() };
        validateState(state, spec.runId); atomicWrite(root, spec.runId, state); return summary(state);
      });
    },
    claimWorkflow(runId, caseId) {
      requireBudget(CASES.has(caseId), 'LIVE_VALIDATION_BUDGET_CASE_FORBIDDEN');
      return mutate(runId, state => {
        requireActive(state);
        requireBudget(!state.workflows.includes(caseId), 'LIVE_VALIDATION_BUDGET_WORKFLOW_REPLAY');
        requireBudget(state.workflows.length < LIVE_VALIDATION_BUDGET_CAPS.maxWorkflows, 'LIVE_VALIDATION_BUDGET_WORKFLOW_LIMIT');
        state.workflows.push(caseId); return summary(state);
      });
    },
    reserve(runId, request) {
      requireBudget(exactKeys(request, ['model', 'inputTokens', 'outputTokens', 'stage']) && STAGES.has(request.stage),
        'LIVE_VALIDATION_BUDGET_RESERVATION_INVALID');
      const reservationId = mutate(runId, (state, current) => {
        requireActive(state);
        requireBudget(!state.reservations.some(item => item.status === 'pending'), 'LIVE_VALIDATION_BUDGET_CONCURRENCY_LIMIT');
        const model = state.models.find(item => item.id === request.model);
        requireBudget(model, 'LIVE_VALIDATION_BUDGET_MODEL_UNAPPROVED');
        requireBudget(integer(request.inputTokens, 0, state.limits.maxInputTokensPerRequest)
          && integer(request.outputTokens, 0, state.limits.maxOutputTokensPerRequest)
          && (request.stage === 'metadata' ? request.inputTokens === 0 && request.outputTokens === 0
            : request.inputTokens > 0 && request.outputTokens > 0 && state.workflows.length > 0),
        'LIVE_VALIDATION_BUDGET_RESERVATION_INVALID');
        const reservedSpendMicroUsd = spend(model, request.inputTokens, request.outputTokens);
        if (state.usage.requests + 1 > state.limits.maxRequests
          || state.usage.reservedTotalTokens + request.inputTokens + request.outputTokens > state.limits.maxTotalTokens
          || state.usage.reservedSpendMicroUsd + reservedSpendMicroUsd > state.limits.maxSpendMicroUsd) {
          stopState(state, 'budget_exhausted', current); throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_EXHAUSTED');
        }
        const id = randomUUID();
        state.reservations.push({ id, stage: request.stage, model: request.model, status: 'pending',
          reservedInputTokens: request.inputTokens, reservedOutputTokens: request.outputTokens, reservedSpendMicroUsd,
          inputTokens: null, outputTokens: null, spendMicroUsd: null, createdAtMs: current, settledAtMs: null, reason: null });
        state.usage.requests += 1; state.usage.metadataRequests += Number(request.stage === 'metadata');
        state.usage.reservedInputTokens += request.inputTokens; state.usage.reservedOutputTokens += request.outputTokens;
        state.usage.reservedTotalTokens += request.inputTokens + request.outputTokens;
        state.usage.reservedSpendMicroUsd += reservedSpendMicroUsd; return id;
      });
      ownedReservations.add(reservationId); return reservationId;
    },
    settle(runId, reservationId, observed) {
      requireBudget(typeof reservationId === 'string' && UUID.test(reservationId), 'LIVE_VALIDATION_BUDGET_RESERVATION_INVALID');
      const result = mutate(runId, (state, current) => {
        requireActive(state);
        const reservation = state.reservations.find(item => item.id === reservationId);
        requireBudget(reservation && reservation.status === 'pending' && ownedReservations.has(reservationId),
          'LIVE_VALIDATION_BUDGET_SETTLEMENT_REPLAY');
        if (!(exactKeys(observed, ['inputTokens', 'outputTokens', 'model', 'status']) && STATUSES.has(observed.status)
          && observed.model === reservation.model && integer(observed.inputTokens, 0, reservation.reservedInputTokens)
          && integer(observed.outputTokens, 0, reservation.reservedOutputTokens))) {
          stopState(state, 'settlement_invalid', current); throw new LiveValidationBudgetError('LIVE_VALIDATION_BUDGET_SETTLEMENT_INVALID');
        }
        const observedSpend = spend(state.models.find(item => item.id === reservation.model), observed.inputTokens, observed.outputTokens);
        Object.assign(reservation, { ...observed, spendMicroUsd: observedSpend, settledAtMs: current,
          reason: observed.status === 'completed' ? null : observed.status });
        state.usage.observedInputTokens += observed.inputTokens; state.usage.observedOutputTokens += observed.outputTokens;
        state.usage.observedTotalTokens += observed.inputTokens + observed.outputTokens;
        state.usage.observedSpendMicroUsd += observedSpend;
        if (observed.status !== 'completed') stopState(state, observed.status, current);
        return summary(state);
      });
      ownedReservations.delete(reservationId); return result;
    },
    stop(runId) { return mutate(runId, (state, current) => { stopState(state, 'operator_stop', current); return summary(state); }); },
    inspect(runId) { return mutate(runId, state => summary(state)); }
  });
}

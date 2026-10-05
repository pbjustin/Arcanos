import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLiveValidationBudget, LIVE_VALIDATION_BUDGET_CAPS, LiveValidationBudgetError } from './live-validation-budget.mjs';

const RUN = '0123456789abcdef0123456789abcdef';
const MODEL = 'approved-model';
const limits = { maxRequests: 32, maxInputTokensPerRequest: 100_000, maxOutputTokensPerRequest: 10_000,
  maxTotalTokens: 1_000_000, durationMs: 600_000, maxSpendMicroUsd: 2_000_000 };
const reserveRequest = { model: MODEL, inputTokens: 100, outputTokens: 50, stage: 'generation' };
const metadata = { model: MODEL, inputTokens: 0, outputTokens: 0, stage: 'metadata' };
const settlement = { model: MODEL, inputTokens: 40, outputTokens: 20, status: 'completed' };
const code = expected => error => error instanceof LiveValidationBudgetError && error.code === expected;

function fixture(context, overrides = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'arcanos-durable-budget-'));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repositoryRoot = path.join(temporary, 'checkout'); const directory = path.join(temporary, 'ledger');
  mkdirSync(repositoryRoot, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  let current = Date.now();
  const now = () => current;
  const spec = { runId: RUN, commitSha: 'a'.repeat(40), prNumber: 1527,
    runtimeDeploymentId: '11111111-1111-4111-8111-111111111111', profileHash: 'b'.repeat(64),
    expiresAtMs: current + 900_000, limits: { ...limits },
    models: [{ id: MODEL, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 }], ...overrides };
  const options = { directory, repositoryRoot, now };
  return { temporary, directory, repositoryRoot, options, spec, now,
    budget: createLiveValidationBudget(options), advance: amount => { current += amount; },
    register() { return this.budget.register(this.spec); },
    claim() { return this.budget.claimWorkflow(RUN, 'gaming-guide-positive'); } };
}

test('durable registration binds identity, clips expiry, protects files and rejects replay forever', context => {
  const f = fixture(context); const registered = f.register();
  assert.equal(registered.expiresAtMs, f.now() + 600_000);
  assert.equal(registered.profileHash, f.spec.profileHash); assert.equal(registered.runtimeDeploymentId, f.spec.runtimeDeploymentId);
  assert.deepEqual(registered.counts, { workflows: 0, requests: 0, metadataRequests: 0, pendingRequests: 0 });
  for (const suffix of ['.claim', '.json']) assert.equal(statSync(path.join(f.directory, RUN + suffix)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory).sort(), [RUN + '.claim', RUN + '.json']);
  const restarted = createLiveValidationBudget(f.options);
  assert.throws(() => restarted.register(f.spec), code('LIVE_VALIDATION_BUDGET_REPLAY'));
  f.budget.stop(RUN);
  assert.throws(() => restarted.register(f.spec), code('LIVE_VALIDATION_BUDGET_REPLAY'));
  unlinkSync(path.join(f.directory, RUN + '.json'));
  assert.throws(() => restarted.register(f.spec), code('LIVE_VALIDATION_BUDGET_REPLAY'));
  assert.equal(readFileSync(path.join(f.directory, RUN + '.claim'), 'utf8'), 'claimed\n');
});

test('only two exact workflows can be durably claimed once across sessions', context => {
  const f = fixture(context); f.register(); f.claim();
  const restarted = createLiveValidationBudget(f.options);
  assert.throws(() => restarted.claimWorkflow(RUN, 'gaming-guide-positive'), code('LIVE_VALIDATION_BUDGET_WORKFLOW_REPLAY'));
  restarted.claimWorkflow(RUN, 'gaming-guide-negative');
  assert.throws(() => restarted.claimWorkflow(RUN, 'gaming-extra'), code('LIVE_VALIDATION_BUDGET_CASE_FORBIDDEN'));
  assert.throws(() => restarted.claimWorkflow(RUN, 'gaming-guide-negative'), code('LIVE_VALIDATION_BUDGET_WORKFLOW_REPLAY'));
  assert.deepEqual(restarted.inspect(RUN).workflowIds, ['gaming-guide-positive', 'gaming-guide-negative']);
});

test('reservations persist full cost before invocation and completed usage never refunds them', context => {
  const f = fixture(context); f.register(); f.claim();
  const id = f.budget.reserve(RUN, reserveRequest);
  const persisted = JSON.parse(readFileSync(path.join(f.directory, RUN + '.json'), 'utf8'));
  assert.equal(persisted.reservations[0].id, id); assert.equal(persisted.reservations[0].status, 'pending');
  assert.equal(persisted.usage.reservedSpendMicroUsd, 200); assert.equal(persisted.usage.reservedTotalTokens, 150);
  assert.throws(() => f.budget.reserve(RUN, reserveRequest), code('LIVE_VALIDATION_BUDGET_CONCURRENCY_LIMIT'));
  const finished = f.budget.settle(RUN, id, settlement);
  assert.equal(finished.usage.reservedSpendMicroUsd, 200); assert.equal(finished.usage.observedSpendMicroUsd, 80);
  assert.equal(finished.usage.reservedTotalTokens, 150); assert.equal(finished.usage.observedTotalTokens, 60);
  assert.equal(finished.counts.pendingRequests, 0); assert.equal(finished.status, 'active');
  assert.throws(() => f.budget.settle(RUN, id, settlement), code('LIVE_VALIDATION_BUDGET_SETTLEMENT_REPLAY'));
  const restarted = createLiveValidationBudget(f.options);
  const audit = restarted.reserve(RUN, { ...reserveRequest, stage: 'answer_audit' });
  restarted.settle(RUN, audit, settlement);
  assert.equal(restarted.inspect(RUN).usage.requests, 2); assert.equal(restarted.inspect(RUN).usage.reservedSpendMicroUsd, 400);
});

test('metadata shares the total request cap without token charges or a case claim', context => {
  const f = fixture(context, { limits: { ...limits, maxRequests: 1 } }); f.register();
  const id = f.budget.reserve(RUN, metadata);
  f.budget.settle(RUN, id, { model: MODEL, inputTokens: 0, outputTokens: 0, status: 'completed' });
  assert.throws(() => f.budget.reserve(RUN, metadata), code('LIVE_VALIDATION_BUDGET_EXHAUSTED'));
  const observed = f.budget.inspect(RUN);
  assert.equal(observed.counts.requests, 1); assert.equal(observed.counts.metadataRequests, 1);
  assert.equal(observed.usage.reservedSpendMicroUsd, 0); assert.equal(observed.stopReason, 'budget_exhausted');
});

test('failures and timeouts stop the run, retain all reservations and cannot retry after restart', context => {
  for (const status of ['failed', 'timed_out']) {
    const f = fixture(context); f.register(); f.claim();
    const id = f.budget.reserve(RUN, reserveRequest);
    const stopped = f.budget.settle(RUN, id, { model: MODEL, inputTokens: 0, outputTokens: 0, status });
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.stopReason, status);
    assert.equal(stopped.usage.reservedSpendMicroUsd, 200); assert.equal(stopped.usage.requests, 1);
    assert.equal(stopped.outcomes[0].status, status);
    const restarted = createLiveValidationBudget(f.options);
    assert.throws(() => restarted.reserve(RUN, reserveRequest), code('LIVE_VALIDATION_BUDGET_STOPPED'));
    assert.equal(restarted.inspect(RUN).usage.reservedSpendMicroUsd, 200);
  }
});

test('restart with a pending reservation permanently closes it without refunds or a provider retry', context => {
  const f = fixture(context); f.register(); f.claim(); const id = f.budget.reserve(RUN, reserveRequest);
  const restarted = createLiveValidationBudget(f.options);
  const stopped = restarted.inspect(RUN);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.stopReason, 'interrupted');
  assert.equal(stopped.outcomes[0].reservationId, id); assert.equal(stopped.outcomes[0].status, 'failed');
  assert.equal(stopped.usage.reservedSpendMicroUsd, 200); assert.equal(stopped.counts.pendingRequests, 0);
  assert.throws(() => restarted.reserve(RUN, reserveRequest), code('LIVE_VALIDATION_BUDGET_STOPPED'));
  assert.throws(() => f.budget.settle(RUN, id, settlement), code('LIVE_VALIDATION_BUDGET_STOPPED'));
});

test('expiry stays anchored to initial registration, survives restart and stops a pending request', context => {
  const f = fixture(context, { limits: { ...limits, durationMs: 100 } });
  const originalExpiry = f.register().expiresAtMs;
  f.advance(90); const restarted = createLiveValidationBudget(f.options);
  restarted.claimWorkflow(RUN, 'gaming-guide-positive'); const id = restarted.reserve(RUN, reserveRequest);
  assert.equal(restarted.inspect(RUN).expiresAtMs, originalExpiry);
  f.advance(10);
  assert.throws(() => restarted.settle(RUN, id, settlement), code('LIVE_VALIDATION_BUDGET_EXPIRED'));
  const stopped = restarted.inspect(RUN);
  assert.equal(stopped.stopReason, 'expired'); assert.equal(stopped.usage.reservedSpendMicroUsd, 200);
  assert.throws(() => restarted.claimWorkflow(RUN, 'gaming-guide-negative'), code('LIVE_VALIDATION_BUDGET_EXPIRED'));
});

test('clock rollback stops the run instead of extending its original deadline', context => {
  const f = fixture(context); f.register(); f.advance(100); f.claim(); f.advance(-50);
  assert.throws(() => f.budget.reserve(RUN, reserveRequest), code('LIVE_VALIDATION_BUDGET_STOPPED'));
  assert.equal(f.budget.inspect(RUN).stopReason, 'clock_invalid');
});

test('aggregate spend and token caps include generation and audits and never refund successful responses', context => {
  for (const capped of [{ maxSpendMicroUsd: 399 }, { maxTotalTokens: 299 }]) {
    const f = fixture(context, { limits: { ...limits, ...capped } }); f.register(); f.claim();
    const id = f.budget.reserve(RUN, reserveRequest); f.budget.settle(RUN, id, settlement);
    assert.throws(() => f.budget.reserve(RUN, { ...reserveRequest, stage: 'answer_audit' }), code('LIVE_VALIDATION_BUDGET_EXHAUSTED'));
    const result = f.budget.inspect(RUN);
    assert.equal(result.counts.requests, 1); assert.equal(result.usage.reservedSpendMicroUsd, 200);
    assert.equal(result.status, 'stopped');
  }
});

test('hard $2, 32 request, two workflow and ten-minute ceilings cannot be enlarged', context => {
  assert.deepEqual(LIVE_VALIDATION_BUDGET_CAPS, { maxSpendMicroUsd: 2_000_000, maxRequests: 32, maxWorkflows: 2, durationMs: 600_000 });
  assert.ok(Object.isFrozen(LIVE_VALIDATION_BUDGET_CAPS));
  for (const changes of [{ maxSpendMicroUsd: 2_000_001 }, { maxRequests: 33 }, { durationMs: 600_001 }]) {
    const f = fixture(context, { limits: { ...limits, ...changes } });
    assert.throws(() => f.register(), code('LIVE_VALIDATION_BUDGET_LIMITS_INVALID'));
    assert.deepEqual(readdirSync(f.directory), []);
  }
});

test('the exact hard request and spend ceilings are consumed once without a session reset', context => {
  const requests = fixture(context); requests.register();
  for (let index = 0; index < 32; index += 1) {
    const id = requests.budget.reserve(RUN, metadata);
    requests.budget.settle(RUN, id, { model: MODEL, inputTokens: 0, outputTokens: 0, status: 'completed' });
  }
  assert.throws(() => requests.budget.reserve(RUN, metadata), code('LIVE_VALIDATION_BUDGET_EXHAUSTED'));
  assert.equal(createLiveValidationBudget(requests.options).inspect(RUN).usage.requests, 32);
  const cost = fixture(context, { models: [{ id: MODEL, inputMicroUsdPerToken: 1_000, outputMicroUsdPerToken: 2_000 }] });
  cost.register(); cost.claim();
  const id = cost.budget.reserve(RUN, { ...reserveRequest, inputTokens: 1_000, outputTokens: 500 });
  cost.budget.settle(RUN, id, { ...settlement, inputTokens: 0, outputTokens: 0 });
  assert.equal(cost.budget.inspect(RUN).usage.reservedSpendMicroUsd, 2_000_000);
  assert.throws(() => cost.budget.reserve(RUN, reserveRequest), code('LIVE_VALIDATION_BUDGET_EXHAUSTED'));
  assert.equal(createLiveValidationBudget(cost.options).inspect(RUN).usage.reservedSpendMicroUsd, 2_000_000);
});

test('reservation stages, model approval, per-request bounds and workflow admission fail closed', context => {
  const f = fixture(context); f.register();
  assert.throws(() => f.budget.reserve(RUN, reserveRequest), code('LIVE_VALIDATION_BUDGET_RESERVATION_INVALID'));
  f.claim();
  for (const request of [
    { ...reserveRequest, stage: 'model_generation' }, { ...reserveRequest, stage: 'tool' },
    { ...reserveRequest, inputTokens: -1 }, { ...reserveRequest, outputTokens: 0 },
    { ...reserveRequest, inputTokens: limits.maxInputTokensPerRequest + 1 },
    { ...reserveRequest, outputTokens: limits.maxOutputTokensPerRequest + 1 },
    { ...metadata, inputTokens: 1 }, { ...reserveRequest, prompt: 'must not be persisted' }
  ]) assert.throws(() => f.budget.reserve(RUN, request), code('LIVE_VALIDATION_BUDGET_RESERVATION_INVALID'));
  assert.throws(() => f.budget.reserve(RUN, { ...reserveRequest, model: 'unapproved' }), code('LIVE_VALIDATION_BUDGET_MODEL_UNAPPROVED'));
  assert.equal(f.budget.inspect(RUN).counts.requests, 0);
});

test('invalid or excess observed usage terminally stops the run while retaining the reservation', context => {
  for (const observed of [{ ...settlement, inputTokens: 101 }, { ...settlement, outputTokens: 51 },
    { ...settlement, model: 'unapproved' }, { ...settlement, status: 'retry' }, { ...settlement, inputTokens: NaN }]) {
    const f = fixture(context); f.register(); f.claim(); const id = f.budget.reserve(RUN, reserveRequest);
    assert.throws(() => f.budget.settle(RUN, id, observed), code('LIVE_VALIDATION_BUDGET_SETTLEMENT_INVALID'));
    const stopped = f.budget.inspect(RUN);
    assert.equal(stopped.stopReason, 'settlement_invalid'); assert.equal(stopped.usage.reservedSpendMicroUsd, 200);
    assert.equal(stopped.counts.pendingRequests, 0);
  }
});

test('operator stop is durable, idempotent and never releases pending budget', context => {
  const f = fixture(context); f.register(); f.claim(); f.budget.reserve(RUN, reserveRequest);
  const stopped = f.budget.stop(RUN); const restarted = createLiveValidationBudget(f.options);
  assert.equal(stopped.stopReason, 'operator_stop'); assert.equal(stopped.usage.reservedSpendMicroUsd, 200);
  assert.equal(restarted.stop(RUN).stopReason, 'operator_stop');
  assert.throws(() => restarted.reserve(RUN, metadata), code('LIVE_VALIDATION_BUDGET_STOPPED'));
});

test('ledger directory must be private, owned and outside the checkout; symlinks and unsafe files are rejected', context => {
  const f = fixture(context);
  const nested = path.join(f.repositoryRoot, 'private-ledger'); mkdirSync(nested, { mode: 0o700 });
  assert.throws(() => createLiveValidationBudget({ ...f.options, directory: nested }), code('LIVE_VALIDATION_BUDGET_PATH_UNSAFE'));
  const linked = path.join(f.temporary, 'linked'); symlinkSync(f.directory, linked);
  assert.throws(() => createLiveValidationBudget({ ...f.options, directory: linked }), code('LIVE_VALIDATION_BUDGET_PATH_UNSAFE'));
  chmodSync(f.directory, 0o755);
  assert.throws(() => createLiveValidationBudget(f.options), code('LIVE_VALIDATION_BUDGET_PATH_UNSAFE'));
  chmodSync(f.directory, 0o700); f.register();
  const ledger = path.join(f.directory, RUN + '.json'); chmodSync(ledger, 0o644);
  assert.throws(() => f.budget.inspect(RUN), code('LIVE_VALIDATION_BUDGET_PATH_UNSAFE'));
  chmodSync(ledger, 0o600); const copy = path.join(f.temporary, 'copy.json');
  writeFileSync(copy, readFileSync(ledger), { mode: 0o600 }); unlinkSync(ledger); symlinkSync(copy, ledger);
  assert.throws(() => f.budget.inspect(RUN));
});

test('stale locks are never recovered automatically and an incomplete claim cannot be replayed', context => {
  const f = fixture(context); const lock = path.join(f.directory, RUN + '.lock');
  writeFileSync(lock, 'locked\n', { mode: 0o600 });
  assert.throws(() => f.register(), code('LIVE_VALIDATION_BUDGET_LOCKED'));
  assert.throws(() => createLiveValidationBudget(f.options).register(f.spec), code('LIVE_VALIDATION_BUDGET_LOCKED'));
  assert.equal(existsSync(lock), true); assert.equal(existsSync(path.join(f.directory, RUN + '.claim')), false);
  // Simulate a crash after durable claim creation, before any ledger publication.
  const other = fixture(context); writeFileSync(path.join(other.directory, RUN + '.claim'), 'claimed\n', { mode: 0o600 });
  assert.throws(() => other.register(), code('LIVE_VALIDATION_BUDGET_REPLAY'));
  assert.equal(existsSync(path.join(other.directory, RUN + '.json')), false);
});

test('corrupt ledgers and mismatched aggregate counters cannot reset consumed budget', context => {
  for (const corrupt of [state => { state.usage.requests = 0; }, state => { state.usage.reservedSpendMicroUsd = 0; },
    state => { state.models[0].inputMicroUsdPerToken = 0; }, state => { state.limits.maxRequests = 33; }]) {
    const f = fixture(context); f.register(); f.claim(); const id = f.budget.reserve(RUN, reserveRequest);
    f.budget.settle(RUN, id, settlement);
    const ledger = path.join(f.directory, RUN + '.json'); const state = JSON.parse(readFileSync(ledger, 'utf8'));
    corrupt(state); writeFileSync(ledger, JSON.stringify(state));
    assert.throws(() => createLiveValidationBudget(f.options).reserve(RUN, metadata), LiveValidationBudgetError);
    assert.throws(() => f.register(), code('LIVE_VALIDATION_BUDGET_REPLAY'));
  }
});

test('inspection and persisted state contain only binding, counts, model prices and usage outcomes', context => {
  const f = fixture(context); f.register(); f.claim(); const id = f.budget.reserve(RUN, reserveRequest);
  const summary = f.budget.settle(RUN, id, settlement);
  summary.models[0].id = 'mutated'; summary.usage.requests = 0; summary.workflowIds.length = 0;
  const clean = f.budget.inspect(RUN);
  assert.equal(clean.models[0].id, MODEL); assert.equal(clean.usage.requests, 1); assert.equal(clean.counts.workflows, 1);
  const serialized = readFileSync(path.join(f.directory, RUN + '.json'), 'utf8');
  for (const forbidden of ['prompt', 'answer', 'sourceUrl', 'player', 'credential', 'apiKey']) {
    assert.equal(serialized.includes('"' + forbidden + '"'), false);
  }
});

function childRun(options, spec, operation) {
  const moduleUrl = new URL('./live-validation-budget.mjs', import.meta.url).href;
  const source = `import {createLiveValidationBudget} from ${JSON.stringify(moduleUrl)};
    const options=JSON.parse(process.argv[1]); const spec=JSON.parse(process.argv[2]);
    try { const budget=createLiveValidationBudget(options); ${operation}; process.stdout.write('ok'); }
    catch(error) { process.stdout.write(error.code ?? 'failed'); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source,
      JSON.stringify({ directory: options.directory, repositoryRoot: options.repositoryRoot }), JSON.stringify(spec)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('exit', status => status === 0 ? resolve(output) : reject(new Error(errors || 'child failed')));
  });
}

test('independent processes cannot both register or consume the same workflow', async context => {
  const f = fixture(context);
  const registrations = await Promise.all([childRun(f.options, f.spec, 'budget.register(spec)'),
    childRun(f.options, f.spec, 'budget.register(spec)')]);
  assert.equal(registrations.filter(value => value === 'ok').length, 1);
  assert.ok(registrations.every(value => ['ok', 'LIVE_VALIDATION_BUDGET_LOCKED', 'LIVE_VALIDATION_BUDGET_REPLAY'].includes(value)));
  const claims = await Promise.all([childRun(f.options, f.spec, "budget.claimWorkflow(spec.runId,'gaming-guide-positive')"),
    childRun(f.options, f.spec, "budget.claimWorkflow(spec.runId,'gaming-guide-positive')")]);
  assert.equal(claims.filter(value => value === 'ok').length, 1);
  assert.ok(claims.every(value => ['ok', 'LIVE_VALIDATION_BUDGET_LOCKED', 'LIVE_VALIDATION_BUDGET_WORKFLOW_REPLAY'].includes(value)));
  assert.equal(createLiveValidationBudget({ directory: f.directory, repositoryRoot: f.repositoryRoot }).inspect(RUN).counts.workflows, 1);
});

test('cross-process pending reservations fail closed instead of multiplying requests or resetting counters', async context => {
  const f = fixture(context); f.register();
  const operation = `budget.reserve(spec.runId,${JSON.stringify(metadata)})`;
  const outcomes = await Promise.all([childRun(f.options, f.spec, operation), childRun(f.options, f.spec, operation)]);
  assert.equal(outcomes.filter(value => value === 'ok').length, 1);
  assert.ok(outcomes.every(value => ['ok', 'LIVE_VALIDATION_BUDGET_LOCKED', 'LIVE_VALIDATION_BUDGET_STOPPED'].includes(value)));
  const stopped = createLiveValidationBudget({ directory: f.directory, repositoryRoot: f.repositoryRoot }).inspect(RUN);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.stopReason, 'interrupted');
  assert.equal(stopped.counts.requests, 1); assert.equal(stopped.counts.metadataRequests, 1);
});

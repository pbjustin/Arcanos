import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveValidationBudget, LIVE_VALIDATION_BUDGET_CAPS, LiveValidationBudgetError } from './live-validation-budget.mjs';

const models = [{ id: 'approved-model', inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 }];
const request = { model: models[0].id, inputTokens: 100, outputTokens: 20, stage: 'generation' };
const observed = { model: models[0].id, inputTokens: 10, outputTokens: 5 };
const code = expected => error => error instanceof LiveValidationBudgetError && error.code === expected;
function fixture(options = {}) { return createLiveValidationBudget({ models, now: () => 1_000, ...options }); }

test('default caps bound spend, requests, workflows, tokens, duration, concurrency and retries', () => {
  const budget = fixture();
  assert.deepEqual(budget.snapshot().limits, { ...LIVE_VALIDATION_BUDGET_CAPS, maxInputTokensPerRequest: 128_000,
    maxOutputTokensPerRequest: 4_096, maxTotalTokens: 400_000, maxConcurrency: 1, maxRetries: 0 });
  assert.equal(budget.snapshot().closed, false);
  for (const [key, maximum] of Object.entries(LIVE_VALIDATION_BUDGET_CAPS)) {
    assert.throws(() => fixture({ limits: { ...LIVE_VALIDATION_BUDGET_CAPS, [key]: maximum + 1 } }), code('LIVE_VALIDATION_BUDGET_LIMITS_INVALID'));
  }
  for (const candidate of [[], [{ ...models[0], inputMicroUsdPerToken: 0 }], [models[0], models[0]],
    [{ ...models[0], outputMicroUsdPerToken: Infinity }]]) {
    assert.throws(() => fixture({ models: candidate }), code('LIVE_VALIDATION_BUDGET_MODELS_INVALID'));
  }
});

test('reservations precede requests, reconcile usage, and are never refunded or mutable by inspection', () => {
  const budget = fixture(); budget.beginWorkflow('gaming-guide-positive');
  const id = budget.reserve(request);
  assert.equal(budget.snapshot().usage.requests, 1); assert.equal(budget.snapshot().usage.reservedSpendMicroUsd, 140);
  assert.deepEqual(budget.snapshot().counts, { workflows: 1, pendingRequests: 1 });
  assert.throws(() => budget.reserve(request), code('LIVE_VALIDATION_CONCURRENCY_LIMIT'));
  budget.settle(id, observed);
  const snapshot = budget.snapshot();
  assert.deepEqual(snapshot.counts, { workflows: 1, pendingRequests: 0 });
  assert.equal(snapshot.usage.observedTotalTokens, 15); assert.equal(snapshot.usage.metadataRequests, 0);
  assert.equal(snapshot.usage.observedSpendMicroUsd, 20); assert.equal(snapshot.usage.reservedSpendMicroUsd, 140);
  snapshot.usage.requests = 0; snapshot.limits.maxRequests = 100;
  assert.equal(budget.snapshot().usage.requests, 1); assert.equal(budget.snapshot().limits.maxRequests, 32);
  assert.throws(() => budget.settle(id, observed), code('LIVE_VALIDATION_USAGE_INVALID'));
  assert.equal(budget.snapshot().closed, true);
});

test('request, token and cost exhaustion stop the run before exceeding each cap', () => {
  for (const options of [{ limits: { ...LIVE_VALIDATION_BUDGET_CAPS, maxRequests: 1 } },
    { limits: { ...LIVE_VALIDATION_BUDGET_CAPS, maxSpendMicroUsd: 140 } }]) {
    const budget = fixture(options); budget.beginWorkflow('gaming-guide-positive');
    const id = budget.reserve(request); budget.settle(id, observed);
    assert.throws(() => budget.reserve(request), code('LIVE_VALIDATION_BUDGET_EXHAUSTED'));
    assert.equal(budget.snapshot().usage.requests, 1); assert.equal(budget.snapshot().closed, true);
  }
  const budget = fixture(); budget.beginWorkflow('gaming-guide-positive');
  const large = { ...request, inputTokens: 128_000, outputTokens: 4_096 };
  for (let index = 0; index < 3; index++) {
    const id = budget.reserve(large); budget.settle(id, { ...observed, inputTokens: 0, outputTokens: 0 });
  }
  assert.throws(() => budget.reserve(large), code('LIVE_VALIDATION_BUDGET_EXHAUSTED'));
  assert.equal(budget.snapshot().usage.reservedTotalTokens, 396_288);
});

test('negative control forbids all provider requests, including free model metadata', () => {
  for (const candidate of [request, { ...request, stage: 'metadata', inputTokens: 0, outputTokens: 0 }]) {
    const budget = fixture(); budget.beginWorkflow('gaming-guide-negative');
    assert.throws(() => budget.reserve(candidate), code('LIVE_VALIDATION_NEGATIVE_PROVIDER_FORBIDDEN'));
    assert.equal(budget.snapshot().usage.requests, 0); assert.equal(budget.snapshot().closed, true);
  }
});

test('workflow admission cannot reset the budget, replay profiles, or exceed two workflows', () => {
  const budget = fixture(); budget.beginWorkflow('gaming-guide-positive');
  const id = budget.reserve(request); budget.settle(id, observed); budget.endWorkflow();
  assert.throws(() => budget.beginWorkflow('gaming-guide-positive'), code('LIVE_VALIDATION_WORKFLOW_REPLAY'));
  budget.beginWorkflow('gaming-guide-negative'); budget.endWorkflow();
  assert.equal(budget.snapshot().usage.requests, 1);
  const restricted = fixture({ limits: { ...LIVE_VALIDATION_BUDGET_CAPS, maxWorkflows: 1 } });
  restricted.beginWorkflow('gaming-guide-positive'); restricted.endWorkflow();
  assert.throws(() => restricted.beginWorkflow('gaming-guide-negative'), code('LIVE_VALIDATION_WORKFLOW_LIMIT'));
  assert.equal('register' in budget, false);
});

test('content needs an active positive workflow while model metadata is counted before adapter startup', () => {
  const budget = fixture();
  assert.throws(() => budget.reserve(request), code('LIVE_VALIDATION_WORKFLOW_REQUIRED'));
  const id = budget.reserve({ ...request, stage: 'metadata', inputTokens: 0, outputTokens: 0 });
  budget.settle(id, { ...observed, inputTokens: 0, outputTokens: 0 });
  assert.equal(budget.snapshot().usage.requests, 1); assert.equal(budget.snapshot().usage.providerCalls, 0);
  assert.equal(budget.snapshot().usage.metadataRequests, 1); assert.equal(budget.snapshot().usage.observedTotalTokens, 0);
});

test('invalid provider usage fails closed without refunding the reservation', () => {
  for (const override of [{ inputTokens: 101 }, { outputTokens: 21 }, { inputTokens: -1 }, { model: 'other' }]) {
    const budget = fixture(); budget.beginWorkflow('gaming-guide-positive'); const id = budget.reserve(request);
    assert.throws(() => budget.settle(id, { ...observed, ...override }), code('LIVE_VALIDATION_USAGE_INVALID'));
    assert.equal(budget.snapshot().closed, true); assert.equal(budget.snapshot().usage.reservedSpendMicroUsd, 140);
    assert.equal(budget.snapshot().usage.observedSpendMicroUsd, 0);
  }
});

test('expiry, a backwards clock, and explicit close cannot reopen or clear usage', () => {
  let current = 1_000;
  const budget = fixture({ now: () => current, expiresAtMs: 1_100 }); budget.beginWorkflow('gaming-guide-positive');
  budget.reserve(request); current = 1_100;
  assert.throws(() => budget.remainingMs(), code('LIVE_VALIDATION_BUDGET_EXPIRED'));
  assert.equal(budget.snapshot().usage.elapsedMs, 100); assert.equal(budget.snapshot().usage.requests, 1);
  const backwards = fixture({ now: () => current }); current--;
  assert.throws(() => backwards.beginWorkflow('gaming-guide-positive'), code('LIVE_VALIDATION_BUDGET_CLOCK_INVALID'));
  const stopped = fixture(); stopped.close();
  assert.throws(() => stopped.beginWorkflow('gaming-guide-positive'), code('LIVE_VALIDATION_RUN_CLOSED'));
});

test('limits/models are copied and model accessors are rejected without invocation', () => {
  const localModels = structuredClone(models); const localLimits = { ...LIVE_VALIDATION_BUDGET_CAPS };
  const budget = fixture({ models: localModels, limits: localLimits });
  localModels[0].inputMicroUsdPerToken = 0; localLimits.maxSpendMicroUsd = 1;
  budget.beginWorkflow('gaming-guide-positive'); budget.reserve(request);
  assert.equal(budget.snapshot().usage.reservedSpendMicroUsd, 140);
  let invoked = false; const model = { ...models[0] };
  Object.defineProperty(model, 'id', { enumerable: true, get() { invoked = true; return models[0].id; } });
  assert.throws(() => fixture({ models: [model] }), code('LIVE_VALIDATION_BUDGET_MODELS_INVALID'));
  assert.equal(invoked, false);
});

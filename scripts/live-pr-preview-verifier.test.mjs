import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  LIVE_PREVIEW_CASE_MANIFEST,
  LIVE_PREVIEW_ACCEPTANCE_PROFILE,
  LIVE_PREVIEW_MODE,
  createLivePreviewEvidence,
  verifyLivePreviewEvidence,
  verifyLivePreviewSuite,
} from './live-pr-preview-verifier.mjs';

const identity = Object.freeze({ sourceCommit: 'a'.repeat(40), approvedSourceCommit: 'a'.repeat(40), deploymentId: 'preview-deployment-123', moduleId: 'gaming', mode: LIVE_PREVIEW_MODE });
const limits = Object.freeze({ maxRequests: 32, maxInputTokensPerRequest: 1_000, maxOutputTokensPerRequest: 300,
  maxTotalTokens: 20_000, durationMs: 60_000, maxSpendMicroUsd: 500_000, maxConcurrency: 1, maxRetries: 0 });

function positiveResult() {
  return { ok: true, route: 'gaming', mode: 'guide', data: {
    response: 'Use the documented preparation steps before the encounter. [1] Bring the listed recovery item. (Source 2)',
    sources: [{ url: 'https://guides.example.com/game/guide?secret=private#signed', snippet: 'Verified public guide passage.' },
      { url: 'https://wiki.example.com/game/preparation', snippet: 'Verified preparation passage.' }],
    grounding: { groundingStatus: 'grounded', groundedInSuppliedEvidence: true, fetchedSuppliedSourceCount: 2,
      usableSourceCount: 2, citableSourceCount: 2, selectedChunkCount: 2, suppliedEvidenceSourceCount: 2 },
  } };
}

function usageFor(caseId) {
  const expected = LIVE_PREVIEW_CASE_MANIFEST.find(entry => entry.caseId === caseId);
  const generationCalls = expected.provider === 'none' ? 0 : 1;
  const auditCalls = expected.provider === 'generation_and_audit' ? 1 : 0;
  const providerCalls = generationCalls + auditCalls;
  return { requests: providerCalls, providerCalls, generationCalls, auditCalls,
    reservedInputTokens: 900 * providerCalls, reservedOutputTokens: 200 * providerCalls,
    reservedTotalTokens: 1_100 * providerCalls, reservedSpendMicroUsd: 5_000 * providerCalls,
    observedInputTokens: 300 * providerCalls, observedOutputTokens: 50 * providerCalls,
    observedSpendMicroUsd: 2_000 * providerCalls, elapsedMs: 2_000, limits: { ...limits } };
}

function inputFor(caseId) {
  const expected = LIVE_PREVIEW_CASE_MANIFEST.find(entry => entry.caseId === caseId);
  return { caseId, failureCode: expected.failureCode, stages: { ...expected.stages }, usage: usageFor(caseId),
    result: caseId === 'useful_grounded_guide' ? positiveResult() : undefined,
    audit: caseId === 'useful_grounded_guide' ? { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true }
      : caseId === 'audit_timeout' ? { assessmentStatus: 'unavailable', decision: 'unavailable', boundToFinalAnswer: false }
        : { assessmentStatus: 'not_run', decision: 'unavailable', boundToFinalAnswer: false } };
}

function makeEvidence(caseId = 'useful_grounded_guide', mutate = () => {}) {
  const input = inputFor(caseId);
  mutate(input);
  return createLivePreviewEvidence(identity, input);
}

test('requires the complete eight-case manifest and keeps synthetic and installed OAuth evidence separate', () => {
  const evidence = LIVE_PREVIEW_CASE_MANIFEST.map(entry => makeEvidence(entry.caseId));
  const result = verifyLivePreviewSuite(evidence, identity);
  assert.equal(result.status, 'PASS');
  assert.equal(result.cases.filter(entry => entry.accepted).length, 1);
  assert.equal(result.code, 'LIVE_BACKEND_PREVIEW_CONTRACT_PASS');
  assert.deepEqual(result.verification, { syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' });
  assert.ok(result.remainingGaps.includes('chatgpt_consent_unverified'));
  assert.ok(result.remainingGaps.includes('installed_plugin_acceptance_unverified'));
  assert.ok(result.remainingGaps.includes('trusted_live_execution_provenance_required'));
  assert.equal(verifyLivePreviewSuite(evidence.slice(0, -1), identity).status, 'FAIL');
  assert.equal(verifyLivePreviewSuite([...evidence.slice(0, -1), evidence[0]], identity).status, 'FAIL');
  const extraCases = verifyLivePreviewSuite([...evidence, evidence[0]], identity);
  assert.equal(extraCases.status, 'FAIL');
  assert.equal(extraCases.cases.length, LIVE_PREVIEW_CASE_MANIFEST.length);
  assert.equal(verifyLivePreviewSuite([], identity).status, 'FAIL');
});

test('sanitizes raw prompt, answer, passages, errors, audit content, headers and URL query/fragment', () => {
  const secret = 'never-publish-private-test-sentinel';
  const evidence = makeEvidence('useful_grounded_guide', input => {
    input.prompt = secret;
    input.result.data.response = `${secret} [1]`;
    input.result.data.sources[0].snippet = secret;
    input.result.data.sources[0].title = secret;
    input.result.data.sources[0].url = `https://guides.example.com/game/${secret}?token=${secret}#${secret}`;
    input.result.data.sources[1].error = secret;
    input.result.headers = { authorization: secret };
    input.audit.rawResponse = secret;
    input.audit.subjectHash = secret;
    input.usage.authorization = secret;
    input.failureCode = secret;
  });
  assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.equal(evidence.result.sources[0].url, 'https://guides.example.com/');
  assert.equal(evidence.result.sources[0].documentUrlSha256, createHash('sha256').update(`https://guides.example.com/game/${secret}`).digest('hex'));
  assert.equal(evidence.failureCode, 'UNOBSERVED_FAILURE');
  assert.equal(verifyLivePreviewEvidence(evidence, identity).status, 'FAIL');
});

test('ties evidence to the exact approved SHA, deployment and live mode', () => {
  const evidence = makeEvidence();
  assert.equal(verifyLivePreviewEvidence(evidence, identity).status, 'PASS');
  for (const changed of [
    { ...identity, sourceCommit: 'b'.repeat(40), approvedSourceCommit: 'b'.repeat(40) },
    { ...identity, approvedSourceCommit: 'b'.repeat(40) },
    { ...identity, deploymentId: 'different-deployment' },
    { ...identity, moduleId: 'research' },
    { ...identity, mode: 'sealed-synthetic' },
  ]) assert.equal(verifyLivePreviewEvidence(evidence, changed).status, 'FAIL');
  for (const changed of [
    { ...identity, sourceCommit: 'short' }, { ...identity, approvedSourceCommit: undefined },
    { ...identity, deploymentId: 'secret\nvalue' }, { ...identity, deploymentId: 123 },
    { ...identity, mode: 'production' },
    { ...identity, moduleId: 'ARCANOS:GAMING' }, { ...identity, moduleId: undefined },
  ]) assert.throws(() => createLivePreviewEvidence(changed, inputFor('useful_grounded_guide')), /^Error: LIVE_PREVIEW_IDENTITY_INVALID$/u);
  assert.throws(() => createLivePreviewEvidence(identity, { caseId: 'custom-paid-case' }), /^Error: LIVE_PREVIEW_CASE_INVALID$/u);
});

test('reuses the same mandatory grounded answer profile across modules without equating contract checks to live proof', () => {
  const researchIdentity = { ...identity, moduleId: 'research_analysis' };
  const input = inputFor('useful_grounded_guide');
  input.result.route = 'research';
  input.result.mode = 'answer';
  input.result.data.response = 'The supplied study supports this conclusion [1].';
  const evidence = createLivePreviewEvidence(researchIdentity, input);
  assert.equal(evidence.acceptanceProfile, LIVE_PREVIEW_ACCEPTANCE_PROFILE);
  assert.equal(verifyLivePreviewEvidence(evidence, researchIdentity).status, 'PASS');
  assert.equal(verifyLivePreviewEvidence(evidence, identity).status, 'FAIL');
  assert.equal(evidence.verification.liveBackend, 'unverified');
  evidence.acceptanceProfile = 'source-free-shortcut';
  assert.equal(verifyLivePreviewEvidence(evidence, researchIdentity).status, 'FAIL');
});

test('HTTP success, generation alone, supplied audit scores and an unbound audit cannot accept a guide', () => {
  const mutations = [
    input => { input.result = { status: 200, body: 'generated' }; },
    input => { delete input.audit; },
    input => { input.audit.boundToFinalAnswer = false; },
    input => { input.audit.assessmentStatus = 'not_run'; },
    input => { input.audit.decision = 'partial'; },
    input => { input.audit.decision = 'reject'; input.audit.overall = 5; },
    input => { input.usage.providerCalls = 1; input.usage.auditCalls = 0; },
    input => { input.stages.answer_audit = 'not_run'; },
    input => { delete input.stages.source_acquisition; },
  ];
  for (const mutate of mutations) assert.equal(verifyLivePreviewEvidence(makeEvidence('useful_grounded_guide', mutate), identity).status, 'FAIL');
});

test('fallback, dry-run, incomplete and empty output are rejected even with an accepting audit', () => {
  for (const mutate of [
    input => { input.result.data.fallbackReason = 'GAMING_ANSWER_AUDIT_UNAVAILABLE'; },
    input => { input.result.data.fallbackReason = undefined; },
    input => { input.result.dryRun = true; },
    input => { input.result.data.executionOutcome = 'dry_run'; },
    input => { input.result.data.incomplete = true; },
    input => { input.result.data.response = '  '; },
  ]) assert.equal(verifyLivePreviewEvidence(makeEvidence('useful_grounded_guide', mutate), identity).status, 'FAIL');
});

test('requires acquired, usable supplied passages and selected grounded chunks', () => {
  for (const field of ['fetchedSuppliedSourceCount', 'usableSourceCount', 'citableSourceCount', 'selectedChunkCount', 'suppliedEvidenceSourceCount']) {
    assert.equal(verifyLivePreviewEvidence(makeEvidence('useful_grounded_guide', input => { input.result.data.grounding[field] = 0; }), identity).status, 'FAIL');
  }
  for (const mutate of [
    input => { input.result.data.grounding.groundedInSuppliedEvidence = false; },
    input => { input.result.data.grounding.groundingStatus = 'insufficient_evidence'; },
    input => { input.stages.source_validation = 'rejected'; },
    input => { input.result.data.sources[0].snippet = ''; },
  ]) assert.equal(verifyLivePreviewEvidence(makeEvidence('useful_grounded_guide', mutate), identity).status, 'FAIL');
});

test('citations must resolve to usable public source URLs at their original one-based indices', () => {
  const canonical = makeEvidence();
  assert.equal(canonical.result.sources[0].url, 'https://guides.example.com/');
  assert.equal(canonical.result.sources[0].documentUrlSha256, createHash('sha256').update('https://guides.example.com/game/guide').digest('hex'));
  for (const answer of ['Uncited preparation.', 'Preparation [3]', 'Preparation [0]', 'Preparation [1, 9]', 'Preparation (Sources 1, 9)']) {
    assert.equal(verifyLivePreviewEvidence(makeEvidence('useful_grounded_guide', input => { input.result.data.response = answer; }), identity).status, 'FAIL');
  }
  for (const url of ['http://127.0.0.1/private', 'https://[::1]/private', 'https://localhost/private', 'https://service.internal/private',
    'https://user:password@guides.example.com/game/guide', 'file:///tmp/private', 'https://10.0.0.1/private']) {
    const evidence = makeEvidence('useful_grounded_guide', input => { input.result.data.sources[0].url = url; });
    assert.equal(evidence.result.sources[0].url, null);
    assert.equal(verifyLivePreviewEvidence(evidence, identity).status, 'FAIL');
  }
  const tampered = makeEvidence();
  tampered.result.sources[0].url = null;
  tampered.result.citationsResolved = true;
  assert.equal(verifyLivePreviewEvidence(tampered, identity).status, 'FAIL');
  const digestMissing = makeEvidence();
  delete digestMissing.result.sources[0].documentUrlSha256;
  assert.equal(verifyLivePreviewEvidence(digestMissing, identity).status, 'FAIL');
  const pathLeaked = makeEvidence();
  pathLeaked.result.sources[0].url = 'https://guides.example.com/game/token-private';
  assert.equal(verifyLivePreviewEvidence(pathLeaked, identity).status, 'FAIL');
});

test('all preprovider negative cases require the correct observed boundary and zero per-case calls', () => {
  for (const expected of LIVE_PREVIEW_CASE_MANIFEST.filter(entry => entry.provider === 'none')) {
    assert.equal(verifyLivePreviewEvidence(makeEvidence(expected.caseId), identity).status, 'PASS');
    const failureStage = Object.keys(expected.stages).find(name => ['rejected', 'failed', 'exhausted'].includes(expected.stages[name]));
    assert.equal(verifyLivePreviewEvidence(makeEvidence(expected.caseId, input => { input.stages[failureStage] = 'passed'; }), identity).status, 'FAIL');
    assert.equal(verifyLivePreviewEvidence(makeEvidence(expected.caseId, input => {
      input.usage = usageFor('model_timeout');
    }), identity).status, 'FAIL');
    assert.equal(verifyLivePreviewEvidence(makeEvidence(expected.caseId, input => { input.failureCode = 'MODEL_TIMEOUT'; }), identity).status, 'FAIL');
    assert.equal(verifyLivePreviewEvidence(makeEvidence(expected.caseId, input => {
      input.result = positiveResult(); input.audit = { assessmentStatus: 'completed', decision: 'accept', boundToFinalAnswer: true };
    }), identity).status, 'FAIL');
  }
});

test('generation and audit timeouts remain distinct and arbitrary unavailability does not establish timeout', () => {
  assert.equal(verifyLivePreviewEvidence(makeEvidence('model_timeout'), identity).status, 'PASS');
  assert.equal(verifyLivePreviewEvidence(makeEvidence('audit_timeout'), identity).status, 'PASS');
  for (const mutate of [
    input => { input.stages.answer_audit = 'failed'; },
    input => { input.stages.generation = 'timed_out'; },
    input => { input.failureCode = 'MODEL_TIMEOUT'; },
    input => { input.audit.assessmentStatus = 'not_run'; },
    input => { input.usage.providerCalls = 1; input.usage.auditCalls = 0; },
  ]) assert.equal(verifyLivePreviewEvidence(makeEvidence('audit_timeout', mutate), identity).status, 'FAIL');
  assert.equal(verifyLivePreviewEvidence(makeEvidence('model_timeout', input => {
    input.usage.providerCalls = 2; input.usage.auditCalls = 1;
  }), identity).status, 'FAIL');
});

test('resource reservations and every explicit limit fail closed, including unknown timeout usage', () => {
  for (const field of Object.keys(limits)) {
    for (const bad of [undefined, NaN, Infinity, -1, '1000']) {
      assert.equal(verifyLivePreviewEvidence(makeEvidence('useful_grounded_guide', input => { input.usage.limits[field] = bad; }), identity).status, 'FAIL');
    }
  }
  for (const [field, value] of [['requests', 33], ['providerCalls', 3], ['observedInputTokens', 1_801],
    ['observedOutputTokens', 401], ['observedSpendMicroUsd', 10_001], ['reservedSpendMicroUsd', 500_001],
    ['reservedTotalTokens', 20_001], ['elapsedMs', 60_001], ['reservedInputTokens', NaN]]) {
    assert.equal(verifyLivePreviewEvidence(makeEvidence('useful_grounded_guide', input => { input.usage[field] = value; }), identity).status, 'FAIL');
  }
  const timeout = makeEvidence('model_timeout', input => {
    input.usage.observedInputTokens = 0; input.usage.observedOutputTokens = 0; input.usage.observedSpendMicroUsd = 0;
  });
  assert.equal(verifyLivePreviewEvidence(timeout, identity).status, 'PASS');
  assert.equal(timeout.usage.reservedTotalTokens, 1_100);
});

test('preprovider cases can report cumulative run reservations while per-case calls remain zero', () => {
  const evidence = makeEvidence('exhausted_budget', input => {
    input.usage = { ...usageFor('useful_grounded_guide'), providerCalls: 0, generationCalls: 0, auditCalls: 0 };
  });
  assert.equal(verifyLivePreviewEvidence(evidence, identity).status, 'PASS');
  assert.equal(evidence.usage.requests, 2);
  assert.equal(evidence.usage.providerCalls, 0);
});

test('budget exhaustion may follow safe source checks but cannot hide a different failure stage', () => {
  const safe = makeEvidence('exhausted_budget', input => {
    input.stages.source_acquisition = 'passed'; input.stages.source_validation = 'passed';
  });
  assert.equal(verifyLivePreviewEvidence(safe, identity).status, 'PASS');
  for (const mutate of [
    input => { input.stages.source_acquisition = 'passed'; },
    input => { input.stages.source_acquisition = 'failed'; input.stages.source_validation = 'passed'; },
    input => { input.stages.source_acquisition = 'passed'; input.stages.source_validation = 'rejected'; },
    input => { input.stages.source_acquisition = 'passed'; input.stages.source_validation = 'passed'; input.stages.generation = 'passed'; },
  ]) assert.equal(verifyLivePreviewEvidence(makeEvidence('exhausted_budget', mutate), identity).status, 'FAIL');
});

test('missing or malformed evidence fails with fixed safe codes', () => {
  for (const evidence of [null, undefined, false, 'private-sentinel', {}, { caseId: 'private-sentinel' }, { schemaVersion: 1, caseId: 'useful_grounded_guide', result: { sources: [null] } }]) {
    const result = verifyLivePreviewEvidence(evidence, identity);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.code, 'LIVE_PREVIEW_CASE_FAILED');
    assert.equal(JSON.stringify(result).includes('private-sentinel'), false);
  }
});

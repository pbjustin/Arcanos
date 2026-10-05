#!/usr/bin/env node

import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readTrustedOperatorFile, readTrustedRunnerGitState } from './live-pr-preview-run.mjs';
import { validateLivePreviewAdmission } from './live-pr-preview-policy.mjs';
import { createLivePreviewEvidence, LIVE_PREVIEW_ACCEPTANCE_PROFILE, LIVE_PREVIEW_CASE_MANIFEST, LIVE_PREVIEW_MODE,
  verifyLivePreviewEvidence, verifyLivePreviewSuite } from './live-pr-preview-verifier.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CASES = new Map(LIVE_PREVIEW_CASE_MANIFEST.map(entry => [entry.caseId, entry]));
const COUNTS = ['requests', 'providerCalls', 'generationCalls', 'auditCalls', 'reservedInputTokens',
  'reservedOutputTokens', 'reservedTotalTokens', 'reservedSpendMicroUsd', 'observedInputTokens',
  'observedOutputTokens', 'observedSpendMicroUsd', 'elapsedMs'];
const LIMITS = ['maxRequests', 'maxInputTokensPerRequest', 'maxOutputTokensPerRequest', 'maxTotalTokens',
  'durationMs', 'maxSpendMicroUsd', 'maxConcurrency', 'maxRetries'];
const STAGES = ['authorization', 'budget', 'source_acquisition', 'source_validation', 'generation', 'answer_audit', 'delivery'];
const STAGE_STATUSES = new Set(['not_run', 'passed', 'rejected', 'failed', 'timed_out', 'exhausted']);
const VALUES = new Set(['--commit-sha', '--pr-number', '--backend-base-url', '--module-id', '--case-id', '--scenario-file',
  '--session-file', '--approval-file', '--attestation-file', '--trust-file', '--verify-evidence', '--deployment-id',
  '--request-timeout-ms', '--total-timeout-ms']);
const FLAGS = new Set(['--execute', '--allow-network']);
const MAX_REQUESTS = 4;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_BODY_BYTES = 32 * 1024;

export class LivePreviewE2eError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireE2e = (condition, code) => { if (!condition) throw new LivePreviewE2eError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const safeCount = value => integer(value) ? value : null;
const safeBoolean = value => typeof value === 'boolean' ? value : null;
const safeEnum = (value, allowed) => allowed.includes(value) ? value : 'unobserved';

function privatePreviewOrigin(value, prNumber) {
  let url;
  try { url = new URL(value); } catch { throw new LivePreviewE2eError('LIVE_PREVIEW_E2E_ORIGIN_INVALID'); }
  const host = url.hostname.toLowerCase();
  requireE2e(url.protocol === 'https:' && !url.username && !url.password && !url.port
    && url.pathname === '/' && !url.search && !url.hash && !isIP(host.replace(/^\[|\]$/gu, ''))
    && host.includes('.') && !/(?:^|[.-])(?:production|prod|localhost)(?:[.-]|$)/u.test(host)
    && new RegExp(`(?:^|[.-])live-pr-${prNumber}(?:[.-]|$)`, 'u').test(host), 'LIVE_PREVIEW_E2E_ORIGIN_INVALID');
  return url.origin;
}

export function parseLivePreviewE2eArguments(argv) {
  const args = { execute: false, allowNetwork: false, requestTimeoutMs: 5_000, totalTimeoutMs: 120_000 };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    requireE2e((VALUES.has(key) || FLAGS.has(key)) && !seen.has(key), 'LIVE_PREVIEW_E2E_ARGUMENT_INVALID');
    seen.add(key);
    const property = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (FLAGS.has(key)) { args[property] = true; continue; }
    requireE2e(typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--'), 'LIVE_PREVIEW_E2E_ARGUMENT_INVALID');
    args[property] = argv[++index];
  }
  requireE2e(/^[0-9a-f]{40}$/u.test(args.commitSha ?? ''), 'LIVE_PREVIEW_E2E_SHA_INVALID');
  requireE2e(/^[a-z][a-z0-9_-]{0,63}$/u.test(args.moduleId ?? ''), 'LIVE_PREVIEW_E2E_MODULE_INVALID');
  for (const [key, maximum] of [['requestTimeoutMs', 120_000], ['totalTimeoutMs', 1_800_000]]) {
    requireE2e(/^[1-9][0-9]*$/u.test(String(args[key])) && integer(Number(args[key]), 1, maximum), 'LIVE_PREVIEW_E2E_LIMIT_INVALID');
    args[key] = Number(args[key]);
  }
  requireE2e(args.requestTimeoutMs <= args.totalTimeoutMs, 'LIVE_PREVIEW_E2E_LIMIT_INVALID');
  requireE2e(args.execute === args.allowNetwork, 'LIVE_PREVIEW_E2E_EXECUTION_FLAGS_REQUIRED');
  if (args.verifyEvidence) {
    requireE2e(!args.execute && /^[0-9a-f-]{36}$/u.test(args.deploymentId ?? ''), 'LIVE_PREVIEW_E2E_EVIDENCE_ARGUMENT_INVALID');
  } else {
    requireE2e(/^[1-9][0-9]*$/u.test(args.prNumber ?? '') && integer(Number(args.prNumber), 1, 1_000_000_000), 'LIVE_PREVIEW_E2E_PR_INVALID');
    args.prNumber = Number(args.prNumber);
    args.backendBaseUrl = privatePreviewOrigin(args.backendBaseUrl, args.prNumber);
    requireE2e(!args.caseId || CASES.has(args.caseId), 'LIVE_PREVIEW_E2E_CASE_INVALID');
    if (args.execute) requireE2e(['caseId', 'scenarioFile', 'sessionFile', 'approvalFile', 'attestationFile', 'trustFile']
      .every(key => typeof args[key] === 'string' && args[key].length), 'LIVE_PREVIEW_E2E_EXECUTION_INPUT_REQUIRED');
  }
  return args;
}

/** Projection deliberately retains no answer prose, source paths, errors, credentials, or arbitrary keys. */
export function sanitizeLivePreviewEvidence(value) {
  requireE2e(record(value) && record(value.identity) && record(value.result) && record(value.audit)
    && record(value.stages) && record(value.usage), 'LIVE_PREVIEW_E2E_EVIDENCE_INVALID');
  const identity = value.identity;
  requireE2e(/^[0-9a-f]{40}$/u.test(identity.sourceCommit ?? '') && identity.sourceCommit === identity.approvedSourceCommit
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identity.deploymentId ?? '')
    && identity.mode === LIVE_PREVIEW_MODE && /^[a-z][a-z0-9_-]{0,63}$/u.test(identity.moduleId ?? '')
    && value.acceptanceProfile === LIVE_PREVIEW_ACCEPTANCE_PROFILE && CASES.has(value.caseId), 'LIVE_PREVIEW_E2E_EVIDENCE_INVALID');
  const result = value.result;
  requireE2e(Array.isArray(result.sources) && result.sources.length <= 8
    && Array.isArray(result.citationIndices) && result.citationIndices.length <= 32,
  'LIVE_PREVIEW_E2E_EVIDENCE_INVALID');
  const grounding = record(result.grounding) ? result.grounding : {};
  const audit = value.audit;
  const usage = value.usage;
  const sources = result.sources.map(source => {
    let origin = null;
    if (record(source) && typeof source.url === 'string' && source.url.length <= 2_048) {
      try {
        const url = new URL(source.url);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
          && !isIP(url.hostname.replace(/^\[|\]$/gu, '')) && url.hostname.includes('.')
          && !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/u.test(url.hostname) && !url.hostname.endsWith('.home.arpa')) {
          origin = url.origin + '/';
        }
      } catch { /* Invalid source identities remain unusable. */ }
    }
    return { index: safeCount(source?.index), url: origin,
      ...(typeof source?.documentUrlSha256 === 'string' && /^[0-9a-f]{64}$/u.test(source.documentUrlSha256)
        ? { documentUrlSha256: source.documentUrlSha256 } : {}), usable: safeBoolean(source?.usable) };
  });
  return { schemaVersion: value.schemaVersion === 1 ? 1 : null, acceptanceProfile: LIVE_PREVIEW_ACCEPTANCE_PROFILE,
    identity: { sourceCommit: identity.sourceCommit, approvedSourceCommit: identity.approvedSourceCommit,
      deploymentId: identity.deploymentId, moduleId: identity.moduleId, mode: LIVE_PREVIEW_MODE }, caseId: value.caseId,
    failureCode: value.failureCode === null ? null : safeEnum(value.failureCode, LIVE_PREVIEW_CASE_MANIFEST.map(entry => entry.failureCode)),
    stages: Object.fromEntries(STAGES.map(key => [key, STAGE_STATUSES.has(value.stages[key]) ? value.stages[key] : 'unobserved'])),
    result: { ...Object.fromEntries(['ok', 'answerPresent', 'fallback', 'dryRun', 'incomplete', 'citationsResolved', 'acceptedAnswer']
      .map(key => [key, safeBoolean(result[key])])),
      grounding: { status: safeEnum(grounding.status, ['grounded', 'insufficient_evidence', 'unavailable']),
        groundedInSuppliedEvidence: safeBoolean(grounding.groundedInSuppliedEvidence),
        ...Object.fromEntries(['fetchedSuppliedSourceCount', 'usableSourceCount', 'citableSourceCount', 'selectedChunkCount', 'suppliedEvidenceSourceCount']
          .map(key => [key, safeCount(grounding[key])])) }, sources,
      citationIndices: result.citationIndices.map(safeCount) },
    audit: { assessmentStatus: safeEnum(audit.assessmentStatus, ['completed', 'unavailable', 'not_run']),
      decision: safeEnum(audit.decision, ['accept', 'partial', 'reject', 'clarify', 'unavailable']), boundToFinalAnswer: safeBoolean(audit.boundToFinalAnswer) },
    usage: { ...Object.fromEntries(COUNTS.map(key => [key, safeCount(usage[key])])),
      limits: Object.fromEntries(LIMITS.map(key => [key, safeCount(usage.limits?.[key])])) },
    verification: { syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' },
    remainingGaps: ['installed_plugin_oauth_unverified', 'installed_plugin_acceptance_unverified', 'chatgpt_consent_unverified',
      'chatgpt_refresh_unverified', 'provider_billing_reconciliation_unverified', 'trusted_live_execution_provenance_required'] };
}

function readScenarios(raw, selectedCase, moduleId) {
  requireE2e(record(raw) && raw.version === 1 && raw.moduleId === moduleId && Array.isArray(raw.cases) && raw.cases.length > 0
    && raw.cases.length <= CASES.size && new Set(raw.cases.map(entry => entry?.caseId)).size === raw.cases.length
    && raw.cases.every(entry => record(entry) && CASES.has(entry.caseId) && record(entry.input)), 'LIVE_PREVIEW_E2E_SCENARIO_INVALID');
  const scenario = raw.cases.find(entry => entry.caseId === selectedCase);
  requireE2e(scenario, 'LIVE_PREVIEW_E2E_SCENARIO_INVALID');
  const body = JSON.stringify({ caseId: selectedCase, input: scenario.input });
  requireE2e(Buffer.byteLength(body) <= MAX_BODY_BYTES, 'LIVE_PREVIEW_E2E_REQUEST_LIMIT');
  const urls = scenario.sourceUrls;
  requireE2e(Array.isArray(urls) && urls.length > 0 && urls.length <= 8
    && urls.every(value => typeof value === 'string' && value.length > 0 && value.length <= 2_048),
  'LIVE_PREVIEW_E2E_SCENARIO_INVALID');
  const sourceDigests = urls.map(value => {
    let url;
    try { url = new URL(value); } catch { throw new LivePreviewE2eError('LIVE_PREVIEW_E2E_SCENARIO_INVALID'); }
    url.search = ''; url.hash = '';
    return createHash('sha256').update(url.href).digest('hex');
  });
  return { body, sourceDigests };
}

function approvalLimits(limits) { return { ...limits, maxConcurrency: 1, maxRetries: 0 }; }

/** Reviewed verifier only; never imports, checks out, executes PR code or resolves provider credentials. */
export async function runLivePreviewE2e(argv, dependencies = {}) {
  const args = parseLivePreviewE2eArguments(argv);
  const root = dependencies.repositoryRoot ?? ROOT;
  const read = dependencies.readOperatorFile ?? readTrustedOperatorFile;
  const readJson = file => {
    try { return JSON.parse(read(file, root)); }
    catch { throw new LivePreviewE2eError('LIVE_PREVIEW_E2E_OPERATOR_FILE_INVALID'); }
  };
  const expectedIdentity = { sourceCommit: args.commitSha, approvedSourceCommit: args.commitSha,
    deploymentId: args.deploymentId, moduleId: args.moduleId, mode: LIVE_PREVIEW_MODE };
  if (args.verifyEvidence) {
    const raw = readJson(args.verifyEvidence);
    requireE2e(Array.isArray(raw) && raw.length === CASES.size, 'LIVE_PREVIEW_E2E_EVIDENCE_INVALID');
    const evidence = raw.map(sanitizeLivePreviewEvidence);
    return { executed: false, mode: LIVE_PREVIEW_MODE, moduleId: args.moduleId, sourceCommit: args.commitSha, evidence,
      suite: verifyLivePreviewSuite(evidence, expectedIdentity), evidenceOrigin: 'operator_saved_observations_unattested' };
  }
  if (!args.execute) {
    let scenarioCaseIds;
    if (args.scenarioFile) {
      const scenarios = readJson(args.scenarioFile);
      // Reuse execution validation without reading admission/session files or making requests.
      readScenarios(scenarios, args.caseId ?? scenarios?.cases?.[0]?.caseId, args.moduleId);
      scenarioCaseIds = args.caseId ? [args.caseId] : scenarios.cases.map(entry => entry.caseId);
      for (const caseId of scenarioCaseIds.slice(1)) readScenarios(scenarios, caseId, args.moduleId);
    }
    return { executed: false, mode: LIVE_PREVIEW_MODE, sourceCommit: args.commitSha,
      moduleId: args.moduleId, prNumber: args.prNumber, caseIds: args.caseId ? [args.caseId] : [...CASES.keys()],
      ...(scenarioCaseIds ? { scenarioCaseIds } : {}),
      maxHttpRequests: MAX_REQUESTS, requestTimeoutMs: args.requestTimeoutMs, totalTimeoutMs: args.totalTimeoutMs,
      verification: { syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' } };
  }

  const now = dependencies.now ?? Date.now;
  const startedAtMs = now();
  const signedApproval = readJson(args.approvalFile);
  const attestation = readJson(args.attestationFile);
  const trust = readJson(args.trustFile);
  const git = (dependencies.readGitState ?? readTrustedRunnerGitState)(root);
  requireE2e(git.clean === true && git.repository === 'pbjustin/Arcanos' && git.head === trust.trustedRunnerSha,
    'LIVE_PREVIEW_E2E_TRUSTED_REVISION_MISMATCH');
  const admission = validateLivePreviewAdmission({ enabled: true, signedApproval, attestation,
    trustedApprovalPublicKey: trust.approvalPublicKey, trustedIsolation: trust.trustedIsolation, nowMs: startedAtMs });
  const approval = admission.approval;
  requireE2e(approval.commitSha === args.commitSha && approval.prNumber === args.prNumber, 'LIVE_PREVIEW_E2E_APPROVAL_MISMATCH');
  requireE2e(approval.moduleIds.includes(args.moduleId), 'LIVE_PREVIEW_E2E_MODULE_UNAPPROVED');
  const session = readJson(args.sessionFile);
  const backendOrigin = privatePreviewOrigin(session.backendOrigin, args.prNumber);
  const brokerOrigin = privatePreviewOrigin(session.brokerOrigin, args.prNumber);
  requireE2e(backendOrigin === args.backendBaseUrl && backendOrigin === attestation.backendOrigin
    && brokerOrigin === attestation.brokerOrigin && brokerOrigin !== backendOrigin, 'LIVE_PREVIEW_E2E_ORIGIN_MISMATCH');
  const identity = { sourceCommit: args.commitSha, approvedSourceCommit: args.commitSha,
    deploymentId: approval.deployment.deploymentId, moduleId: args.moduleId, mode: LIVE_PREVIEW_MODE };
  requireE2e(session.version === 1 && session.mode === LIVE_PREVIEW_MODE
    && ['sourceCommit', 'approvedSourceCommit', 'deploymentId'].every(key => session[key] === identity[key])
    && Object.entries(approval.deployment).every(([key, value]) => session[key] === value)
    && session.prNumber === args.prNumber && integer(session.expiresAtMs, startedAtMs + 1)
    && session.expiresAtMs <= approval.expiresAtMs && session.expiresAtMs - startedAtMs <= approval.limits.durationMs
    && integer(session.requestTimeoutMs, 1, 120_000) && session.requestTimeoutMs <= approval.limits.durationMs
    && /^arcanos-preview-[0-9a-f]{64}$/u.test(session.testBearer ?? '') && /^[0-9a-f]{64}$/u.test(session.brokerBearer ?? '')
    && isDeepStrictEqual(session.limits, approval.limits) && isDeepStrictEqual(session.models, approval.models)
    && isDeepStrictEqual(session.moduleIds, approval.moduleIds), 'LIVE_PREVIEW_E2E_SESSION_INVALID');
  const { body, sourceDigests } = readScenarios(readJson(args.scenarioFile), args.caseId, args.moduleId);
  const headers = { 'x-arcanos-source-commit': identity.sourceCommit, 'x-arcanos-deployment-id': identity.deploymentId };
  const deadlineMs = Math.min(startedAtMs + args.totalTimeoutMs, session.expiresAtMs);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  let requests = 0;
  let aggregateBytes = 0;
  const request = async (url, options) => {
    const remainingMs = deadlineMs - now();
    requireE2e(remainingMs > 0 && ++requests <= MAX_REQUESTS, 'LIVE_PREVIEW_E2E_RESOURCE_LIMIT');
    const controller = new AbortController();
    let timer;
    const operation = (async () => {
      const response = await fetchImplementation(url, { ...options, redirect: 'error', signal: controller.signal });
      requireE2e(response && response.status >= 200 && response.status < 600 && response.body
        && !response.redirected && (!response.url || response.url === url), 'LIVE_PREVIEW_E2E_RESPONSE_INVALID');
      requireE2e((response.headers.get('content-type') ?? '').split(';')[0].trim() === 'application/json', 'LIVE_PREVIEW_E2E_RESPONSE_INVALID');
      const chunks = []; let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length; aggregateBytes += chunk.length;
          requireE2e(bytes <= MAX_RESPONSE_BYTES && aggregateBytes <= MAX_REQUESTS * MAX_RESPONSE_BYTES, 'LIVE_PREVIEW_E2E_RESPONSE_LIMIT');
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) { controller.abort(); throw error; }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new LivePreviewE2eError('LIVE_PREVIEW_E2E_RESPONSE_INVALID'); }
      return { status: response.status, value };
    })();
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new LivePreviewE2eError('LIVE_PREVIEW_E2E_REQUEST_TIMEOUT')); },
          Math.min(args.requestTimeoutMs, session.requestTimeoutMs, remainingMs));
      })]);
    } finally { clearTimeout(timer); }
  };
  const brokerHeaders = { ...headers, authorization: 'Bearer ' + session.brokerBearer };
  const admitted = await request(brokerOrigin + '/session', { method: 'GET', headers: brokerHeaders });
  requireE2e(admitted.status === 200 && ['mode', 'sourceCommit', 'approvedSourceCommit', 'deploymentId', 'projectId',
    'environmentId', 'environmentName', 'serviceId', 'prNumber', 'expiresAtMs', 'testBearer', 'backendOrigin', 'brokerOrigin']
    .every(key => admitted.value?.[key] === session[key])
    && isDeepStrictEqual(admitted.value.limits, session.limits) && isDeepStrictEqual(admitted.value.models, session.models)
    && isDeepStrictEqual(admitted.value.moduleIds, session.moduleIds), 'LIVE_PREVIEW_E2E_BROKER_IDENTITY_MISMATCH');
  const usageSnapshot = async () => {
    const response = await request(brokerOrigin + '/usage', { method: 'GET', headers: brokerHeaders });
    const value = response.value;
    requireE2e(response.status === 200 && value?.commitSha === identity.sourceCommit
      && value.deployment?.deploymentId === identity.deploymentId
      && Object.entries(approval.deployment).every(([key, field]) => value.deployment[key] === field)
      && isDeepStrictEqual(value.limits, approvalLimits(approval.limits)) && record(value.usage)
      && COUNTS.every(key => integer(value.usage[key])) && integer(value.usage.rejectedBudgetRequests)
      && value.expiresAtMs === session.expiresAtMs, 'LIVE_PREVIEW_E2E_BROKER_USAGE_INVALID');
    return value;
  };
  const before = await usageSnapshot();
  requireE2e(['providerCalls', 'generationCalls', 'auditCalls'].every(key => before.usage[key] === 0), 'LIVE_PREVIEW_E2E_FRESH_SESSION_REQUIRED');
  const unauthorized = args.caseId === 'unauthorized_test_identity';
  const invalidBearer = session.testBearer.slice(0, -1) + (session.testBearer.endsWith('0') ? '1' : '0');
  const response = await request(backendOrigin + '/__preview/live/' + args.moduleId, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', authorization: 'Bearer ' +
      (unauthorized ? invalidBearer : session.testBearer) }, body });
  const after = await usageSnapshot();
  requireE2e(Array.isArray(after.stages) && after.stages.length <= approval.limits.maxRequests
    && after.stages.every(entry => record(entry) && ['provider_metadata', 'model_generation', 'answer_audit'].includes(entry.stage)
      && ['completed', 'failed'].includes(entry.outcome) && approval.models.some(model => model.id === entry.model)
      && (entry.actualModel === undefined || typeof entry.actualModel === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(entry.actualModel))
      && entry.moduleId === args.moduleId)
    && after.usage.generationCalls === after.stages.filter(entry => entry.stage === 'model_generation').length
    && after.usage.auditCalls === after.stages.filter(entry => entry.stage === 'answer_audit').length
    && after.usage.providerCalls === after.usage.generationCalls + after.usage.auditCalls,
  'LIVE_PREVIEW_E2E_PROVIDER_LEDGER_INVALID');
  requireE2e(Array.isArray(before.rejections) && Array.isArray(after.rejections) && after.rejections.length <= 64
    && after.rejections.every(entry => record(entry) && entry.moduleId === args.moduleId
      && ['provider_metadata', 'model_generation', 'answer_audit'].includes(entry.stage)
      && entry.code === 'LIVE_PREVIEW_BUDGET_EXHAUSTED')
    && after.usage.rejectedBudgetRequests >= before.usage.rejectedBudgetRequests, 'LIVE_PREVIEW_E2E_REJECTION_LEDGER_INVALID');
  const budgetDenialProven = after.budgetExhausted === true &&
    (after.usage.rejectedBudgetRequests > before.usage.rejectedBudgetRequests
      && after.rejections.slice(before.rejections.length).some(entry => entry.moduleId === args.moduleId)
      || before.budgetExhausted === true && before.rejections.some(entry => entry.moduleId === args.moduleId
        && entry.code === 'LIVE_PREVIEW_BUDGET_EXHAUSTED'));
  let evidence;
  const deniedBudget = args.caseId === 'exhausted_budget' && response.status === 429;
  if (unauthorized || deniedBudget) {
    requireE2e(response.status === (unauthorized ? 401 : 429)
      && response.value?.code === (unauthorized ? 'UNAUTHORIZED_TEST_IDENTITY' : 'BUDGET_EXHAUSTED')
      && ['providerCalls', 'generationCalls', 'auditCalls'].every(key => after.usage[key] === 0), 'LIVE_PREVIEW_E2E_DENIAL_UNPROVEN');
    if (deniedBudget) requireE2e(budgetDenialProven, 'LIVE_PREVIEW_E2E_BUDGET_DENIAL_UNPROVEN');
    const expected = CASES.get(args.caseId);
    evidence = createLivePreviewEvidence(identity, { caseId: args.caseId, failureCode: expected.failureCode,
      stages: expected.stages, usage: { ...after.usage, limits: after.limits } });
  } else {
    requireE2e(response.status === 200 && response.value?.caseId === args.caseId, 'LIVE_PREVIEW_E2E_BACKEND_FAILED');
    evidence = sanitizeLivePreviewEvidence(response.value);
    requireE2e(COUNTS.filter(key => key !== 'elapsedMs').every(key => evidence.usage[key] === after.usage[key])
      && integer(evidence.usage.elapsedMs, before.usage.elapsedMs, after.usage.elapsedMs)
      && isDeepStrictEqual(evidence.usage.limits, after.limits), 'LIVE_PREVIEW_E2E_USAGE_MISMATCH');
    evidence.usage.elapsedMs = after.usage.elapsedMs;
    if (args.caseId === 'exhausted_budget') requireE2e(budgetDenialProven, 'LIVE_PREVIEW_E2E_BUDGET_DENIAL_UNPROVEN');
  }
  if (args.caseId === 'useful_grounded_guide') requireE2e(evidence.result.citationIndices.every(index =>
    sourceDigests.includes(evidence.result.sources.find(source => source.index === index)?.documentUrlSha256)),
  'LIVE_PREVIEW_E2E_CITATION_SOURCE_MISMATCH');
  if (args.caseId === 'useful_grounded_guide') requireE2e(['model_generation', 'answer_audit'].every(stage =>
    after.stages.some(entry => entry.stage === stage && entry.outcome === 'completed')),
  'LIVE_PREVIEW_E2E_PROVIDER_COMPLETION_UNPROVEN');
  if (args.caseId === 'model_timeout' || args.caseId === 'audit_timeout') {
    const stage = args.caseId === 'model_timeout' ? 'model_generation' : 'answer_audit';
    requireE2e(after.closed === true && after.stages.some(entry => entry.stage === stage && entry.outcome === 'failed'
      && ['LIVE_PREVIEW_PROVIDER_TIMEOUT', 'LIVE_PREVIEW_CANCELLED'].includes(entry.code)), 'LIVE_PREVIEW_E2E_PROVIDER_TIMEOUT_UNPROVEN');
  }
  evidence = sanitizeLivePreviewEvidence(evidence);
  const verification = verifyLivePreviewEvidence(evidence, identity);
  const observedModels = after.stages.map(entry => ({ moduleId: entry.moduleId, stage: entry.stage,
    requestedModel: entry.model, actualModel: entry.actualModel ?? null, outcome: entry.outcome }));
  const output = { executed: true, mode: LIVE_PREVIEW_MODE, moduleId: args.moduleId, sourceCommit: identity.sourceCommit,
    deploymentId: identity.deploymentId, caseId: args.caseId, httpRequests: requests, evidence, verification, observedModels,
    verificationStages: { syntheticPreview: 'unverified', liveBackend: verification.status === 'PASS' ? 'case_verified' : 'unverified',
      installedPluginOAuth: 'unverified' }, remainingGaps: [...evidence.remainingGaps.filter(gap => gap !== 'trusted_live_execution_provenance_required'),
      'trusted_live_suite_aggregation_unverified'] };
  const serialized = JSON.stringify(output);
  requireE2e(!serialized.includes(session.testBearer) && !serialized.includes(session.brokerBearer), 'LIVE_PREVIEW_SECRET_IN_EVIDENCE');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runLivePreviewE2e(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (result.verification?.status === 'FAIL' || result.suite?.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    const code = typeof error.code === 'string' && /^LIVE_PREVIEW_[A-Z_]+$/u.test(error.code)
      ? error.code : 'LIVE_PREVIEW_E2E_FAILED';
    const executionRequested = process.argv.slice(2).includes('--execute');
    console.error(JSON.stringify({ executionRequested, executed: executionRequested ? null : false,
      mode: LIVE_PREVIEW_MODE, error: code,
      verification: { syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' } }));
    process.exitCode = 1;
  }
}

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const LIVE_PREVIEW_MODE = 'live-backend-v1';
export const LIVE_PREVIEW_ACCEPTANCE_PROFILE = 'grounded-audited-answer-v1';
const STAGE_NAMES = Object.freeze(['authorization', 'budget', 'source_acquisition', 'source_validation', 'generation', 'answer_audit', 'delivery']);
const STAGE_STATUSES = new Set(['not_run', 'passed', 'rejected', 'failed', 'timed_out', 'exhausted']);
const AUDIT_STATUSES = new Set(['completed', 'unavailable', 'not_run']);
const AUDIT_DECISIONS = new Set(['accept', 'partial', 'reject', 'clarify', 'unavailable']);
const COUNT_FIELDS = Object.freeze(['requests', 'providerCalls', 'generationCalls', 'auditCalls', 'reservedInputTokens', 'reservedOutputTokens', 'reservedTotalTokens', 'reservedSpendMicroUsd', 'observedInputTokens', 'observedOutputTokens', 'observedSpendMicroUsd', 'elapsedMs']);
const LIMIT_FIELDS = Object.freeze(['maxRequests', 'maxInputTokensPerRequest', 'maxOutputTokensPerRequest', 'maxTotalTokens', 'durationMs', 'maxSpendMicroUsd']);
const GROUNDING_COUNTS = Object.freeze(['fetchedSuppliedSourceCount', 'usableSourceCount', 'citableSourceCount', 'selectedChunkCount', 'suppliedEvidenceSourceCount']);
const stages = (...values) => Object.freeze(Object.fromEntries(STAGE_NAMES.map((name, index) => [name, values[index]])));

// The adapter-normalized payload belongs to the operator. These expected boundaries are module independent.
export const LIVE_PREVIEW_CASE_MANIFEST = Object.freeze([
  { caseId: 'useful_grounded_guide', failureCode: null, provider: 'generation_and_audit', stages: stages('passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed') },
  { caseId: 'incompatible_source', failureCode: 'INCOMPATIBLE_SOURCE', provider: 'none', stages: stages('passed', 'passed', 'passed', 'rejected', 'not_run', 'not_run', 'rejected') },
  { caseId: 'insufficient_evidence', failureCode: 'INSUFFICIENT_EVIDENCE', provider: 'none', stages: stages('passed', 'passed', 'passed', 'rejected', 'not_run', 'not_run', 'rejected') },
  { caseId: 'acquisition_failure', failureCode: 'ACQUISITION_FAILURE', provider: 'none', stages: stages('passed', 'passed', 'failed', 'not_run', 'not_run', 'not_run', 'rejected') },
  { caseId: 'model_timeout', failureCode: 'MODEL_TIMEOUT', provider: 'generation_only', stages: stages('passed', 'passed', 'passed', 'passed', 'timed_out', 'not_run', 'rejected') },
  { caseId: 'audit_timeout', failureCode: 'AUDIT_TIMEOUT', provider: 'generation_and_audit', stages: stages('passed', 'passed', 'passed', 'passed', 'passed', 'timed_out', 'rejected') },
  { caseId: 'exhausted_budget', failureCode: 'BUDGET_EXHAUSTED', provider: 'none', stages: stages('passed', 'exhausted', 'not_run', 'not_run', 'not_run', 'not_run', 'rejected') },
  { caseId: 'unauthorized_test_identity', failureCode: 'UNAUTHORIZED_TEST_IDENTITY', provider: 'none', stages: stages('rejected', 'not_run', 'not_run', 'not_run', 'not_run', 'not_run', 'rejected') },
].map(Object.freeze));
const MANIFEST = new Map(LIVE_PREVIEW_CASE_MANIFEST.map(entry => [entry.caseId, entry]));
const FAILURE_CODES = new Set(LIVE_PREVIEW_CASE_MANIFEST.map(entry => entry.failureCode).filter(Boolean));
const REMAINING_GAPS = Object.freeze(['installed_plugin_oauth_unverified', 'chatgpt_consent_unverified', 'chatgpt_refresh_unverified', 'installed_plugin_acceptance_unverified', 'provider_billing_reconciliation_unverified', 'trusted_live_execution_provenance_required']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positiveLimit = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const boundedEnum = (value, allowed, otherwise) => allowed.has(value) ? value : otherwise;

function identityValid(value) {
  return isRecord(value) && typeof value.sourceCommit === 'string' && /^[a-f0-9]{40}$/u.test(value.sourceCommit)
    && value.sourceCommit === value.approvedSourceCommit
    && typeof value.deploymentId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.deploymentId)
    && typeof value.moduleId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value.moduleId)
    && value.mode === LIVE_PREVIEW_MODE;
}

function requireIdentity(identity) {
  if (!identityValid(identity)) throw new Error('LIVE_PREVIEW_IDENTITY_INVALID');
  return { sourceCommit: identity.sourceCommit, approvedSourceCommit: identity.approvedSourceCommit,
    deploymentId: identity.deploymentId, moduleId: identity.moduleId, mode: LIVE_PREVIEW_MODE };
}

function normalizedSourceUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2_048) return null;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || isIP(host.replace(/^\[|\]$/gu, '')) || !host.includes('.')
      || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/u.test(host) || host.endsWith('.home.arpa')) return null;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

function sanitizedSourceUrl(rawUrl) {
  const normalized = normalizedSourceUrl(rawUrl);
  return normalized === null ? null : `${new URL(normalized).origin}/`;
}

function sanitizedUsage(usage) {
  const value = isRecord(usage) ? usage : {};
  const limits = isRecord(value.limits) ? value.limits : {};
  return { ...Object.fromEntries(COUNT_FIELDS.map(name => [name, count(value[name])])),
    limits: { ...Object.fromEntries(LIMIT_FIELDS.map(name => [name, positiveLimit(limits[name])])),
      maxConcurrency: limits.maxConcurrency === 1 ? 1 : null, maxRetries: limits.maxRetries === 0 ? 0 : null } };
}

function sanitizedResult(result, audit) {
  const envelope = isRecord(result) ? result : {};
  const data = isRecord(envelope.data) ? envelope.data : {};
  const grounding = isRecord(data.grounding) ? data.grounding : {};
  const response = typeof data.response === 'string' ? data.response : '';
  const sourceList = Array.isArray(data.sources) ? data.sources : [];
  const sources = sourceList.slice(0, 8).map((source, index) => {
    const value = isRecord(source) ? source : {};
    const normalizedUrl = normalizedSourceUrl(value.url);
    return { index: index + 1, url: sanitizedSourceUrl(normalizedUrl),
      documentUrlSha256: normalizedUrl === null ? null : createHash('sha256').update(normalizedUrl).digest('hex'),
      usable: typeof value.snippet === 'string' && value.snippet.trim().length > 0 && !value.error };
  });
  // Adapters retain the citation spellings checked by their mandatory backend answer audit.
  const references = [...response.matchAll(/(?:\[(?:sources?\s+)?|\(sources?\s+|\bsources?\s+)(\d+(?:\s*,\s*\d+)*)/giu)]
    .flatMap(match => match[1].split(',').map(value => Number(value.trim())));
  const citationIndices = [...new Set(references)].sort((a, b) => a - b).slice(0, 32);
  const citationsResolved = references.length > 0 && references.length <= 128 && references.every(index =>
    Number.isSafeInteger(index) && index > 0 && sources.some(source => source.index === index && source.url && source.usable));
  const fallback = Object.hasOwn(data, 'fallbackReason');
  const dryRun = envelope.dryRun === true || data.dryRun === true || data.executionOutcome === 'dry_run';
  const incomplete = envelope.incomplete === true || data.incomplete === true || data.fallbackReason === 'PROVIDER_COMPLETION_INCOMPLETE';
  return { ok: envelope.ok === true, answerPresent: response.trim().length > 0, fallback, dryRun, incomplete,
    grounding: { status: boundedEnum(grounding.groundingStatus, new Set(['grounded', 'insufficient_evidence', 'unavailable']), 'unobserved'),
      groundedInSuppliedEvidence: grounding.groundedInSuppliedEvidence === true,
      ...Object.fromEntries(GROUNDING_COUNTS.map(name => [name, count(grounding[name])])) },
    sources, citationIndices, citationsResolved,
    acceptedAnswer: envelope.ok === true && response.trim().length > 0 && !fallback && !dryRun && !incomplete
      && audit.assessmentStatus === 'completed' && audit.decision === 'accept' && audit.boundToFinalAnswer };
}

/** Only the private backend may supply audit/stage observations. HTTP response fields cannot establish them. */
export function createLivePreviewEvidence(identity, { caseId, result, audit, usage, failureCode, stages: observedStages } = {}) {
  const safeIdentity = requireIdentity(identity);
  if (!MANIFEST.has(caseId)) throw new Error('LIVE_PREVIEW_CASE_INVALID');
  const observedAudit = isRecord(audit) ? audit : {};
  const safeAudit = { assessmentStatus: boundedEnum(observedAudit.assessmentStatus, AUDIT_STATUSES, 'unobserved'),
    decision: boundedEnum(observedAudit.decision, AUDIT_DECISIONS, 'unobserved'), boundToFinalAnswer: observedAudit.boundToFinalAnswer === true };
  const observations = isRecord(observedStages) ? observedStages : {};
  return { schemaVersion: 1, acceptanceProfile: LIVE_PREVIEW_ACCEPTANCE_PROFILE, identity: safeIdentity, caseId,
    failureCode: failureCode === undefined || failureCode === null ? null : boundedEnum(failureCode, FAILURE_CODES, 'UNOBSERVED_FAILURE'),
    stages: Object.fromEntries(STAGE_NAMES.map(name => [name, boundedEnum(observations[name], STAGE_STATUSES, 'unobserved')])),
    result: sanitizedResult(result, safeAudit), audit: safeAudit, usage: sanitizedUsage(usage),
    verification: { syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' },
    remainingGaps: [...REMAINING_GAPS] };
}

function usageValid(usage) {
  if (!isRecord(usage) || !isRecord(usage.limits)
    || COUNT_FIELDS.some(name => count(usage[name]) === null)
    || LIMIT_FIELDS.some(name => positiveLimit(usage.limits[name]) === null)
    || usage.limits.maxConcurrency !== 1 || usage.limits.maxRetries !== 0) return false;
  const limits = usage.limits;
  return usage.requests <= limits.maxRequests && usage.providerCalls <= usage.requests
    && usage.generationCalls + usage.auditCalls === usage.providerCalls
    && usage.reservedInputTokens <= limits.maxInputTokensPerRequest * usage.requests
    && usage.reservedOutputTokens <= limits.maxOutputTokensPerRequest * usage.requests
    && usage.observedInputTokens <= usage.reservedInputTokens && usage.observedOutputTokens <= usage.reservedOutputTokens
    && usage.reservedInputTokens + usage.reservedOutputTokens === usage.reservedTotalTokens
    && usage.reservedTotalTokens <= limits.maxTotalTokens
    && usage.observedSpendMicroUsd <= usage.reservedSpendMicroUsd && usage.reservedSpendMicroUsd <= limits.maxSpendMicroUsd
    && usage.elapsedMs <= limits.durationMs;
}

export function verifyLivePreviewEvidence(evidence, expectedIdentity) {
  const value = isRecord(evidence) ? evidence : {};
  const expected = MANIFEST.get(value.caseId);
  const identity = value.identity;
  const observations = isRecord(value.stages) ? value.stages : {};
  const result = isRecord(value.result) ? value.result : {};
  const audit = isRecord(value.audit) ? value.audit : {};
  const usage = isRecord(value.usage) ? value.usage : {};
  const checks = [];
  const check = (id, passed) => checks.push({ id, status: passed ? 'PASS' : 'FAIL' });
  check('schema', value.schemaVersion === 1);
  check('reviewed_acceptance_profile', value.acceptanceProfile === LIVE_PREVIEW_ACCEPTANCE_PROFILE);
  check('exact_approved_identity', identityValid(identity) && identityValid(expectedIdentity)
    && ['sourceCommit', 'approvedSourceCommit', 'deploymentId', 'moduleId', 'mode'].every(name => identity[name] === expectedIdentity[name]));
  check('known_case', Boolean(expected));
  check('bounded_resources', usageValid(usage));
  check('exact_failure_code', Boolean(expected) && value.failureCode === expected.failureCode);
  const exhaustedAfterSafeAcquisition = expected?.caseId === 'exhausted_budget'
    && observations.source_acquisition === 'passed' && observations.source_validation === 'passed';
  check('observed_stage_boundaries', Boolean(expected) && STAGE_NAMES.every(name =>
    exhaustedAfterSafeAcquisition && ['source_acquisition', 'source_validation'].includes(name)
      || observations[name] === expected.stages[name]));
  const noProviders = usage.providerCalls === 0 && usage.generationCalls === 0 && usage.auditCalls === 0;
  check('expected_provider_stages', expected?.provider === 'none' ? noProviders
    : expected?.provider === 'generation_only' ? usage.generationCalls > 0 && usage.auditCalls === 0
      : expected?.provider === 'generation_and_audit' && usage.generationCalls > 0 && usage.auditCalls > 0);
  if (expected?.caseId === 'useful_grounded_guide') {
    const grounding = isRecord(result.grounding) ? result.grounding : {};
    check('complete_answer', result.ok === true && result.answerPresent === true && result.acceptedAnswer === true
      && result.fallback === false && result.dryRun === false && result.incomplete === false);
    check('acquired_supplied_grounding', grounding.status === 'grounded' && grounding.groundedInSuppliedEvidence === true
      && GROUNDING_COUNTS.every(name => Number.isSafeInteger(grounding[name]) && grounding[name] > 0));
    const sourceList = Array.isArray(result.sources) ? result.sources : [];
    const references = Array.isArray(result.citationIndices) ? result.citationIndices : [];
    check('resolved_citations', result.citationsResolved === true && references.length > 0 && references.length <= 32
      && references.every(index => Number.isSafeInteger(index) && index > 0
        && sourceList.some(source => isRecord(source) && source.index === index && source.usable === true
          && typeof source.url === 'string' && sanitizedSourceUrl(source.url) === source.url
          && typeof source.documentUrlSha256 === 'string' && /^[a-f0-9]{64}$/u.test(source.documentUrlSha256))));
    check('mandatory_bound_answer_audit', audit.assessmentStatus === 'completed' && audit.decision === 'accept' && audit.boundToFinalAnswer === true);
  } else {
    check('no_accepted_answer', result.acceptedAnswer === false && audit.boundToFinalAnswer === false
      && !(audit.assessmentStatus === 'completed' && audit.decision === 'accept'));
    if (expected?.caseId === 'audit_timeout') check('audit_timeout_observed', audit.assessmentStatus === 'unavailable' && audit.decision === 'unavailable');
  }
  const passed = checks.every(item => item.status === 'PASS');
  return { status: passed ? 'PASS' : 'FAIL', code: passed ? 'LIVE_PREVIEW_CASE_PASS' : 'LIVE_PREVIEW_CASE_FAILED',
    caseId: expected?.caseId ?? 'unobserved', accepted: passed && expected?.caseId === 'useful_grounded_guide', checks };
}

export function verifyLivePreviewSuite(evidence, expectedIdentity) {
  const observations = Array.isArray(evidence) ? evidence : [];
  const boundedObservations = observations.slice(0, LIVE_PREVIEW_CASE_MANIFEST.length);
  const uniqueCases = new Set(boundedObservations.map(entry => entry?.caseId));
  const complete = observations.length === LIVE_PREVIEW_CASE_MANIFEST.length && uniqueCases.size === LIVE_PREVIEW_CASE_MANIFEST.length
    && LIVE_PREVIEW_CASE_MANIFEST.every(entry => uniqueCases.has(entry.caseId));
  const cases = boundedObservations.map(entry => verifyLivePreviewEvidence(entry, expectedIdentity));
  const passed = complete && cases.every(entry => entry.status === 'PASS') && cases.some(entry => entry.accepted);
  return { status: passed ? 'PASS' : 'FAIL', code: passed ? 'LIVE_BACKEND_PREVIEW_CONTRACT_PASS' : 'LIVE_BACKEND_PREVIEW_CONTRACT_FAILED',
    cases, verification: { syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' },
    remainingGaps: [...REMAINING_GAPS] };
}

/** Projection deliberately retains no answer prose, source paths, errors, credentials, or arbitrary keys. */
export function sanitizeLivePreviewEvidence(value) {
  const record = isRecord;
  const requireE2e = (condition) => { if (!condition) throw new Error('LIVE_PREVIEW_EVIDENCE_INVALID'); };
  const safeCount = count;
  const safeBoolean = item => typeof item === 'boolean' ? item : null;
  const safeEnum = (item, allowed) => allowed.includes(item) ? item : 'unobserved';
  const CASES = MANIFEST;
  const STAGES = STAGE_NAMES;
  const COUNTS = COUNT_FIELDS;
  const LIMITS = [...LIMIT_FIELDS, 'maxConcurrency', 'maxRetries'];
  requireE2e(record(value) && record(value.identity) && record(value.result) && record(value.audit)
    && record(value.stages) && record(value.usage), 'LIVE_PREVIEW_EVIDENCE_INVALID');
  const identity = value.identity;
  requireE2e(/^[0-9a-f]{40}$/u.test(identity.sourceCommit ?? '') && identity.sourceCommit === identity.approvedSourceCommit
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identity.deploymentId ?? '')
    && identity.mode === LIVE_PREVIEW_MODE && /^[a-z][a-z0-9_-]{0,63}$/u.test(identity.moduleId ?? '')
    && value.acceptanceProfile === LIVE_PREVIEW_ACCEPTANCE_PROFILE && CASES.has(value.caseId), 'LIVE_PREVIEW_EVIDENCE_INVALID');
  const result = value.result;
  requireE2e(Array.isArray(result.sources) && result.sources.length <= 8
    && Array.isArray(result.citationIndices) && result.citationIndices.length <= 32,
  'LIVE_PREVIEW_EVIDENCE_INVALID');
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

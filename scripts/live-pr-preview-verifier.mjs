import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import answerFindingCodes from '../src/shared/gaming/gamingClearAnswerFindingCodes.json' with { type: 'json' };
import citationSyntax from '../src/shared/gaming/gamingCitationSyntax.json' with { type: 'json' };

export const LIVE_PREVIEW_MODE = 'live-backend-v1';
export const LIVE_PREVIEW_ACCEPTANCE_PROFILE = 'grounded-audited-answer-v1';
export const LIVE_PREVIEW_PRESENTATION_PROFILE = 'grounded-presented-answer-v2';
export const LIVE_PREVIEW_PRESENTATION_POLICY = 'gaming-clear-presentation/v1';
const STAGE_NAMES = Object.freeze(['authorization', 'budget', 'source_acquisition', 'source_validation', 'generation', 'answer_audit', 'delivery']);
const STAGE_STATUSES = new Set(['not_run', 'passed', 'rejected', 'failed', 'timed_out', 'exhausted']);
const AUDIT_STATUSES = new Set(['completed', 'unavailable', 'not_run']);
const AUDIT_DECISIONS = new Set(['accept', 'partial', 'reject', 'clarify', 'unavailable']);
const MAX_AUDIT_FINDINGS = 32;
const NUMERIC_CITATION = new RegExp(citationSyntax.numericReferencePattern, 'giu');
// Model finding strings are untrusted even when they match the CLEAR code syntax.
const AUDIT_REJECTION_FINDING_CODES = new Set([
  ...answerFindingCodes.blocking, ...answerFindingCodes.policy, answerFindingCodes.other
]);
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
function caseExpectation(caseId, presentation) {
  const expected = MANIFEST.get(caseId);
  if (!presentation) return expected;
  if (caseId === 'useful_grounded_guide') return { ...expected, provider: 'generation_only',
    stages: { ...expected.stages, answer_audit: 'not_run' } };
  return caseId === 'audit_timeout' ? undefined : expected;
}
const FAILURE_CODES = new Set(LIVE_PREVIEW_CASE_MANIFEST.map(entry => entry.failureCode).filter(Boolean));
const REMAINING_GAPS = Object.freeze(['installed_plugin_oauth_unverified', 'chatgpt_consent_unverified', 'chatgpt_refresh_unverified', 'installed_plugin_acceptance_unverified', 'provider_billing_reconciliation_unverified', 'trusted_live_execution_provenance_required']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positiveLimit = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const boundedEnum = (value, allowed, otherwise) => allowed.has(value) ? value : otherwise;

/** Keep rejection counts and reviewed labels without forwarding model codes or evidence references. */
export function sanitizeLiveValidationAuditRejection(value, codeSource) {
  if (!isRecord(value)) return undefined;
  const { blockingFindingCount, findingCodes, findingCounts, unmappedFindingCount } = value;
  if (!Number.isSafeInteger(blockingFindingCount) || blockingFindingCount < 1
    || blockingFindingCount > MAX_AUDIT_FINDINGS || !Array.isArray(findingCodes)
    || findingCodes.length < 1 || findingCodes.length > blockingFindingCount) return undefined;
  const occurrences = new Map();
  let unmapped = 0;
  for (const code of findingCodes) {
    if (typeof code !== 'string' || code.length < 1 || code.length > 80) return undefined;
    const label = AUDIT_REJECTION_FINDING_CODES.has(code) ? code : answerFindingCodes.other;
    if (label !== code) unmapped++;
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  const labels = [...occurrences.keys()].sort();
  const summary = { findingCodes: labels, blockingFindingCount };
  if (findingCodes.length === blockingFindingCount && !Object.hasOwn(value, 'findingCounts')) {
    return { ...summary, findingCounts: Object.fromEntries(labels.map(label => [label, occurrences.get(label)])),
      // Only original assessment codes can distinguish an explicit fallback from a mapped code.
      ...(codeSource === 'assessment' && occurrences.has(answerFindingCodes.other) ? { unmappedFindingCount: unmapped } : {}) };
  }
  // The controller receives deduplicated labels. Older receipts have no recoverable counts.
  if (findingCodes.length === labels.length && findingCodes.every(code => occurrences.has(code))
    && isRecord(findingCounts) && Object.keys(findingCounts).length === labels.length
    && labels.every(label => Object.hasOwn(findingCounts, label) && Number.isSafeInteger(findingCounts[label])
      && findingCounts[label] >= 1 && findingCounts[label] <= blockingFindingCount)
    && labels.reduce((total, label) => total + findingCounts[label], 0) === blockingFindingCount) {
    return { ...summary, findingCounts: Object.fromEntries(labels.map(label => [label, findingCounts[label]])),
      ...(occurrences.has(answerFindingCodes.other) && Object.hasOwn(value, 'unmappedFindingCount')
        && Number.isSafeInteger(unmappedFindingCount) && unmappedFindingCount >= 0
        && unmappedFindingCount <= findingCounts[answerFindingCodes.other] ? { unmappedFindingCount } : {}) };
  }
  return summary;
}

const AUDIT_PROVIDER_RESULT_CLASSES = new Set(['complete', 'provider_incomplete', 'unexpected_finish', 'commentary_only', 'unsupported_output',
  'missing_content', 'oversized_content', 'malformed_json', 'invalid_schema']);
const AUDIT_PROVIDER_STATUSES = new Set(['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress', 'unknown']);
const AUDIT_PROVIDER_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call', 'unknown']);
const AUDIT_PROVIDER_INCOMPLETE_REASONS = new Set(['max_output_tokens', 'content_filter', 'none', 'unknown']);
const AUDIT_PROVIDER_CONTENT_LENGTH_CLASSES = new Set(['missing', 'empty', 'bounded', 'oversized']);

/** Project classification and bounded provider metadata without retaining output or changing acceptance. */
export function sanitizeLiveValidationAuditProviderDiagnostic(value, assessmentStatus) {
  if (!isRecord(value) || !['completed', 'unavailable'].includes(assessmentStatus)) return undefined;
  const { resultClass, providerStatus, finishReason, incompleteReason, truncated, contentFiltered,
    contentLengthClass, outputKind, messageStatus } = value;
  if (!AUDIT_PROVIDER_RESULT_CLASSES.has(resultClass) || (resultClass === 'complete') !== (assessmentStatus === 'completed')) return undefined;
  return { resultClass,
    ...(AUDIT_PROVIDER_STATUSES.has(providerStatus) ? { providerStatus } : {}),
    ...(AUDIT_PROVIDER_FINISH_REASONS.has(finishReason) ? { finishReason } : {}),
    ...(AUDIT_PROVIDER_INCOMPLETE_REASONS.has(incompleteReason) ? { incompleteReason } : {}),
    ...(typeof truncated === 'boolean' ? { truncated } : {}),
    ...(typeof contentFiltered === 'boolean' ? { contentFiltered } : {}),
    ...(AUDIT_PROVIDER_CONTENT_LENGTH_CLASSES.has(contentLengthClass) ? { contentLengthClass } : {}),
    ...(resultClass === 'unsupported_output' && (outputKind === 'refusal' || outputKind === 'tool_output') ? { outputKind } : {}),
    ...(resultClass === 'provider_incomplete' && (messageStatus === 'in_progress' || messageStatus === 'incomplete')
      ? { messageStatus } : {}) };
}

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

/** Match actual numeric references, preserving descriptive Markdown link labels as prose. */
export function extractLivePreviewNumericCitations(answer) {
  return [...answer.matchAll(NUMERIC_CITATION)]
    .flatMap(match => (match[1] ?? match[2])?.split(',').map(value => Number(value.trim())) ?? []);
}

export function sanitizeLivePreviewPresentation(value) {
  return isRecord(value) && value.policyVersion === LIVE_PREVIEW_PRESENTATION_POLICY && value.boundToFinalAnswer === true
    ? { policyVersion: LIVE_PREVIEW_PRESENTATION_POLICY, boundToFinalAnswer: true } : null;
}

function sanitizedResult(result, bound) {
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
  // The live profile uses numeric references to check the ordered source list.
  const references = extractLivePreviewNumericCitations(response);
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
      && bound };
}

/** The private backend supplies versioned binding and stage observations independently of the answer body. */
export function createLivePreviewEvidence(identity, { caseId, result, audit, usage, failureCode, stages: observedStages,
  acceptanceProfile = LIVE_PREVIEW_ACCEPTANCE_PROFILE, presentation } = {}) {
  const safeIdentity = requireIdentity(identity);
  const isPresentation = acceptanceProfile === LIVE_PREVIEW_PRESENTATION_PROFILE;
  if ((!isPresentation && acceptanceProfile !== LIVE_PREVIEW_ACCEPTANCE_PROFILE) || !caseExpectation(caseId, isPresentation)) {
    throw new Error('LIVE_PREVIEW_CASE_INVALID');
  }
  const observedAudit = isRecord(audit) ? audit : {};
  const safeAudit = { assessmentStatus: boundedEnum(observedAudit.assessmentStatus, AUDIT_STATUSES, 'unobserved'),
    decision: boundedEnum(observedAudit.decision, AUDIT_DECISIONS, 'unobserved'), boundToFinalAnswer: observedAudit.boundToFinalAnswer === true };
  const observations = isRecord(observedStages) ? observedStages : {};
  const safePresentation = sanitizeLivePreviewPresentation(presentation);
  const bound = isPresentation ? safePresentation !== null
    : safeAudit.assessmentStatus === 'completed' && safeAudit.decision === 'accept' && safeAudit.boundToFinalAnswer;
  return { schemaVersion: isPresentation ? 2 : 1, acceptanceProfile, identity: safeIdentity, caseId,
    failureCode: failureCode === undefined || failureCode === null ? null : boundedEnum(failureCode, FAILURE_CODES, 'UNOBSERVED_FAILURE'),
    stages: Object.fromEntries(STAGE_NAMES.map(name => [name, boundedEnum(observations[name], STAGE_STATUSES, 'unobserved')])),
    result: sanitizedResult(result, bound), ...(isPresentation ? { presentation: safePresentation } : { audit: safeAudit }),
    usage: sanitizedUsage(usage),
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
  const isPresentation = value.acceptanceProfile === LIVE_PREVIEW_PRESENTATION_PROFILE;
  const expected = caseExpectation(value.caseId, isPresentation);
  const identity = value.identity;
  const observations = isRecord(value.stages) ? value.stages : {};
  const result = isRecord(value.result) ? value.result : {};
  const audit = isRecord(value.audit) ? value.audit : {};
  const usage = isRecord(value.usage) ? value.usage : {};
  const checks = [];
  const check = (id, passed) => checks.push({ id, status: passed ? 'PASS' : 'FAIL' });
  check('schema', isPresentation ? value.schemaVersion === 2 && !Object.hasOwn(value, 'audit') : value.schemaVersion === 1);
  check('reviewed_acceptance_profile', isPresentation || value.acceptanceProfile === LIVE_PREVIEW_ACCEPTANCE_PROFILE);
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
    if (isPresentation) check('bound_presentation_integrity', sanitizeLivePreviewPresentation(value.presentation) !== null);
    else check('mandatory_bound_answer_audit', audit.assessmentStatus === 'completed' && audit.decision === 'accept' && audit.boundToFinalAnswer === true);
  } else {
    check('no_accepted_answer', result.acceptedAnswer === false && (isPresentation ? value.presentation === null
      : audit.boundToFinalAnswer === false && !(audit.assessmentStatus === 'completed' && audit.decision === 'accept')));
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
    && LIVE_PREVIEW_CASE_MANIFEST.every(entry => uniqueCases.has(entry.caseId))
    && boundedObservations.every(entry => entry?.acceptanceProfile === LIVE_PREVIEW_ACCEPTANCE_PROFILE);
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
  const STAGES = STAGE_NAMES;
  const COUNTS = COUNT_FIELDS;
  const LIMITS = [...LIMIT_FIELDS, 'maxConcurrency', 'maxRetries'];
  const isPresentation = value?.acceptanceProfile === LIVE_PREVIEW_PRESENTATION_PROFILE;
  requireE2e(record(value) && record(value.identity) && record(value.result)
    && (isPresentation ? value.schemaVersion === 2 && !Object.hasOwn(value, 'audit')
      && (value.presentation === null || sanitizeLivePreviewPresentation(value.presentation) !== null) : record(value.audit))
    && record(value.stages) && record(value.usage), 'LIVE_PREVIEW_EVIDENCE_INVALID');
  const identity = value.identity;
  requireE2e(/^[0-9a-f]{40}$/u.test(identity.sourceCommit ?? '') && identity.sourceCommit === identity.approvedSourceCommit
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identity.deploymentId ?? '')
    && identity.mode === LIVE_PREVIEW_MODE && /^[a-z][a-z0-9_-]{0,63}$/u.test(identity.moduleId ?? '')
    && (isPresentation || value.acceptanceProfile === LIVE_PREVIEW_ACCEPTANCE_PROFILE)
    && caseExpectation(value.caseId, isPresentation), 'LIVE_PREVIEW_EVIDENCE_INVALID');
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
  return { schemaVersion: value.schemaVersion === (isPresentation ? 2 : 1) ? value.schemaVersion : null,
    acceptanceProfile: value.acceptanceProfile,
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
    ...(isPresentation ? { presentation: sanitizeLivePreviewPresentation(value.presentation) } : {
      audit: { assessmentStatus: safeEnum(audit.assessmentStatus, ['completed', 'unavailable', 'not_run']),
        decision: safeEnum(audit.decision, ['accept', 'partial', 'reject', 'clarify', 'unavailable']), boundToFinalAnswer: safeBoolean(audit.boundToFinalAnswer) } }),
    usage: { ...Object.fromEntries(COUNTS.map(key => [key, safeCount(usage[key])])),
      limits: Object.fromEntries(LIMITS.map(key => [key, safeCount(usage.limits?.[key])])) },
    verification: { syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' },
    remainingGaps: ['installed_plugin_oauth_unverified', 'installed_plugin_acceptance_unverified', 'chatgpt_consent_unverified',
      'chatgpt_refresh_unverified', 'provider_billing_reconciliation_unverified', 'trusted_live_execution_provenance_required'] };
}

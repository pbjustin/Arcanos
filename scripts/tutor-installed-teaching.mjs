import path from 'node:path';
import { checkTutorPrivateBoundary } from './check-tutor-private-boundary.mjs';
import { digest, isHash, maxFileSize, readSafeFile, relativeFile, requireCondition, reviewed } from './tutor-migration.mjs';

export const installedTeachingCaseIds = Object.freeze(['DIRECT_EXPLANATION', 'DIAGNOSTIC_ASSESSMENT',
  'ADAPTIVE_REEXPLANATION', 'WORKED_EXAMPLE', 'GUIDED_HINT', 'PRACTICE_GENERATION', 'PRACTICE_FEEDBACK',
  'COMPREHENSION_CHECK', 'CONCISE_FORMAT', 'NUMBERED_FORMAT', 'DIFFICULT_OR_AMBIGUOUS_QUESTION',
  'FOLLOW_UP_CONTEXT', 'MEMORY_REQUEST', 'UNRELATED_WRITING', 'GAMING_BOUNDARY', 'BOOKER_BOUNDARY',
  'CORE_ADMIN_BOUNDARY', 'ORDINARY_TUTORING_WITHOUT_APP_REQUIREMENT']);
const deviationIds = ['DIRECT_EXPLANATION', 'CONCISE_FORMAT', 'NUMBERED_FORMAT', 'DIFFICULT_OR_AMBIGUOUS_QUESTION',
  'FOLLOW_UP_CONTEXT', 'MEMORY_REQUEST', 'UNRELATED_WRITING'];
const limits = { authoritativeBackendCalls: null, authoritativeZeroBackendCallsVerified: false,
  loadedSkillBytesPerTurnVerified: false, zeroOverallToolActivityClaimed: false, exactPlannedParityBindingEligible: false };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const closed = (value, keys, code) => requireCondition(value && typeof value === 'object' && !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...keys].sort()), code);
function artifact(value) {
  closed(value, ['path', 'sha256', 'sizeBytes'], 'INSTALLED_TEACHING_ARTIFACT_INVALID');
  relativeFile(value.path);
  requireCondition(isHash(value.sha256) && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 &&
    value.sizeBytes <= maxFileSize, 'INSTALLED_TEACHING_ARTIFACT_INVALID');
}
const releaseBinding = release => ({ pluginId: release?.pluginId, releaseId: release?.releaseId,
  version: release?.version, skillSha256: release?.approvedSkillSha256, packageFingerprint: release?.capture?.packageFingerprint,
  visibility: release?.visibility });

export function installedTeachingBinding(record) {
  return { ...record.release, verificationFingerprint: digest(JSON.stringify({ kind: record.kind,
    evidenceBasis: record.evidenceBasis, inputs: record.inputs, cases: record.cases, limits: record.limits })) };
}

/** This attests to reviewed captured UI, never server telemetry or exact runtime bytes. */
export function validateInstalledTutorTeaching(record, { release, evidence, state }) {
  closed(record, ['schemaVersion', 'kind', 'status', 'evidenceBasis', 'release', 'inputs', 'cases', 'limits', 'review'],
    'INSTALLED_TEACHING_FIELDS_INVALID');
  requireCondition(record.schemaVersion === 1 && record.kind === 'CURRENT_RELEASE_SKILL_ONLY_18' &&
    record.status === 'VERIFIED' && record.evidenceBasis === 'COMPLETE_CAPTURED_VISIBLE_UI', 'INSTALLED_TEACHING_SCOPE_INVALID');
  closed(record.release, ['pluginId', 'releaseId', 'version', 'skillSha256', 'packageFingerprint', 'visibility'],
    'INSTALLED_TEACHING_RELEASE_INVALID');
  requireCondition(same(record.release, releaseBinding(release)) && release?.status === 'VERIFIED' &&
    release.pluginId === 'plugin_d292d1e45ae08191b3911299e30e1a25' && release.version === '0.8.5' &&
    release.visibility === 'PRIVATE' && isHash(record.release.skillSha256) && isHash(record.release.packageFingerprint),
    'INSTALLED_TEACHING_RELEASE_STALE');
  closed(record.inputs, ['plan', 'attempts', 'observations', 'contentReview', 'routingReview'], 'INSTALLED_TEACHING_INPUTS_INVALID');
  Object.values(record.inputs).forEach(artifact);
  requireCondition(same(record.limits, limits), 'INSTALLED_TEACHING_ASSURANCE_OVERCLAIM');
  requireCondition(Array.isArray(record.cases) && same(record.cases.map(row => row.id), installedTeachingCaseIds),
    'INSTALLED_TEACHING_CASE_COVERAGE_INVALID');
  for (const row of record.cases) {
    closed(row, ['id', 'actualPromptSha256', 'plannedPromptSha256', 'planDeviation', 'contextCaseId', 'selection',
      'submissionCount', 'contentResult', 'formatResult', 'contentGradedAgainst', 'completedVisibleTurn',
      'visibleArcanosBackendCalls', 'sourceAttribution', 'otherVisibleHostActivity', 'submittedCapture', 'finalCapture',
      'responses', 'routingResult'], 'INSTALLED_TEACHING_CASE_FIELDS_INVALID');
    requireCondition(isHash(row.actualPromptSha256) && isHash(row.plannedPromptSha256) &&
      row.planDeviation === (row.actualPromptSha256 !== row.plannedPromptSha256) &&
      row.planDeviation === deviationIds.includes(row.id) && row.submissionCount === 1 &&
      row.contentResult === 'PASS' && row.formatResult === 'PASS' && row.contentGradedAgainst === 'ACTUAL_SUBMITTED_PROMPT' &&
      row.completedVisibleTurn === true && row.visibleArcanosBackendCalls === 0 && row.routingResult === 'PASS_VISIBLE_UI',
      'INSTALLED_TEACHING_CASE_NOT_PASSED');
    requireCondition(row.contextCaseId === (row.id === 'ADAPTIVE_REEXPLANATION' ? 'DIRECT_EXPLANATION' :
      row.id === 'FOLLOW_UP_CONTEXT' ? 'WORKED_EXAMPLE' : null), 'INSTALLED_TEACHING_CONTEXT_INVALID');
    const unrelated = row.id === 'UNRELATED_WRITING';
    requireCondition(row.selection === (unrelated ? 'UNSELECTED' : 'PLUGIN') &&
      row.sourceAttribution === (unrelated ? 'UNSELECTED_NO_VISIBLE_SOURCES' : 'POSITIVE_SOURCES_MARKER') &&
      same(row.otherVisibleHostActivity, row.id === 'MEMORY_REQUEST' ? ['MEMORY_UPDATED'] : []),
      'INSTALLED_TEACHING_ATTRIBUTION_INVALID');
    artifact(row.submittedCapture);
    artifact(row.finalCapture);
    requireCondition(Array.isArray(row.responses) && row.responses.length === (row.id === 'PRACTICE_GENERATION' ? 2 : 1),
      'INSTALLED_TEACHING_VARIANTS_INVALID');
    row.responses.forEach(artifact);
  }
  const artifacts = [...Object.values(record.inputs), ...record.cases.flatMap(row =>
    [row.submittedCapture, row.finalCapture, ...row.responses])];
  requireCondition(new Set(artifacts.map(item => item.path)).size === artifacts.length, 'INSTALLED_TEACHING_ARTIFACT_REUSED');
  closed(record.review, ['reviewedBy', 'reviewedAt', 'evidenceIds'], 'INSTALLED_TEACHING_REVIEW_INVALID');
  requireCondition(reviewed(record.review) && Array.isArray(record.review.evidenceIds) && record.review.evidenceIds.length > 0 &&
    new Set(record.review.evidenceIds).size === record.review.evidenceIds.length, 'INSTALLED_TEACHING_REVIEW_INVALID');
  const binding = installedTeachingBinding(record);
  for (const id of record.review.evidenceIds) {
    const item = evidence.get(id);
    requireCondition(item?.kind === 'chatgpt' && item.status === 'VERIFIED' &&
      same(item.installedTeachingBinding, binding), 'INSTALLED_TEACHING_REVIEW_BINDING_INVALID');
  }
  if (state.gates.TUTOR_SKILL_BEHAVIOR_VERIFIED.status === 'VERIFIED') requireCondition(
    same(state.gates.TUTOR_SKILL_BEHAVIOR_VERIFIED.evidenceIds, record.review.evidenceIds), 'INSTALLED_TEACHING_GATE_MISMATCH');
  return { teachingVerified: true, evidenceBasis: record.evidenceBasis, caseCount: 18, responseVariantCount: 19,
    contentPasses: 18, positiveSourceCases: 17, plannedPromptDeviations: 7, visibleArcanosBackendCalls: 0,
    ...limits, verificationFingerprint: binding.verificationFingerprint };
}

/** Independently hash retained artifacts and cross-check both review records against actual attempts. */
export async function inspectInstalledTutorTeaching({ inputRoot, record, release, evidence, state }) {
  const result = validateInstalledTutorTeaching(record, { release, evidence, state });
  await checkTutorPrivateBoundary(inputRoot);
  const inspect = async expected => {
    const actual = await readSafeFile(inputRoot, expected.path);
    requireCondition(actual.sha256 === expected.sha256 && actual.sizeBytes === expected.sizeBytes,
      'INSTALLED_TEACHING_ARTIFACT_CHANGED');
    return actual;
  };
  const inputs = {};
  for (const [key, reference] of Object.entries(record.inputs)) inputs[key] = JSON.parse((await inspect(reference)).content);
  const { plan, attempts, observations, contentReview, routingReview } = inputs;
  const unique = (rows, key) => Array.isArray(rows) && rows.length === 18 &&
    new Set(rows.map(row => row[key])).size === 18 && rows.every(row => installedTeachingCaseIds.includes(row[key]));
  requireCondition(plan.scope === record.kind && plan.attemptsPerCase === 1 && unique(plan.cases, 'id') &&
    unique(attempts, 'id') && Array.isArray(observations) &&
    unique(observations.filter(row => installedTeachingCaseIds.includes(row.id)), 'id') &&
    unique(contentReview.cases, 'id') && unique(routingReview.cases, 'caseId'), 'INSTALLED_TEACHING_PRIVATE_COVERAGE_INVALID');
  requireCondition(contentReview.releaseId === release.releaseId && contentReview.version === release.version &&
    contentReview.skillSha256 === release.approvedSkillSha256 && contentReview.scope === 'CONTENT_AND_CAPTURE_REVIEW_ONLY' &&
    routingReview.verdict === 'PASS_VISIBLE_UI' && routingReview.observedCaseCount === 18 &&
    routingReview.submissionCount === 18 && routingReview.positiveSkillSourceCases === 17 &&
    routingReview.visibleArcanosBackendCallCount === 0 && routingReview.authoritativeBackendCallCount === null &&
    routingReview.authoritativeZeroBackendCallsVerified === false && routingReview.unexpectedArcanosInvocationObserved === false,
    'INSTALLED_TEACHING_PRIVATE_REVIEW_INVALID');
  for (const key of ['plan', 'attempts', 'observations']) requireCondition(routingReview.inputRecords?.some(input =>
    input.path === path.posix.basename(record.inputs[key].path) && input.sha256 === record.inputs[key].sha256 &&
    input.sizeBytes === record.inputs[key].sizeBytes), 'INSTALLED_TEACHING_ROUTING_INPUT_STALE');
  for (const row of record.cases) {
    const p = plan.cases.find(item => item.id === row.id);
    const a = attempts.find(item => item.id === row.id);
    const o = observations.find(item => item.id === row.id);
    const c = contentReview.cases.find(item => item.id === row.id);
    const r = routingReview.cases.find(item => item.caseId === row.id);
    const responseHashes = o.variants ? o.variants.map(item => item.responseSha256) : [o.responseSha256];
    const contentHashes = c.variantResponseSha256 ?? [c.responseSha256];
    requireCondition(digest(p.prompt) === row.plannedPromptSha256 && digest(a.prompt) === row.actualPromptSha256 &&
      a.promptSha256 === row.actualPromptSha256 && a.contextCaseId === row.contextCaseId && p.contextCaseId === row.contextCaseId &&
      (p.selection === 'NONE' ? 'UNSELECTED' : p.selection) === row.selection && p.expectedBackendCalls === 0 &&
      c.contentResult === 'PASS' && c.formatStatus === 'PASS' &&
      c.contentGradedAgainst === 'ACTUAL_SUBMITTED_PROMPT' && c.exactPlannedParityBindingEligible === false &&
      c.authoritativeBackendCalls === null && c.actualSubmittedPromptSha256 === row.actualPromptSha256 &&
      c.plannedPromptSha256 === row.plannedPromptSha256 && c.planStatus === (row.planDeviation ? 'DEVIATION' : 'AS_PLANNED') &&
      c.submittedCaptureSha256 === row.submittedCapture.sha256 && c.finalCaptureSha256 === row.finalCapture.sha256 &&
      same(contentHashes, row.responses.map(item => item.sha256)) && same(responseHashes, contentHashes) &&
      o.snapshotSha256 === row.finalCapture.sha256 && o.sourceSkillConfirmed === (row.id !== 'UNRELATED_WRITING') &&
      r.submissionCount === 1 && r.actualPromptSha256 === row.actualPromptSha256 && r.plannedPromptSha256 === row.plannedPromptSha256 &&
      r.exactPlannedPromptExecuted === !row.planDeviation && r.completedVisibleTurn === true && r.visibleArcanosBackendCalls === 0 &&
      r.skillSourceVisible === (row.id !== 'UNRELATED_WRITING') && same(r.otherVisibleHostActivity, row.otherVisibleHostActivity) &&
      r.routingVerdict === row.routingResult && r.snapshot.sha256 === row.finalCapture.sha256 &&
      r.snapshot.sizeBytes === row.finalCapture.sizeBytes && path.posix.basename(row.finalCapture.path) === r.snapshot.path,
      'INSTALLED_TEACHING_PRIVATE_BINDING_MISMATCH');
    if (row.id === 'DIAGNOSTIC_ASSESSMENT') requireCondition(c.focusedQuestionTaskCount === 1 && c.noStackedAlternatives === true,
      'INSTALLED_TEACHING_DIAGNOSTIC_CONTRACT_FAILED');
    for (const reference of [row.submittedCapture, row.finalCapture, ...row.responses]) await inspect(reference);
  }
  return { ...result, artifactInspection: 'PASS', inspectedArtifactCount: 60, privacyBoundary: 'PASS' };
}

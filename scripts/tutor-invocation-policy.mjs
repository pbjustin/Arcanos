// Repository reference decisions over supplied semantic facts. This is not a
// natural-language classifier, an installed skill, or evidence of model behavior.
export const tutorTeachingCaseIds = Object.freeze([
  'DIRECT_EXPLANATION', 'DIAGNOSTIC_ASSESSMENT', 'ADAPTIVE_REEXPLANATION',
  'WORKED_EXAMPLE', 'GUIDED_HINT', 'PRACTICE_GENERATION', 'PRACTICE_FEEDBACK',
  'COMPREHENSION_CHECK', 'CONCISE_FORMAT', 'NUMBERED_FORMAT',
  'DIFFICULT_OR_AMBIGUOUS_QUESTION', 'FOLLOW_UP_CONTEXT', 'MEMORY_REQUEST',
  'BACKEND_EXPLICIT', 'BACKEND_UNAVAILABLE', 'ORDINARY_TUTORING_WITH_APP_DISCONNECTED',
  'UNRELATED_WRITING', 'CROSS_PLUGIN_BOUNDARY'
]);
export const tutorBackendStatuses = Object.freeze([
  'AVAILABLE', 'DISABLED', 'DISCONNECTED', 'AUTHENTICATION_EXPIRED',
  'UNAVAILABLE', 'FAILED', 'TIMED_OUT', 'CANCELLED'
]);
export const tutorUnsupportedIntents = Object.freeze([
  'administration', 'memory', 'persistent_profile', 'saved_lessons',
  'source_ingestion', 'gaming', 'booker', 'core', 'operator', 'unrelated_writing'
]);
export const tutorPolicyRuleIds = Object.freeze([
  'UNSUPPORTED_SCOPE', 'NON_EDUCATIONAL_REQUEST', 'CLARIFY_BEFORE_EXECUTION',
  'ORDINARY_TEACHING_WITHOUT_APP', 'EXPLICIT_BACKEND_AVAILABLE',
  'BACKEND_FAILURE_WITH_DIRECT_HELP'
]);
const contextKeys = Object.freeze([
  'educationalIntent', 'explicitBackendIntent', 'unsupportedIntent',
  'needsClarification', 'backendStatus', 'backendAttempted'
]);
const decisionNames = Object.freeze([
  'SKILL_ONLY', 'BACKEND_REQUESTED', 'BACKEND_UNAVAILABLE_BUT_SKILL_CAN_HELP', 'UNSUPPORTED'
]);
function requireValue(condition, code) { if (!condition) throw new Error(code); }
function closedObject(value, keys, code) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key) &&
      Object.getOwnPropertyDescriptor(value, key)?.get === undefined &&
      Object.getOwnPropertyDescriptor(value, key)?.set === undefined), code);
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function strings(value) {
  return Array.isArray(value) && value.every(nonempty) && new Set(value).size === value.length;
}
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function sameList(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function reviewed(value) {
  return nonempty(value.reviewedBy) && nonempty(value.reviewedAt) && Number.isFinite(Date.parse(value.reviewedAt));
}

export function validateTutorInvocationContext(context) {
  const code = 'INVOCATION_CONTEXT_INVALID';
  closedObject(context, contextKeys, code);
  for (const key of ['educationalIntent', 'explicitBackendIntent', 'needsClarification', 'backendAttempted']) {
    requireValue(typeof context[key] === 'boolean', code);
  }
  requireValue(context.unsupportedIntent === null || tutorUnsupportedIntents.includes(context.unsupportedIntent), code);
  requireValue(tutorBackendStatuses.includes(context.backendStatus), code);
  requireValue(!['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(context.backendStatus) || context.backendAttempted, code);
  requireValue(context.backendStatus !== 'AVAILABLE' || !context.backendAttempted, code);
}

export function decideTutorInvocation(context) {
  validateTutorInvocationContext(context);
  const result = (decision, activateSkill, invokeApp, responseMode, reasonId, backendResultStatus) => ({
    decision, activateSkill, invokeApp, responseMode, reasonId, backendResultStatus,
    backendAttempted: context.backendAttempted
  });
  if (context.unsupportedIntent !== null || !context.educationalIntent) {
    return result('UNSUPPORTED', false, false, 'DECLINE_TUTOR_SCOPE',
      context.unsupportedIntent !== null ? 'UNSUPPORTED_SCOPE' : 'NON_EDUCATIONAL_REQUEST', 'NOT_REQUESTED');
  }
  if (context.explicitBackendIntent && context.backendAttempted) {
    return result('BACKEND_UNAVAILABLE_BUT_SKILL_CAN_HELP', true, false,
      context.needsClarification ? 'REPORT_NO_SUCCESSFUL_BACKEND_RESULT_AND_CLARIFY' :
        'REPORT_NO_SUCCESSFUL_BACKEND_RESULT_AND_TEACH_DIRECTLY',
      'BACKEND_FAILURE_WITH_DIRECT_HELP', 'NO_SUCCESSFUL_RESULT');
  }
  if (context.needsClarification) {
    return result('SKILL_ONLY', true, false, 'ASK_FOCUSED_CLARIFICATION',
      'CLARIFY_BEFORE_EXECUTION', 'NOT_ATTEMPTED');
  }
  if (!context.explicitBackendIntent) {
    return result('SKILL_ONLY', true, false, 'TEACH_DIRECTLY',
      'ORDINARY_TEACHING_WITHOUT_APP', 'NOT_REQUESTED');
  }
  if (context.backendStatus === 'AVAILABLE') {
    return result('BACKEND_REQUESTED', true, true, 'REQUEST_ONE_BACKEND_RESULT',
      'EXPLICIT_BACKEND_AVAILABLE', 'NOT_ATTEMPTED');
  }
  return result('BACKEND_UNAVAILABLE_BUT_SKILL_CAN_HELP', true, false,
    'REPORT_NO_SUCCESSFUL_BACKEND_RESULT_AND_TEACH_DIRECTLY',
    'BACKEND_FAILURE_WITH_DIRECT_HELP', 'NO_SUCCESSFUL_RESULT');
}

export function validateTutorInvocationPolicy(policy) {
  const code = 'INVOCATION_POLICY_INVALID';
  closedObject(policy, ['schemaVersion', 'kind', 'status', 'evidenceScope', 'description',
    'defaultTeachingDecision', 'uniqueBackendCapabilities', 'contextFields', 'backendStatuses',
    'unsupportedIntents', 'ruleIds', 'backendTool', 'failurePolicy'], code);
  requireValue(policy.schemaVersion === 1 && policy.kind === 'tutor_invocation_reference_policy' &&
    policy.status === 'IMPLEMENTED_NOT_VERIFIED' && policy.evidenceScope === 'REPOSITORY_REFERENCE_CONTRACT' &&
    nonempty(policy.description) && policy.defaultTeachingDecision === 'SKILL_ONLY', code);
  requireValue(Array.isArray(policy.uniqueBackendCapabilities) && policy.uniqueBackendCapabilities.length === 0, code);
  requireValue(sameList(policy.contextFields, contextKeys) && sameList(policy.backendStatuses, tutorBackendStatuses) &&
    sameList(policy.unsupportedIntents, tutorUnsupportedIntents) && sameList(policy.ruleIds, tutorPolicyRuleIds), code);
  closedObject(policy.backendTool, ['name', 'inputKeys', 'maxPromptCharacters', 'automaticRetry'], code);
  requireValue(policy.backendTool.name === 'arcanos_tutor' && sameList(policy.backendTool.inputKeys, ['prompt']) &&
    policy.backendTool.maxPromptCharacters === 8000 && policy.backendTool.automaticRetry === false, code);
  closedObject(policy.failurePolicy, ['reportNoSuccessfulBackendResult', 'allowClearlyDistinguishedDirectHelp',
    'ordinaryTeachingIndependentOfBackend', 'invokeAppMeansNewCall'], code);
  requireValue(Object.values(policy.failurePolicy).every(value => value === true), code);
}

export function validateTutorTeachingMatrix(matrix, policy) {
  validateTutorInvocationPolicy(policy);
  const code = 'TEACHING_MATRIX_INVALID';
  closedObject(matrix, ['schemaVersion', 'kind', 'baselineFingerprint', 'evidenceStatus', 'executionScope',
    'description', 'failureClassificationScope', 'cases'], code);
  requireValue(matrix.schemaVersion === 1 && matrix.kind === 'tutor_teaching_behavior_matrix' &&
    hash(matrix.baselineFingerprint) && ['UNEXECUTED', 'VERIFIED'].includes(matrix.evidenceStatus) &&
    matrix.executionScope === 'REFERENCE_DECISION_ONLY' && nonempty(matrix.description) &&
    matrix.failureClassificationScope === 'EXPECTED_CHECK_FAILURE_NOT_OBSERVED_RESULT', code);
  requireValue(Array.isArray(matrix.cases) && matrix.cases.length === tutorTeachingCaseIds.length, code);
  const ids = new Set();
  for (const row of matrix.cases) {
    closedObject(row, ['id', 'prompt', 'context', 'expectedDecision', 'expectedSkillActivation',
      'expectedAppInvocation', 'approvedRuleIds', 'baselineRuleStatus', 'ruleProvenance', 'policyRuleIds', 'outputConstraints',
      'failureClassification', 'evidenceStatus', 'actualResult', 'verification'], code);
    requireValue(tutorTeachingCaseIds.includes(row.id) && !ids.has(row.id), code);
    ids.add(row.id);
    requireValue(nonempty(row.prompt) && row.prompt.length <= 8000 && decisionNames.includes(row.expectedDecision), code);
    requireValue(strings(row.approvedRuleIds) && row.approvedRuleIds.every(id => /^instruction-section-\d{3}$/u.test(id)), code);
    requireValue(['APPROVED_SOURCE_REFERENCE', 'SEMANTIC_REVIEW_PENDING',
      'NOT_ESTABLISHED_IN_BASELINE', 'INTEGRATION_ONLY'].includes(row.baselineRuleStatus) &&
      (row.baselineRuleStatus === 'APPROVED_SOURCE_REFERENCE') === (row.approvedRuleIds.length > 0), code);
    requireValue(row.ruleProvenance === (row.approvedRuleIds.length > 0 ?
      'approved_baseline_and_integration_safeguard' : 'integration_safeguard'), code);
    requireValue(strings(row.policyRuleIds) && row.policyRuleIds.length > 0 &&
      row.policyRuleIds.every(id => tutorPolicyRuleIds.includes(id)), code);
    requireValue(strings(row.outputConstraints) && row.outputConstraints.length > 0 &&
      ['TEACHING_EXPECTATION_UNMET', 'FORMAT_EXPECTATION_UNMET', 'HONESTY_EXPECTATION_UNMET',
        'INVOCATION_POLICY_VIOLATION', 'SCOPE_BOUNDARY_VIOLATION'].includes(row.failureClassification) &&
      ['UNEXECUTED', 'VERIFIED'].includes(row.evidenceStatus), code);
    if (row.evidenceStatus === 'UNEXECUTED') {
      requireValue(row.actualResult === null && row.verification === null, code);
    } else {
      closedObject(row.verification, ['reviewedBy', 'reviewedAt', 'baselineFingerprint',
        'skillSha256', 'packageFingerprint', 'evidenceIds'], code);
      requireValue(reviewed(row.verification) && row.verification.baselineFingerprint === matrix.baselineFingerprint &&
        hash(row.verification.skillSha256) && hash(row.verification.packageFingerprint) &&
        strings(row.verification.evidenceIds) && row.verification.evidenceIds.length > 0, code);
      closedObject(row.actualResult, ['summary', 'summarySha256', 'skillActivated', 'appInvoked', 'outcome', 'artifactSha256'], code);
      requireValue(nonempty(row.actualResult.summary) && hash(row.actualResult.summarySha256) &&
        typeof row.actualResult.skillActivated === 'boolean' && typeof row.actualResult.appInvoked === 'boolean' &&
        ['PASS', 'FAIL'].includes(row.actualResult.outcome) && hash(row.actualResult.artifactSha256), code);
    }
    const decision = decideTutorInvocation(row.context);
    requireValue(row.expectedDecision === decision.decision && row.expectedSkillActivation === decision.activateSkill &&
      row.expectedAppInvocation === decision.invokeApp && row.policyRuleIds.includes(decision.reasonId), code);
  }
  requireValue(matrix.evidenceStatus !== 'VERIFIED' || matrix.cases.every(row => row.evidenceStatus === 'VERIFIED'), code);
}

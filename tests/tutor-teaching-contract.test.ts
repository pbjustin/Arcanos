import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  decideTutorInvocation, tutorBackendStatuses, tutorTeachingCaseIds, tutorUnsupportedIntents,
  validateTutorInvocationContext, validateTutorInvocationPolicy, validateTutorTeachingMatrix
} from '../scripts/tutor-invocation-policy.mjs';

const root = path.join(process.cwd(), 'integrations/arcanos-tutor');
const policy = JSON.parse(readFileSync(path.join(root, 'invocation-policy.json'), 'utf8'));
const matrix = JSON.parse(readFileSync(path.join(root, 'teaching-behavior-matrix.json'), 'utf8'));
type Json = ReturnType<typeof JSON.parse>;
const copy = (value: Json): Json => JSON.parse(JSON.stringify(value));
const ordinary = {
  educationalIntent: true,
  explicitBackendIntent: false,
  unsupportedIntent: null,
  needsClarification: false,
  backendStatus: 'AVAILABLE',
  backendAttempted: false
};

// Supplied semantic flags are test fixtures, not NLP classification. These tests
// execute no model, installed skill, backend, provider, or ChatGPT conversation.
describe('Tutor reference teaching and invocation contract (synthetic only)', () => {
  it('validates all 18 required expectations while retaining UNEXECUTED model evidence', () => {
    expect(() => validateTutorInvocationPolicy(policy)).not.toThrow();
    expect(() => validateTutorTeachingMatrix(matrix, policy)).not.toThrow();
    expect(new Set(matrix.cases.map((row: Json) => row.id))).toEqual(new Set(tutorTeachingCaseIds));
    expect(matrix.evidenceStatus).toBe('UNEXECUTED');
    expect(matrix.executionScope).toBe('REFERENCE_DECISION_ONLY');
    expect(matrix.cases.every((row: Json) => row.evidenceStatus === 'UNEXECUTED' && row.actualResult === null)).toBe(true);
  });

  it.each(matrix.cases.map((row: Json) => [row.id, row]))('checks the supplied semantic decision for %s, not generated teaching', (_id, row: Json) => {
    const result = decideTutorInvocation(row.context);
    expect(result.decision).toBe(row.expectedDecision);
    expect(result.activateSkill).toBe(row.expectedSkillActivation);
    expect(result.invokeApp).toBe(row.expectedAppInvocation);
    expect(row.policyRuleIds).toContain(result.reasonId);
    expect(row.actualResult).toBeNull();
  });

  it.each(tutorBackendStatuses)('ordinary teaching remains skill-only when the app is %s', backendStatus => {
    const backendAttempted = ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(backendStatus);
    expect(decideTutorInvocation({ ...ordinary, backendStatus, backendAttempted })).toEqual({
      decision: 'SKILL_ONLY', activateSkill: true, invokeApp: false, responseMode: 'TEACH_DIRECTLY',
      reasonId: 'ORDINARY_TEACHING_WITHOUT_APP', backendResultStatus: 'NOT_REQUESTED', backendAttempted
    });
  });

  it('requires explicit backend intent even when Tutor is selected and named in a teaching fixture', () => {
    const row = matrix.cases.find((entry: Json) => entry.id === 'DIRECT_EXPLANATION');
    expect(row.prompt).toContain('ARCANOS TUTOR');
    expect(row.context.explicitBackendIntent).toBe(false);
    expect(decideTutorInvocation(row.context).invokeApp).toBe(false);
    expect(decideTutorInvocation({ ...ordinary, explicitBackendIntent: true })).toMatchObject({
      decision: 'BACKEND_REQUESTED', invokeApp: true, backendAttempted: false,
      responseMode: 'REQUEST_ONE_BACKEND_RESULT', backendResultStatus: 'NOT_ATTEMPTED'
    });
  });

  it.each(tutorBackendStatuses.filter(status => status !== 'AVAILABLE'))('explicit backend request with %s does not trigger a retry', backendStatus => {
    const backendAttempted = ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(backendStatus);
    expect(decideTutorInvocation({ ...ordinary, explicitBackendIntent: true, backendStatus, backendAttempted })).toEqual({
      decision: 'BACKEND_UNAVAILABLE_BUT_SKILL_CAN_HELP', activateSkill: true, invokeApp: false,
      responseMode: 'REPORT_NO_SUCCESSFUL_BACKEND_RESULT_AND_TEACH_DIRECTLY',
      reasonId: 'BACKEND_FAILURE_WITH_DIRECT_HELP', backendResultStatus: 'NO_SUCCESSFUL_RESULT', backendAttempted
    });
  });

  it('distinguishes an unavailable connection from an already attempted failed backend call', () => {
    const beforeCall = decideTutorInvocation({ ...ordinary, explicitBackendIntent: true, backendStatus: 'DISCONNECTED' });
    const afterCall = decideTutorInvocation({ ...ordinary, explicitBackendIntent: true, backendStatus: 'FAILED', backendAttempted: true });
    expect(beforeCall.backendAttempted).toBe(false);
    expect(afterCall.backendAttempted).toBe(true);
    expect(beforeCall.invokeApp).toBe(false);
    expect(afterCall.invokeApp).toBe(false);
    expect(beforeCall.backendResultStatus).toBe('NO_SUCCESSFUL_RESULT');
    expect(afterCall.backendResultStatus).toBe('NO_SUCCESSFUL_RESULT');
  });

  it.each(tutorUnsupportedIntents)('never routes unsupported %s through Tutor or another app', unsupportedIntent => {
    expect(decideTutorInvocation({ ...ordinary, explicitBackendIntent: true, unsupportedIntent })).toMatchObject({
      decision: 'UNSUPPORTED', activateSkill: false, invokeApp: false,
      responseMode: 'DECLINE_TUTOR_SCOPE', reasonId: 'UNSUPPORTED_SCOPE'
    });
  });

  it('does not treat unrelated writing or an unclassified noneducational request as tutoring', () => {
    expect(decideTutorInvocation({ ...ordinary, educationalIntent: false })).toMatchObject({
      decision: 'UNSUPPORTED', activateSkill: false, invokeApp: false, reasonId: 'NON_EDUCATIONAL_REQUEST'
    });
  });

  it('clarifies missing teaching context before an otherwise explicit backend request', () => {
    expect(decideTutorInvocation({ ...ordinary, needsClarification: true, explicitBackendIntent: true })).toMatchObject({
      decision: 'SKILL_ONLY', invokeApp: false, responseMode: 'ASK_FOCUSED_CLARIFICATION'
    });
  });

  it('does not conceal an already failed backend attempt when clarification is also needed', () => {
    expect(decideTutorInvocation({ ...ordinary, explicitBackendIntent: true, needsClarification: true,
      backendStatus: 'FAILED', backendAttempted: true })).toMatchObject({
      decision: 'BACKEND_UNAVAILABLE_BUT_SKILL_CAN_HELP', invokeApp: false, backendAttempted: true,
      responseMode: 'REPORT_NO_SUCCESSFUL_BACKEND_RESULT_AND_CLARIFY', backendResultStatus: 'NO_SUCCESSFUL_RESULT'
    });
  });

  it.each([
    null, [], {}, { ...ordinary, explicitBackendIntent: 'yes' },
    { ...ordinary, backendStatus: 'UNKNOWN' }, { ...ordinary, unsupportedIntent: 'unknown_module' },
    { ...ordinary, moduleSelector: 'other' }, { ...ordinary, backendStatus: 'FAILED' },
    { ...ordinary, backendAttempted: true }, { ...ordinary, needsClarification: undefined }
  ])('fails closed for malformed semantic context %#', value => {
    expect(() => validateTutorInvocationContext(value)).toThrow('INVOCATION_CONTEXT_INVALID');
    expect(() => decideTutorInvocation(value)).toThrow('INVOCATION_CONTEXT_INVALID');
  });

  it('rejects inherited or accessor-backed semantic flags without evaluating them', () => {
    expect(() => decideTutorInvocation(Object.assign(Object.create({ injected: true }), ordinary))).toThrow('INVOCATION_CONTEXT_INVALID');
    const context = { ...ordinary };
    Object.defineProperty(context, 'explicitBackendIntent', { get() { throw new Error('GETTER_EXECUTED'); } });
    expect(() => decideTutorInvocation(context)).toThrow('INVOCATION_CONTEXT_INVALID');
  });

  it.each([
    (value: Json) => { value.uniqueBackendCapabilities = ['invented_persistent_profile']; },
    (value: Json) => { value.backendTool.inputKeys.push('module'); },
    (value: Json) => { value.backendTool.automaticRetry = true; },
    (value: Json) => { value.failurePolicy.ordinaryTeachingIndependentOfBackend = false; },
    (value: Json) => { value.status = 'VERIFIED'; },
    (value: Json) => { value.installedBehaviorVerified = true; }
  ])('rejects policy broadening or unsupported verification claims %#', mutate => {
    const altered = copy(policy);
    mutate(altered);
    expect(() => validateTutorInvocationPolicy(altered)).toThrow('INVOCATION_POLICY_INVALID');
  });

  it.each([
    (value: Json) => { value.cases.pop(); },
    (value: Json) => { value.cases[1].id = value.cases[0].id; },
    (value: Json) => { value.cases[0].id = 'UNRECOGNIZED_CASE'; },
    (value: Json) => { value.cases[0].expectedAppInvocation = true; },
    (value: Json) => { value.cases[0].evidenceStatus = 'VERIFIED'; },
    (value: Json) => { value.cases[0].actualResult = { answer: 'Synthetic result is not live proof.' }; },
    (value: Json) => { value.cases[0].approvedRuleIds = ['invented-rule']; },
    (value: Json) => { value.cases[0].approvedRuleIds = []; },
    (value: Json) => { value.cases[0].baselineRuleStatus = 'UNREVIEWED_BUT_VERIFIED'; },
    (value: Json) => { value.cases[0].privateSourceText = 'Mock unapproved source field'; },
    (value: Json) => { value.evidenceStatus = 'VERIFIED'; }
  ])('rejects incomplete matrices, wrong decisions, private fields or evidence promotion %#', mutate => {
    const altered = copy(matrix);
    mutate(altered);
    expect(() => validateTutorTeachingMatrix(altered, policy)).toThrow('TEACHING_MATRIX_INVALID');
  });

  it('allows the structure of a future reviewed observation without certifying its external evidence', () => {
    const altered = copy(matrix);
    const row = altered.cases[0];
    const summary = 'Mock reviewed teaching observation for structural validation only.';
    row.evidenceStatus = 'VERIFIED';
    row.actualResult = {
      summary, summarySha256: createHash('sha256').update(summary).digest('hex'),
      skillActivated: true, appInvoked: false, outcome: 'PASS', artifactSha256: 'a'.repeat(64)
    };
    row.verification = {
      reviewedBy: 'mock fixture reviewer', reviewedAt: '2026-09-25T00:00:00Z',
      baselineFingerprint: matrix.baselineFingerprint, skillSha256: 'b'.repeat(64),
      packageFingerprint: 'c'.repeat(64), evidenceIds: ['mock-observation']
    };
    // The package evidence validator separately checks the referenced observation,
    // exact source/artifact bindings, expected outcomes, and reviewed constraints.
    expect(() => validateTutorTeachingMatrix(altered, policy)).not.toThrow();
    row.verification.baselineFingerprint = 'd'.repeat(64);
    expect(() => validateTutorTeachingMatrix(altered, policy)).toThrow('TEACHING_MATRIX_INVALID');
    expect(matrix.cases[0].evidenceStatus).toBe('UNEXECUTED');
  });
});

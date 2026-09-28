import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installedTeachingBinding, installedTeachingCaseIds } from '../../scripts/tutor-installed-teaching.mjs';
type Json = ReturnType<typeof JSON.parse>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const deviations = ['DIRECT_EXPLANATION', 'CONCISE_FORMAT', 'NUMBERED_FORMAT', 'DIFFICULT_OR_AMBIGUOUS_QUESTION',
  'FOLLOW_UP_CONTEXT', 'MEMORY_REQUEST', 'UNRELATED_WRITING'];

/** Public synthetic review facts and captures; this never generates model behavior. */
export function installedTeachingFixture(inputRoot: string, release: Json) {
  const prefix = 'mock-current-teaching';
  mkdirSync(path.join(inputRoot, prefix), { recursive: true });
  const save = (name: string, content: string) => {
    writeFileSync(path.join(inputRoot, prefix, name), content);
    return { path: `${prefix}/${name}`, sha256: hash(content), sizeBytes: Buffer.byteLength(content) };
  };
  const json = (name: string, value: Json) => save(name, JSON.stringify(value));
  const plan: Json = { scope: 'CURRENT_RELEASE_SKILL_ONLY_18', attemptsPerCase: 1, cases: [] };
  const attempts: Json[] = [], observations: Json[] = [], contentCases: Json[] = [], routingCases: Json[] = [], cases: Json[] = [];
  for (const id of installedTeachingCaseIds) {
    const actual = `Mock actual prompt for ${id}`;
    const planned = deviations.includes(id) ? `Mock intended prompt for ${id}` : actual;
    const contextCaseId = id === 'ADAPTIVE_REEXPLANATION' ? 'DIRECT_EXPLANATION' : id === 'FOLLOW_UP_CONTEXT' ? 'WORKED_EXAMPLE' : null;
    const unrelated = id === 'UNRELATED_WRITING';
    const hostActivity = id === 'MEMORY_REQUEST' ? ['MEMORY_UPDATED'] : [];
    const submittedCapture = save(`${id}.submitted.txt`, `Mock submitted capture: ${actual}`);
    const finalCapture = save(`${id}.final.txt`, `Mock complete captured UI for ${id}`);
    const responses = Array.from({ length: id === 'PRACTICE_GENERATION' ? 2 : 1 }, (_, index) =>
      save(`${id}.response-${index + 1}.txt`, `Mock reviewed response for ${id}`));
    plan.cases.push({ id, prompt: planned, contextCaseId, selection: unrelated ? 'NONE' : 'PLUGIN', expectedBackendCalls: 0 });
    attempts.push({ id, prompt: actual, promptSha256: hash(actual), contextCaseId });
    observations.push({ id, snapshotSha256: finalCapture.sha256, sourceSkillConfirmed: !unrelated,
      ...(responses.length === 2 ? { variants: responses.map(response => ({ responseSha256: response.sha256 })) } :
        { responseSha256: responses[0].sha256 }) });
    contentCases.push({ id, contentResult: 'PASS', formatStatus: 'PASS', contentGradedAgainst: 'ACTUAL_SUBMITTED_PROMPT',
      exactPlannedParityBindingEligible: false, authoritativeBackendCalls: null,
      actualSubmittedPromptSha256: hash(actual), plannedPromptSha256: hash(planned),
      planStatus: deviations.includes(id) ? 'DEVIATION' : 'AS_PLANNED', submittedCaptureSha256: submittedCapture.sha256,
      finalCaptureSha256: finalCapture.sha256, responseSha256: responses[0].sha256,
      ...(responses.length === 2 ? { variantResponseSha256: responses.map(response => response.sha256) } : {}),
      focusedQuestionTaskCount: id === 'DIAGNOSTIC_ASSESSMENT' ? 1 : 0, noStackedAlternatives: true });
    routingCases.push({ caseId: id, submissionCount: 1, actualPromptSha256: hash(actual), plannedPromptSha256: hash(planned),
      exactPlannedPromptExecuted: !deviations.includes(id), completedVisibleTurn: true, visibleArcanosBackendCalls: 0,
      skillSourceVisible: !unrelated, otherVisibleHostActivity: hostActivity, routingVerdict: 'PASS_VISIBLE_UI',
      snapshot: { ...finalCapture, path: path.posix.basename(finalCapture.path) } });
    cases.push({ id, actualPromptSha256: hash(actual), plannedPromptSha256: hash(planned), planDeviation: deviations.includes(id),
      contextCaseId, selection: unrelated ? 'UNSELECTED' : 'PLUGIN', submissionCount: 1, contentResult: 'PASS', formatResult: 'PASS',
      contentGradedAgainst: 'ACTUAL_SUBMITTED_PROMPT', completedVisibleTurn: true, visibleArcanosBackendCalls: 0,
      sourceAttribution: unrelated ? 'UNSELECTED_NO_VISIBLE_SOURCES' : 'POSITIVE_SOURCES_MARKER', otherVisibleHostActivity: hostActivity,
      submittedCapture, finalCapture, responses, routingResult: 'PASS_VISIBLE_UI' });
  }
  const inputs: Json = { plan: json('plan.json', plan), attempts: json('attempts.json', attempts), observations: json('observations.json', observations) };
  inputs.contentReview = json('content-review.json', { releaseId: release.releaseId, version: release.version,
    skillSha256: release.approvedSkillSha256, scope: 'CONTENT_AND_CAPTURE_REVIEW_ONLY', cases: contentCases });
  inputs.routingReview = json('routing-review.json', { verdict: 'PASS_VISIBLE_UI', observedCaseCount: 18, submissionCount: 18,
    positiveSkillSourceCases: 17, visibleArcanosBackendCallCount: 0, authoritativeBackendCallCount: null,
    authoritativeZeroBackendCallsVerified: false, unexpectedArcanosInvocationObserved: false,
    inputRecords: ['plan', 'attempts', 'observations'].map(key => ({ ...inputs[key], path: path.posix.basename(inputs[key].path) })), cases: routingCases });
  const evidenceId = 'mock-installed-teaching-review';
  const record: Json = { schemaVersion: 1, kind: 'CURRENT_RELEASE_SKILL_ONLY_18', status: 'VERIFIED',
    evidenceBasis: 'COMPLETE_CAPTURED_VISIBLE_UI', release: { pluginId: release.pluginId, releaseId: release.releaseId,
      version: release.version, skillSha256: release.approvedSkillSha256, packageFingerprint: release.capture.packageFingerprint,
      visibility: release.visibility }, inputs, cases,
    limits: { authoritativeBackendCalls: null, authoritativeZeroBackendCallsVerified: false,
      loadedSkillBytesPerTurnVerified: false, zeroOverallToolActivityClaimed: false, exactPlannedParityBindingEligible: false },
    review: { reviewedBy: 'Mock independent content and routing reviewers', reviewedAt: '2026-09-26T00:00:00Z', evidenceIds: [evidenceId] } };
  const evidence: Json = { id: evidenceId, kind: 'chatgpt', status: 'VERIFIED', observedAt: record.review.reviewedAt,
    summary: 'Mock reviewed captured UI only.', installedTeachingBinding: installedTeachingBinding(record) };
  const state = { gates: { TUTOR_SKILL_BEHAVIOR_VERIFIED: { status: 'VERIFIED', evidenceIds: [evidenceId] } } };
  return { record, evidence, state, json };
}

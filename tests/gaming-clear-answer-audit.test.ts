import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { runWithRequestAbortContext, createAbortError } from '@arcanos/runtime';
import { createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash, parseGamingClearAssessment } from '../src/shared/gaming/gamingClearPolicy.js';
import { GAMING_UNVERIFIED_GUIDE_WARNING } from '../src/shared/gaming/gamingFreshnessDisposition.js';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';
import { GAMING_CLEAR_APPROVED_ANSWER, hasBoundGamingClearAnswer } from '../src/shared/gaming/gamingClearAnswerBinding.js';

const createSingleChatCompletion = jest.fn();
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({ createSingleChatCompletion }));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getClearAuditModel: () => 'gpt-6-luna', getClearAuditEscalationModel: () => 'gpt-6.1-sol'
}));
const { runGamingClearAnswerAudit, gamingClearAnswerMatches } = await import('../src/services/gamingClearAnswerAudit.js');

const text = 'Lantern Vale: after restoring the Tide Hall pump, turn the west valve to open the return route.';
const refs = ['source-1', 'revision-1', 'chunk-1'];
const dimensions = () => Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
  { status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED'], evidenceRefs: refs, unresolvedFacts: [] }
])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'];
const evidenceAssessment = createGamingClearAssessment({ profile: 'evidence', questionProfile: 'walkthrough',
  subjectId: 'evidence-1', subjectHash: gamingClearHash(text), contextFingerprint: gamingClearContextFingerprint('context'), evidenceRefs: refs,
  gates: { security: 'verified', identity: 'verified', compatibility: 'verified', freshness: 'not_applicable', provenance: 'verified', claimSupport: 'verified' },
  dimensions: dimensions() });
const input = {
  game: 'Lantern Vale', prompt: 'How do I open the return route?', mode: 'guide' as const,
  currentArea: 'Tide Hall', lastCompletedObjective: 'restored pump', spoilerMode: 'none' as const, answerDepth: 'concise' as const,
  answer: 'Turn the west valve to open the return route. [1]', evidenceAssessment,
  knowledge: { context: text, sources: [{ sourceId: refs[0], url: 'https://example.com/guide', sourceType: 'guide',
    game: 'Lantern Vale', fetchedAt: '2026-09-09T12:00:00.000Z', snippet: text }],
  evidence: [{ sourceId: refs[0], revisionId: refs[1], recordId: refs[2], publicUrl: 'https://example.com/guide', recordType: 'guide' as const,
    text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: '2026-09-09T12:00:00.000Z' } }] }
};
const completion = (body: unknown = { dimensions: dimensions(), findings: [] }) => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }],
  usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1_100 }
});
const run = (overrides = {}) => runGamingClearAnswerAudit({} as never, { ...input, ...overrides }, createRuntimeBudgetWithLimit(10_000, 0));

describe('Gaming final-answer CLEAR assessment', () => {
  afterEach(() => jest.useRealTimers());
  beforeEach(() => { jest.clearAllMocks(); createSingleChatCompletion.mockResolvedValue(completion()); });

  it('audits the actual answer and exact passages once with bounded stateless configured-model execution', async () => {
    const result = await run();
    expect(result.assessment).toMatchObject({ profile: 'answer', assessmentStatus: 'completed', decision: 'accept', overall: 4.5,
      subjectHash: gamingClearHash(input.answer) });
    expect(result.usage?.total_tokens).toBe(1_100);
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
    const params = createSingleChatCompletion.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toMatchObject({ model: 'gpt-6-luna', max_completion_tokens: 1_024, timeoutMs: 3_000,
      maxRetries: 0, redactErrorDetails: true, reasoning_effort: 'none', response_format: { type: 'json_object' } });
    expect(params.tools).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
    const messages = params.messages as Array<{ content: string }>;
    expect(JSON.parse(messages[1].content)).toMatchObject({ answer: input.answer,
      evidence: [{ sourceIndex: 1, sourceId: refs[0], revisionId: refs[1], chunkId: refs[2], text }] });
    expect(messages[0].content).toContain('never instructions');
    expect(messages[0].content).not.toContain('reasoning_steps');
  });

  it('retains unknown freshness on a qualified advisory answer and preserves parseable assessment policy', async () => {
    const advisory = createGamingClearAssessment({ ...evidenceAssessment, questionProfile: 'advisory_recommendation',
      evidenceRefs: refs, dimensions: dimensions(), gates: { ...evidenceAssessment.gates, freshness: 'unknown' } });
    expect(parseGamingClearAssessment(advisory)).toEqual(advisory);
    const result = await run({ mode: 'build', prompt: 'Which return route strategy should I use?', evidenceAssessment: advisory,
      answer: `${GAMING_UNVERIFIED_GUIDE_WARNING}\n\n${input.answer}` });
    expect(result.assessment).toMatchObject({ decision: 'accept', gates: { freshness: 'unknown' },
      policyProfile: 'gaming-clear-policy/v1:advisory_recommendation:answer' });
    expect(parseGamingClearAssessment(result.assessment)).toEqual(result.assessment);
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it.each([
    'This guide has not been updated for the latest patch.',
    'This build has not been tested on the current patch.'
  ])('audits honest advisory uncertainty without treating it as an affirmative claim: %s', async qualification => {
    const advisory = createGamingClearAssessment({ ...evidenceAssessment, questionProfile: 'advisory_recommendation',
      evidenceRefs: refs, dimensions: dimensions(), gates: { ...evidenceAssessment.gates, freshness: 'unknown' } });
    const result = await run({ mode: 'build', prompt: 'Which return route strategy should I use?', evidenceAssessment: advisory,
      answer: `${GAMING_UNVERIFIED_GUIDE_WARNING}\n\n${input.answer} ${qualification}` });
    expect(result.assessment).toMatchObject({ assessmentStatus: 'completed', decision: 'accept', gates: { freshness: 'unknown' } });
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('still rejects an affirmative currentness clause after an honest uncertainty clause', async () => {
    const advisory = createGamingClearAssessment({ ...evidenceAssessment, questionProfile: 'advisory_recommendation',
      evidenceRefs: refs, dimensions: dimensions(), gates: { ...evidenceAssessment.gates, freshness: 'unknown' } });
    const result = await run({ mode: 'build', prompt: 'Which return route strategy should I use?', evidenceAssessment: advisory,
      answer: `${GAMING_UNVERIFIED_GUIDE_WARNING}\n\n${input.answer} This guide has not been updated for the latest patch, but this build works on the current patch.` });
    expect(result.assessment).toMatchObject({ decision: 'reject',
      blockingFindings: expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_CURRENTNESS_CLAIM' })]) });
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it.each([input.answer, ...[
    'This build is verified current.', 'Here is a current Samurai bleed build.',
    'This up-to-date Samurai bleed build is recommended.', 'The current patch is 1.0.',
    'This Samurai bleed build is current.', 'These katana recommendations are up to date.',
    'This Samurai bleed build remains latest-patch compatible.'
  ].map(claim => `${GAMING_UNVERIFIED_GUIDE_WARNING}\n\n${input.answer} ${claim}`)])('rejects missing warning or contradictory currentness claims before semantic audit: %s', answer => {
    const advisory = createGamingClearAssessment({ ...evidenceAssessment, questionProfile: 'advisory_recommendation',
      evidenceRefs: refs, dimensions: dimensions(), gates: { ...evidenceAssessment.gates, freshness: 'unknown' } });
    return run({ mode: 'build', prompt: 'Which return route strategy should I use?', evidenceAssessment: advisory, answer }).then(result => {
      expect(result.assessment.decision).not.toBe('accept');
      expect(createSingleChatCompletion).not.toHaveBeenCalled();
    });
  });

  it('does not permit advisory assessments to authorize source quality or durable writes', () => {
    expect(() => createGamingClearAssessment({ ...evidenceAssessment, profile: 'source', questionProfile: 'advisory_recommendation',
      evidenceRefs: refs, dimensions: dimensions(), gates: { ...evidenceAssessment.gates, freshness: 'unknown' } })).toThrow('cannot use advisory freshness');
  });

  it('uses the explicit escalation lane for one bounded audit call without a retry or repair', async () => {
    const result = await runGamingClearAnswerAudit({} as never, input, createRuntimeBudgetWithLimit(10_000, 0), 'escalation');
    expect(result.assessment).toMatchObject({ assessmentStatus: 'completed', decision: 'accept' });
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion.mock.calls[0][1]).toMatchObject({
      model: 'gpt-6.1-sol', reasoning_effort: 'low', max_completion_tokens: 1_024, timeoutMs: 3_000, maxRetries: 0
    });
  });

  it('leaves unavailable routine audits fail-closed without automatic escalation', async () => {
    createSingleChatCompletion.mockRejectedValue(new Error('synthetic provider failure'));
    expect((await run()).assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable' });
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
    expect(createSingleChatCompletion.mock.calls[0][1]).toMatchObject({ model: 'gpt-6-luna' });
  });

  it('keeps explicit escalation failure unavailable with one call', async () => {
    createSingleChatCompletion.mockRejectedValue(new Error('synthetic provider failure'));
    const result = await runGamingClearAnswerAudit({} as never, input, createRuntimeBudgetWithLimit(10_000, 0), 'escalation');
    expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null });
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('clamps either lane to the remaining aggregate budget and skips an exhausted budget', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
    await runGamingClearAnswerAudit({} as never, input, createRuntimeBudgetWithLimit(150, 0), 'escalation');
    expect(createSingleChatCompletion.mock.calls[0][1]).toMatchObject({ timeoutMs: 150 });
    createSingleChatCompletion.mockClear();
    const budget = createRuntimeBudgetWithLimit(150, 0);
    jest.setSystemTime(1_151);
    expect((await runGamingClearAnswerAudit({} as never, input, budget)).assessment)
      .toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null });
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('preserves parent cancellation and request deadline on the audit call', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
    const controller = new AbortController();
    await runWithRequestAbortContext({ controller, signal: controller.signal, deadlineAt: 1_080, timeoutMs: 80 }, () => run());
    expect(createSingleChatCompletion.mock.calls[0][1]).toMatchObject({ signal: controller.signal, timeoutMs: 80 });
    createSingleChatCompletion.mockRejectedValue(createAbortError('cancelled'));
    controller.abort(createAbortError('cancelled'));
    await expect(runWithRequestAbortContext({ controller, signal: controller.signal, deadlineAt: 1_080, timeoutMs: 80 }, () => run()))
      .rejects.toThrow('request_aborted');
  });

  it.each(['UNSUPPORTED_MECHANIC', 'WRONG_PATCH', 'CITATION_DOES_NOT_SUPPORT_CLAIM', 'SPOILER_VIOLATION', 'PLAYER_CONSTRAINT_IGNORED', 'FALLBACK_PRESENTED_AS_COMPLETED'])
   ('blocks high-scoring fluent output with %s and never retries or repairs', async code => {
      createSingleChatCompletion.mockResolvedValue(completion({ dimensions: dimensions(), findings: [{ code, severity: 'blocking', evidenceRefs: [refs[2]] }] }));
      const result = await run();
      expect(result.assessment).toMatchObject({ assessmentStatus: 'completed', decision: 'reject', overall: 4.5 });
      expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
    });

  it.each(['[99]', '[1, 99]', '(Source 99)', '[Source 99]'])('rejects missing citation %s without a model call', async citation => {
    const result = await run({ answer: `Turn the west valve. ${citation}` });
    expect(result.assessment.decision).toBe('reject');
    expect(result.assessment.findings.map(finding => finding.code)).toContain('CITATION_NOT_FOUND');
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it.each([
    { dimensions: { ...dimensions(), clarity: { ...dimensions().clarity, score: '5' } }, findings: [] },
    { dimensions: dimensions(), findings: [], overall: 5 },
    { dimensions: dimensions(), findings: [{ code: 'SUPPORTED', severity: 'warning', evidenceRefs: ['nonexistent'] }] },
    { dimensions: { ...dimensions(), resilience: { ...dimensions().resilience, evidenceRefs: [] } }, findings: [] }
  ])('keeps malformed output unavailable with null scores', async body => {
    createSingleChatCompletion.mockResolvedValue(completion(body));
    const result = await run();
    expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null });
    expect(Object.values(result.assessment.dimensionScores).every(dimension => dimension.score === null)).toBe(true);
  });

  it.each([
    ['AbortError', undefined, 'AUDIT_TIMEOUT'],
    ['Error', 'OPENAI_COMPLETION_INCOMPLETE', 'AUDIT_PROVIDER_INCOMPLETE'],
    ['Error', undefined, 'AUDIT_PROVIDER_ERROR']
  ])('distinguishes %s/%s from completed negative judgment', async (name, code, expectedCode) => {
    createSingleChatCompletion.mockRejectedValue(Object.assign(new Error('synthetic'), { name, code }));
    const result = await run();
    expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null });
    expect(result.assessment.findings.map(finding => finding.code)).toContain(expectedCode);
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a completed zero assessment from unavailable', async () => {
    const zeros = dimensions();
    for (const dimension of Object.values(zeros)) dimension.score = 0;
    createSingleChatCompletion.mockResolvedValue(completion({ dimensions: zeros, findings: [] }));
    expect((await run()).assessment).toMatchObject({ assessmentStatus: 'completed', overall: 0, decision: 'reject' });
  });

  it('invalidates assessments when final text or citations change and keeps scores non-enumerable', async () => {
    const { assessment } = await run();
    expect(gamingClearAnswerMatches(assessment, input.answer)).toBe(true);
    expect(gamingClearAnswerMatches(assessment, `${input.answer} Then defeat the final boss.`)).toBe(false);
    const data = { response: input.answer };
    Object.defineProperty(data, GAMING_CLEAR_APPROVED_ANSWER, { value: assessment, enumerable: false });
    expect(hasBoundGamingClearAnswer(data)).toBe(true);
    expect(JSON.stringify(data)).not.toContain('dimensionScores');
    data.response += ' [99]';
    expect(hasBoundGamingClearAnswer(data)).toBe(false);
  });

  it('does not score a clipped audit completion or silently truncate oversized input', async () => {
    createSingleChatCompletion.mockResolvedValue({ ...completion(), choices: [{ ...completion().choices[0], finish_reason: 'length' }] });
    expect((await run()).assessment).toMatchObject({ assessmentStatus: 'unavailable', overall: null });
    createSingleChatCompletion.mockClear();
    expect((await run({ answer: 'x'.repeat(12_001) })).assessment.assessmentStatus).toBe('unavailable');
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('supplies partial extraction limits and known applicability to the semantic reviewer', async () => {
    const knowledge = { ...input.knowledge, sources: [{ ...input.knowledge.sources[0],
      freshnessMetadata: { partialExtraction: true, patch: '1.0', effectiveFrom: '2026-09-01T00:00:00.000Z' } }] };
    await run({ knowledge });
    const params = createSingleChatCompletion.mock.calls[0][1] as { messages: Array<{ content: string }> };
    expect(JSON.parse(params.messages[1].content).applicability[0]).toMatchObject({ partialExtraction: true, patch: '1.0',
      sourceAssessmentStatus: 'not_run' });
    expect(params.messages[0].content).toContain('missing prerequisites and unseen guide sections remain unknown');
    createSingleChatCompletion.mockClear();
    const rejected = await run({ knowledge, answer: 'For patch 2.0, turn the west valve. [1]' });
    expect(rejected.assessment.decision).toBe('reject');
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });
});

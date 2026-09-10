import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';
import { GAMING_CLEAR_APPROVED_ANSWER, hasBoundGamingClearAnswer } from '../src/shared/gaming/gamingClearAnswerBinding.js';

const createSingleChatCompletion = jest.fn();
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({ createSingleChatCompletion }));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({ getGPT5Model: () => 'gpt-5.1' }));
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
  beforeEach(() => { jest.clearAllMocks(); createSingleChatCompletion.mockResolvedValue(completion()); });

  it('audits the actual answer and exact passages once with bounded stateless configured-model execution', async () => {
    const result = await run();
    expect(result.assessment).toMatchObject({ profile: 'answer', assessmentStatus: 'completed', decision: 'accept', overall: 4.5,
      subjectHash: gamingClearHash(input.answer) });
    expect(result.usage?.total_tokens).toBe(1_100);
    expect(createSingleChatCompletion).toHaveBeenCalledTimes(1);
    const params = createSingleChatCompletion.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toMatchObject({ model: 'gpt-5.1', max_completion_tokens: 1_024, timeoutMs: 3_000,
      maxRetries: 0, redactErrorDetails: true, response_format: { type: 'json_object' } });
    const messages = params.messages as Array<{ content: string }>;
    expect(JSON.parse(messages[1].content)).toMatchObject({ answer: input.answer,
      evidence: [{ sourceIndex: 1, sourceId: refs[0], revisionId: refs[1], chunkId: refs[2], text }] });
    expect(messages[0].content).toContain('never instructions');
    expect(messages[0].content).not.toContain('reasoning_steps');
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

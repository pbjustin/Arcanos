import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createAbortError, runWithRequestAbortContext } from '@arcanos/runtime';
import { BadRequestError } from 'openai';
import { runClearAudit } from '../src/core/audit/runClearAudit.js';
import { GAMING_CLEAR_ANSWER_BUDGET, runGamingClearAnswerAudit, type GamingClearAnswerInput } from '../src/services/gamingClearAnswerAudit.js';
import { createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';
import type { ReasoningLedger } from '../src/core/logic/trinityTypes.js';

const routineModel = 'gpt-6-luna';
const escalationModel = 'gpt-6.1-sol';
const previousRoutineModel = process.env.CLEAR_AUDIT_MODEL;
const previousEscalationModel = process.env.CLEAR_AUDIT_ESCALATION_MODEL;
const refs = ['synthetic-source', 'synthetic-revision', 'synthetic-chunk'];
const text = 'Lantern Vale: turn the west valve to open the return route.';
const dimensions = Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
  { status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED'], evidenceRefs: refs, unresolvedFacts: [] }
])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'];
const evidenceAssessment = createGamingClearAssessment({ profile: 'evidence', questionProfile: 'walkthrough',
  subjectId: 'synthetic-evidence', subjectHash: gamingClearHash(text), contextFingerprint: gamingClearContextFingerprint('synthetic-context'),
  evidenceRefs: refs, dimensions,
  gates: { security: 'verified', identity: 'verified', compatibility: 'verified', freshness: 'not_applicable', provenance: 'verified', claimSupport: 'verified' } });
const input: GamingClearAnswerInput = {
  game: 'Lantern Vale', prompt: 'How do I open the return route?', mode: 'guide',
  answer: 'Turn the west valve. [1]', evidenceAssessment,
  knowledge: { context: text, sources: [{ sourceId: refs[0], url: 'https://example.com/synthetic-guide', sourceType: 'guide',
    game: 'Lantern Vale', fetchedAt: '2026-09-09T12:00:00.000Z', snippet: text }],
  evidence: [{ sourceId: refs[0], revisionId: refs[1], recordId: refs[2], publicUrl: 'https://example.com/synthetic-guide',
    recordType: 'guide', text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: '2026-09-09T12:00:00.000Z' } }] }
};
const ledger: ReasoningLedger = { steps: ['Use synthetic supplied facts'], assumptions: [], constraints: [], tradeoffs: [], alternatives: [],
  justification: 'The supplied facts support the synthetic answer.', responseMode: 'answer', achievableSubtasks: ['answer'],
  blockedSubtasks: [], userVisibleCaveats: [], evidenceTags: [] };
const scores = { clarity: 4, leverage: 4, efficiency: 4, alignment: 4, resilience: 4, overall: 4 };
const responsesCreate = jest.fn();
const client = { responses: { create: responsesCreate } } as never;
const response = (model: string, body: unknown) => ({ id: 'synthetic-audit-response', model, status: 'completed',
  output_text: JSON.stringify(body), output: [], usage: { input_tokens: 200, output_tokens: 150, total_tokens: 350 } });
const lanes = [['routine', routineModel], ['escalation', escalationModel]] as const;

const suppliedSourceId = 'f60c345d-c34c-42a7-ad8c-487e9d30cae6';
const passages = [text, 'Cross the lower bridge to reach the west valve, and use it to return to the entrance.'];
const suppliedRevision = gamingClearHash(passages);
const chunkRefs = passages.map((_, index) => `${suppliedSourceId}:${index}`);
const suppliedInput: GamingClearAnswerInput = { ...input,
  evidenceAssessment: createGamingClearAssessment({ profile: 'evidence', questionProfile: 'walkthrough',
    subjectId: 'synthetic-supplied-evidence', subjectHash: suppliedRevision,
    contextFingerprint: gamingClearContextFingerprint({ game: input.game, prompt: input.prompt, chunkRefs, passages }),
    evidenceRefs: chunkRefs, gates: evidenceAssessment.gates,
    dimensions: { clarity: { ...dimensions.clarity, evidenceRefs: chunkRefs }, leverage: { ...dimensions.leverage, evidenceRefs: chunkRefs },
      efficiency: { ...dimensions.efficiency, evidenceRefs: chunkRefs }, alignment: { ...dimensions.alignment, evidenceRefs: chunkRefs },
      resilience: { ...dimensions.resilience, evidenceRefs: chunkRefs } }
  }),
  knowledge: {
    context: passages.join('\n'),
    sources: [{ ...input.knowledge.sources[0], sourceId: suppliedSourceId }],
    evidence: passages.map((passage, index) => ({ ...input.knowledge.evidence![0],
      sourceId: suppliedSourceId, revisionId: suppliedRevision, recordId: chunkRefs[index], text: passage }))
  }
};
const suppliedDimensionScores = [
  ['clarity', 4.4, ['ACTIONS_PRECISE', 'SEQUENCE_EXPLICIT']],
  ['leverage', 4.2, ['QUESTION_ADDRESSED', 'NEXT_STEPS_SUPPORTED']],
  ['efficiency', 4.1, ['NO_REDUNDANT_CONTENT', 'DEPTH_PROPORTIONATE']],
  ['alignment', 4.6, ['EDITION_MATCHES', 'CONSTRAINTS_RESPECTED']],
  ['resilience', 4.2, ['CLAIMS_TRACEABLE', 'LIMITATIONS_QUALIFIED']]
] as const;
const materialFindings = ['CITATION_DOES_NOT_SUPPORT_CLAIM', 'UNSUPPORTED_QUANTITY', 'INVENTED_PREREQUISITE', 'WRONG_EDITION_MECHANIC',
  'OMITTED_PATCH_RESTRICTION', 'SPOILER_VIOLATION', 'UNSUPPORTED_ACTION_SEQUENCE', 'UNQUALIFIED_PARTIAL_EXTRACTION'].map((code, index) => ({
  code, severity: 'blocking', evidenceRefs: index % 2 ? [...chunkRefs].reverse() : chunkRefs
}));
const supportedGuide = 'Cross the lower bridge. Turn the west valve. Return by the lower bridge. [1]';
const assessmentFixtures = [
  { lane: 'routine', model: routineModel, decision: 'accept', visibleTokens: 477, reasoningTokens: 0, findings: [], answer: supportedGuide },
  { lane: 'routine', model: routineModel, decision: 'reject', visibleTokens: 1_071, reasoningTokens: 0, findings: materialFindings,
    answer: 'Buy three keys to cross the upper bridge. Turn the east valve to open the shortcut and reveal the hidden boss. [1]' },
  { lane: 'escalation', model: escalationModel, decision: 'unavailable', visibleTokens: 477, reasoningTokens: 600, findings: [], answer: supportedGuide }
] as const;

function expectSingleBoundedRequest(model: string, gaming = false): void {
  expect(responsesCreate).toHaveBeenCalledTimes(1);
  const [payload, options] = responsesCreate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
  expect(payload).toMatchObject({ model, max_output_tokens: gaming && model === routineModel ? 1_536 : 1_024 });
  expect(payload.reasoning).toEqual({ effort: model === routineModel ? 'none' : 'low' });
  for (const field of ['tools', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'max_completion_tokens']) {
    expect(payload[field]).toBeUndefined();
  }
  if (model === routineModel) {
    expect(payload).toMatchObject({ temperature: 0.7, top_p: 1 });
  } else {
    expect(payload.temperature).toBeUndefined();
    expect(payload.top_p).toBeUndefined();
  }
  expect(options.signal).toBeInstanceOf(AbortSignal);
  if (gaming) {
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(GAMING_CLEAR_ANSWER_BUDGET.maxTimeoutMs);
    expect(options.timeout).toBeLessThanOrEqual(9_000);
    expect(options.maxRetries).toBe(0);
    expect(payload.store).toBe(false);
    expect(payload.text).toMatchObject({ format: { type: 'json_object' } });
    expect(payload.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'developer',
      content: [expect.objectContaining({ text: expect.stringMatching(/Return minified JSON.*Keep distinct material findings and unresolved facts/su) })]
    })]));
  }
}

describe('CLEAR lane routing through the actual Responses conversion and validators', () => {
  beforeAll(() => {
    process.env.CLEAR_AUDIT_MODEL = routineModel;
    process.env.CLEAR_AUDIT_ESCALATION_MODEL = escalationModel;
  });
  afterAll(() => {
    if (previousRoutineModel === undefined) delete process.env.CLEAR_AUDIT_MODEL;
    else process.env.CLEAR_AUDIT_MODEL = previousRoutineModel;
    if (previousEscalationModel === undefined) delete process.env.CLEAR_AUDIT_ESCALATION_MODEL;
    else process.env.CLEAR_AUDIT_ESCALATION_MODEL = previousEscalationModel;
  });
  beforeEach(() => responsesCreate.mockReset());
  afterEach(() => jest.useRealTimers());

  it.each(lanes)('sends general %s audit to %s with the existing output cap and deadline', async (lane, model) => {
    responsesCreate.mockResolvedValue(response(model, scores));
    expect(await runClearAudit(client, ledger, createRuntimeBudgetWithLimit(10_000, 0), undefined, lane)).toEqual(scores);
    expectSingleBoundedRequest(model);
  });

  it.each(lanes)('sends Gaming %s audit to %s with one zero-retry tool-free request', async (lane, model) => {
    responsesCreate.mockResolvedValue(response(model, { dimensions, findings: [] }));
    const result = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0), lane);
    expect(result.assessment).toMatchObject({ assessmentStatus: 'completed', decision: 'accept' });
    expect(result.providerDiagnostic).toMatchObject({ resultClass: 'complete', providerStatus: 'completed',
      finishReason: 'stop', contentLengthClass: 'bounded' });
    expectSingleBoundedRequest(model, true);
  });

  it.each(assessmentFixtures)('returns $decision for a multi-passage Gaming assessment in the $lane lane', async ({ lane, model, decision, answer, findings, visibleTokens, reasoningTokens }) => {
    const suppliedDimensions = Object.fromEntries(suppliedDimensionScores.map(([name, score, reasonCodes]) => [name, {
      status: 'evaluated', score, reasonCodes, evidenceRefs: chunkRefs,
      unresolvedFacts: findings.length && name === 'resilience' ? ['PREREQUISITE_NOT_ESTABLISHED'] : []
    }]));
    const completion = response(model, { dimensions: suppliedDimensions, findings });
    // Visible usage is measured from compact JSON with a local GPT-OSS tokenizer as an o200k-family proxy.
    // Reasoning usage is synthetic. The fixture models both kinds of output sharing the requested cap.
    const outputTokens = visibleTokens + reasoningTokens;
    responsesCreate.mockImplementation(({ max_output_tokens: cap }: { max_output_tokens: number }) => {
      const consumedReasoningTokens = Math.min(cap, reasoningTokens);
      const consumedOutputTokens = Math.min(cap, outputTokens);
      return Promise.resolve({
        ...completion,
        ...(cap < outputTokens ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
          output_text: completion.output_text.slice(0, Math.floor(completion.output_text.length * (cap - consumedReasoningTokens) / visibleTokens)) } : {}),
        usage: { input_tokens: 200, output_tokens: consumedOutputTokens, total_tokens: 200 + consumedOutputTokens,
          output_tokens_details: { reasoning_tokens: consumedReasoningTokens } }
      });
    });
    const result = await runGamingClearAnswerAudit(client, { ...suppliedInput, answer }, createRuntimeBudgetWithLimit(10_000, 0), lane);
    expectSingleBoundedRequest(model, true);
    const [, options] = responsesCreate.mock.calls[0] as [unknown, { timeout: number }];
    expect(result.effectiveTimeoutMs).toBe(options.timeout);
    if (decision === 'unavailable') {
      expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision, overall: null, blockingFindings: [] });
      expect(result.assessment.findings.map(finding => finding.code)).toEqual(['AUDIT_PROVIDER_INCOMPLETE']);
      expect(result.providerDiagnostic).toMatchObject({ resultClass: 'provider_incomplete', providerStatus: 'incomplete',
        finishReason: 'length', incompleteReason: 'max_output_tokens', truncated: true, contentFiltered: false });
      return;
    }
    expect(result.assessment).toMatchObject({ assessmentStatus: 'completed', decision });
    expect(result.assessment.dimensionScores).toEqual(suppliedDimensions);
    const expectedBlockingFindings = decision === 'reject'
      ? [...findings, { code: 'MATERIAL_FACT_UNRESOLVED', severity: 'blocking', evidenceRefs: [] }]
      : findings;
    expect(result.assessment.blockingFindings).toEqual(expectedBlockingFindings);
    expect(result.providerDiagnostic).toMatchObject({ resultClass: 'complete', providerStatus: 'completed',
      finishReason: 'stop', contentLengthClass: 'bounded' });
    expect(result.usage).toMatchObject({ completion_tokens: outputTokens });
  });

  it.each(lanes)('aborts an actual pending general %s audit at the remaining runtime deadline', async (lane, model) => {
    jest.useFakeTimers();
    responsesCreate.mockImplementation((_payload: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const result = runClearAudit(client, ledger, createRuntimeBudgetWithLimit(45, 0), undefined, lane);
    await jest.advanceTimersByTimeAsync(44);
    const options = responsesCreate.mock.calls[0][1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ clarity: 0, leverage: 0, efficiency: 0, alignment: 0, resilience: 0, overall: 0 });
    expect(options.signal.aborted).toBe(true);
    expectSingleBoundedRequest(model);
  });

  it.each(lanes)('keeps an actual incomplete Gaming %s audit unavailable without another call', async (lane, model) => {
    responsesCreate.mockResolvedValue({ ...response(model, { dimensions, findings: [] }),
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    const result = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0), lane);
    expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null });
    expect(result.assessment.findings.map(finding => finding.code)).toContain('AUDIT_PROVIDER_INCOMPLETE');
    expect(result.providerDiagnostic).toMatchObject({ resultClass: 'provider_incomplete', providerStatus: 'incomplete',
      finishReason: 'length', incompleteReason: 'max_output_tokens', truncated: true, contentFiltered: false });
    expectSingleBoundedRequest(model, true);
  });

  it.each(lanes)('rejects a mismatched model response for the Gaming %s audit', async (lane, model) => {
    const mismatchedModel = model === routineModel ? escalationModel : routineModel;
    responsesCreate.mockResolvedValue(response(mismatchedModel, { dimensions, findings: [] }));

    const { assessment } = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0), lane);

    expect(assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null,
      findings: [expect.objectContaining({ code: 'AUDIT_PROVIDER_ERROR' })] });
    expectSingleBoundedRequest(model, true);
  });

  it.each(lanes)('does not accept tool-call output from the Gaming %s audit', async (lane, model) => {
    responsesCreate.mockResolvedValue({
      ...response(model, { dimensions, findings: [] }),
      output: [{ type: 'function_call', call_id: 'synthetic-call', name: 'unused', arguments: '{}' }]
    });

    const { assessment } = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0), lane);

    expect(assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null,
      findings: [expect.objectContaining({ code: 'AUDIT_PROVIDER_INCOMPLETE' })] });
    expectSingleBoundedRequest(model, true);
  });

  it.each([
    [{ refusal: 'synthetic private refusal' }, 'refusal'],
    [{ output: [{ type: 'message', status: 'completed', content: [{ type: 'refusal', refusal: '' }] }] }, 'refusal'],
    [{ output: [{ type: 'web_search_call', id: 'synthetic-private-call-id', status: 'completed' }] }, 'tool_output']
  ])('rejects mixed non-text Responses audit output with valid JSON: %#', async (extra, outputKind) => {
    responsesCreate.mockResolvedValue({ ...response(routineModel, { dimensions, findings: [] }), ...extra });
    const result = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0));
    expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null,
      findings: [expect.objectContaining({ code: 'AUDIT_PROVIDER_INCOMPLETE' })] });
    expect(result.providerDiagnostic).toMatchObject({ resultClass: 'unsupported_output', providerStatus: 'completed', outputKind });
    expect(result.providerDiagnostic?.finishReason).toBeUndefined();
    expect(JSON.stringify(result.providerDiagnostic)).not.toMatch(/synthetic.private|web_search_call/u);
    expectSingleBoundedRequest(routineModel, true);
  });

  it.each(['incomplete', 'in_progress'])('rejects a %s message inside a completed Responses audit', async status => {
    responsesCreate.mockResolvedValue({ ...response(routineModel, { dimensions, findings: [] }),
      output: [{ type: 'message', status, content: [] }] });
    const result = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0));
    expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable',
      findings: [expect.objectContaining({ code: 'AUDIT_PROVIDER_INCOMPLETE' })] });
    expect(result.providerDiagnostic).toEqual({ resultClass: 'provider_incomplete', providerStatus: 'completed', messageStatus: status });
    expectSingleBoundedRequest(routineModel, true);
  });

  it('does not interpret commentary-only JSON as a final audit', async () => {
    const good = response(routineModel, { dimensions, findings: [] });
    responsesCreate.mockResolvedValue({ ...good,
      output: [{ type: 'message', status: 'completed', phase: 'commentary',
        content: [{ type: 'output_text', text: good.output_text, annotations: [] }] }] });
    const result = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0));
    expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable',
      findings: [expect.objectContaining({ code: 'AUDIT_PROVIDER_INCOMPLETE' })] });
    expect(result.providerDiagnostic).toEqual({ resultClass: 'commentary_only', providerStatus: 'completed' });
    expectSingleBoundedRequest(routineModel, true);
  });

  it.each([
    ['failed', 'provider_incomplete', 'AUDIT_PROVIDER_ERROR', 'failed'],
    ['cancelled', 'provider_incomplete', 'AUDIT_PROVIDER_ERROR', 'cancelled'],
    ['queued', 'unexpected_finish', 'AUDIT_PROVIDER_INCOMPLETE', 'queued'],
    ['in_progress', 'unexpected_finish', 'AUDIT_PROVIDER_INCOMPLETE', 'in_progress'],
    ['synthetic-private-status', 'unexpected_finish', 'AUDIT_PROVIDER_INCOMPLETE', 'unknown']
  ])('keeps the noncompleted Responses lifecycle unavailable: %s', async (status, resultClass, code, providerStatus) => {
    const good = response(routineModel, { dimensions, findings: [] });
    responsesCreate.mockResolvedValueOnce({ ...good, status }).mockResolvedValue(good);
    try {
      const result = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0));
      expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null,
        findings: [expect.objectContaining({ code })] });
      expect(result.providerDiagnostic).toMatchObject({ resultClass, providerStatus });
      expect(JSON.stringify(result.providerDiagnostic)).not.toContain('synthetic-private-status');
      expectSingleBoundedRequest(routineModel, true);
    } finally {
      // Keep the real shared circuit breaker isolated between conversion failures.
      await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0));
    }
  });

  it('keeps a provider 400 for unsupported Gaming audit format unavailable', async () => {
    responsesCreate.mockRejectedValue(new BadRequestError(400, {
      message: 'Synthetic unsupported output format', type: 'invalid_request_error',
      code: 'unsupported_value', param: 'text.format'
    }, undefined, new Headers()));

    const { assessment } = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0));

    expect(assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null,
      findings: [expect.objectContaining({ code: 'AUDIT_PROVIDER_ERROR' })] });
    expectSingleBoundedRequest(routineModel, true);
  });

  it('propagates caller cancellation from an in-flight Gaming audit', async () => {
    const controller = new AbortController();
    let markDispatched!: (signal: AbortSignal) => void;
    const dispatched = new Promise<AbortSignal>(resolve => { markDispatched = resolve; });
    responsesCreate.mockImplementation((_payload: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        markDispatched(options.signal);
      }));
    const pending = runWithRequestAbortContext({
      controller, signal: controller.signal, deadlineAt: Date.now() + 10_000, timeoutMs: 10_000
    }, () => runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0)));

    const providerSignal = await dispatched;
    const cancellation = expect(pending).rejects.toThrow('request_aborted');
    expect(providerSignal.aborted).toBe(false);
    controller.abort(createAbortError('synthetic caller cancellation'));
    await cancellation;

    expect(providerSignal.aborted).toBe(true);
    expectSingleBoundedRequest(routineModel, true);
  });

  it('ignores legacy module-local audit selectors for both production audit paths', async () => {
    process.env.CLEAR_AUDIT_MODEL = 'gpt-5.1';
    process.env.CLEAR_AUDIT_ESCALATION_MODEL = 'gpt-4.1';
    try {
      responsesCreate.mockResolvedValue(response(routineModel, scores));
      expect(await runClearAudit(client, ledger)).toEqual(scores);
      expectSingleBoundedRequest(routineModel);
      responsesCreate.mockReset().mockResolvedValue(response(routineModel, { dimensions, findings: [] }));
      expect((await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0))).assessment.decision).toBe('accept');
      expectSingleBoundedRequest(routineModel, true);
      responsesCreate.mockReset().mockResolvedValue(response(escalationModel, { dimensions, findings: [] }));
      expect((await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0), 'escalation')).assessment.decision).toBe('accept');
      expectSingleBoundedRequest(escalationModel, true);
    } finally {
      process.env.CLEAR_AUDIT_MODEL = routineModel;
      process.env.CLEAR_AUDIT_ESCALATION_MODEL = escalationModel;
    }
  });

  it.each(lanes)('keeps %s provider failures bounded without automatic audit escalation', async (lane, model) => {
    responsesCreate.mockRejectedValue(new Error('Synthetic provider unavailable'));
    expect(await runClearAudit(client, ledger, createRuntimeBudgetWithLimit(10_000, 0), undefined, lane))
      .toEqual({ clarity: 0, leverage: 0, efficiency: 0, alignment: 0, resilience: 0, overall: 0 });
    expectSingleBoundedRequest(model);
    responsesCreate.mockReset().mockRejectedValue(new Error('Synthetic provider unavailable'));
    expect((await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0), lane)).assessment)
      .toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null });
    expectSingleBoundedRequest(model, true);
  });
});

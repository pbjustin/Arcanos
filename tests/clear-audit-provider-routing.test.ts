import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { runClearAudit } from '../src/core/audit/runClearAudit.js';
import { runGamingClearAnswerAudit, type GamingClearAnswerInput } from '../src/services/gamingClearAnswerAudit.js';
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

function expectSingleBoundedRequest(model: string, gaming = false): void {
  expect(responsesCreate).toHaveBeenCalledTimes(1);
  const [payload, options] = responsesCreate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
  expect(payload).toMatchObject({ model, max_output_tokens: 1_024 });
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
    expect(options.timeout).toBeLessThanOrEqual(3_000);
    expect(options.maxRetries).toBe(0);
    expect(payload.store).toBe(false);
    expect(payload.text).toMatchObject({ format: { type: 'json_object' } });
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
    expect((await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0), lane)).assessment)
      .toMatchObject({ assessmentStatus: 'completed', decision: 'accept' });
    expectSingleBoundedRequest(model, true);
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

  it('keeps an actual incomplete Gaming provider response unavailable without another call or escalation', async () => {
    responsesCreate.mockResolvedValue({ ...response(routineModel, { dimensions, findings: [] }),
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    const result = await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0));
    expect(result.assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable', overall: null });
    expect(result.assessment.findings.map(finding => finding.code)).toContain('AUDIT_PROVIDER_INCOMPLETE');
    expectSingleBoundedRequest(routineModel, true);
  });

  it('keeps legacy rollback model reasoning parameters omitted for both audit paths', async () => {
    process.env.CLEAR_AUDIT_MODEL = 'gpt-5.1';
    try {
      responsesCreate.mockResolvedValue(response('gpt-5.1', scores));
      expect(await runClearAudit(client, ledger)).toEqual(scores);
      expect(responsesCreate.mock.calls[0][0]).toMatchObject({ model: 'gpt-5.1', max_output_tokens: 1_024 });
      expect((responsesCreate.mock.calls[0][0] as Record<string, unknown>).reasoning).toBeUndefined();
      responsesCreate.mockReset().mockResolvedValue(response('gpt-5.1', { dimensions, findings: [] }));
      expect((await runGamingClearAnswerAudit(client, input, createRuntimeBudgetWithLimit(10_000, 0))).assessment.decision).toBe('accept');
      expect(responsesCreate).toHaveBeenCalledTimes(1);
      expect((responsesCreate.mock.calls[0][0] as Record<string, unknown>).reasoning).toBeUndefined();
    } finally {
      process.env.CLEAR_AUDIT_MODEL = routineModel;
    }
  });
});

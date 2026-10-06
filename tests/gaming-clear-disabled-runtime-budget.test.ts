import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';

const previousBudgetDisabled = process.env.BUDGET_DISABLED;
process.env.BUDGET_DISABLED = 'true';
const { BUDGET_DISABLED, createRuntimeBudgetWithLimit, getSafeRemainingMs } = await import('@arcanos/runtime');
const { runGamingClearAnswerAudit, gamingClearAnswerMatches } = await import('../src/services/gamingClearAnswerAudit.js');
const refs = ['source-1', 'revision-1', 'record-1'];
const text = 'Fixture Quest: use the supported starter equipment.';
const dimensions = Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
  { status: 'evaluated', score: 5, reasonCodes: ['SUPPORTED'], evidenceRefs: refs, unresolvedFacts: [] }
])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'];
const evidenceAssessment = createGamingClearAssessment({ profile: 'evidence', questionProfile: 'walkthrough',
  subjectId: 'selected-evidence', subjectHash: gamingClearHash(text), contextFingerprint: gamingClearContextFingerprint('selected-evidence'),
  evidenceRefs: refs, dimensions, gates: { identity: 'verified', security: 'verified', compatibility: 'verified',
    provenance: 'verified', claimSupport: 'verified', freshness: 'not_applicable' } });
const input = { game: 'Fixture Quest', mode: 'guide' as const, prompt: 'How do I use the supported starter equipment?',
  answer: 'Use the supported starter equipment. [1]', evidenceAssessment,
  knowledge: { context: text,
    sources: [{ sourceId: refs[0], url: 'https://example.com/starter-guide', sourceType: 'guide', game: 'Fixture Quest',
      fetchedAt: '2026-10-04T00:00:00.000Z', snippet: text }],
    evidence: [{ sourceId: refs[0], revisionId: refs[1], recordId: refs[2], recordType: 'guide' as const,
      publicUrl: 'https://example.com/starter-guide', text, lexicalScore: 1, combinedScore: 1,
      provenance: { fetchedAt: '2026-10-04T00:00:00.000Z' } }] } };

afterAll(() => {
  if (previousBudgetDisabled === undefined) delete process.env.BUDGET_DISABLED;
  else process.env.BUDGET_DISABLED = previousBudgetDisabled;
});
afterEach(() => jest.useRealTimers());

describe('Gaming answer audit with runtime budget disabled', () => {
  it.each(['routine', 'escalation'] as const)('still aborts the %s audit before its watchdog terminal reserve', async lane => {
    jest.useFakeTimers({ now: 1_000 });
    const budget = createRuntimeBudgetWithLimit(10_000, 0);
    expect(BUDGET_DISABLED).toBe(true);
    expect(getSafeRemainingMs(budget)).toBeGreaterThan(10_000);
    const responsesCreate = jest.fn((_payload: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const client = { responses: { create: responsesCreate } } as never;
    const audit = runGamingClearAnswerAudit(client, input, budget, lane, 2_000);
    await jest.advanceTimersByTimeAsync(999);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(responsesCreate.mock.calls[0][1].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const { assessment } = await audit;
    expect(assessment).toMatchObject({ assessmentStatus: 'unavailable', decision: 'unavailable',
      findings: [expect.objectContaining({ code: 'AUDIT_TIMEOUT' })] });
    expect(gamingClearAnswerMatches(assessment, input.answer)).toBe(false);
    expect(responsesCreate.mock.calls[0][1]).toMatchObject({ timeout: 1_000, maxRetries: 0 });
    expect(responsesCreate.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

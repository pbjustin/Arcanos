import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createAbortError, runWithRequestAbortContext } from '@arcanos/runtime';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';
import type { ReasoningLedger } from '../src/core/logic/trinityTypes.js';

const createGPT5Reasoning = jest.fn();
jest.unstable_mockModule('@services/openai/chatFlow/index.js', () => ({ createGPT5Reasoning }));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getClearAuditModel: () => 'gpt-6-luna', getClearAuditEscalationModel: () => 'gpt-6.1-sol'
}));
const { runClearAudit } = await import('../src/core/audit/runClearAudit.js');

const ledger: ReasoningLedger = {
  steps: ['Use the supplied synthetic facts'], assumptions: [], constraints: [], tradeoffs: [], alternatives: [],
  justification: 'The synthetic facts directly support the answer.', responseMode: 'answer',
  achievableSubtasks: ['answer'], blockedSubtasks: [], userVisibleCaveats: [], evidenceTags: []
};
const scores = { clarity: 4, leverage: 4, efficiency: 4, alignment: 4, resilience: 4, overall: 4 };
const unavailable = { clarity: 0, leverage: 0, efficiency: 0, alignment: 0, resilience: 0, overall: 0 };

describe('scoped general CLEAR audit model routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createGPT5Reasoning.mockResolvedValue({ content: JSON.stringify(scores) });
  });
  afterEach(() => jest.useRealTimers());

  it('selects the scoped routine audit model for a single call', async () => {
    expect(await runClearAudit({} as never, ledger)).toEqual(scores);
    expect(createGPT5Reasoning).toHaveBeenCalledTimes(1);
    expect(createGPT5Reasoning.mock.calls[0][3]).toMatchObject({ model: 'gpt-6-luna', reasoningEffort: 'none', timeoutMs: 3_000 });
  });

  it('selects the explicit escalation lane for one call within the same audit budget', async () => {
    expect(await runClearAudit({} as never, ledger, undefined, undefined, 'escalation')).toEqual(scores);
    expect(createGPT5Reasoning).toHaveBeenCalledTimes(1);
    expect(createGPT5Reasoning.mock.calls[0][3]).toMatchObject({ model: 'gpt-6.1-sol', reasoningEffort: 'low', timeoutMs: 3_000 });
  });

  it('propagates the parent signal and clamps the audit timeout to both request and runtime budgets', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
    const controller = new AbortController();
    await runWithRequestAbortContext({ controller, signal: controller.signal, deadlineAt: 1_080, timeoutMs: 80 },
      () => runClearAudit({} as never, ledger, createRuntimeBudgetWithLimit(150, 0)));
    expect(createGPT5Reasoning.mock.calls[0][3]).toMatchObject({ model: 'gpt-6-luna', signal: controller.signal, timeoutMs: 80 });
    createGPT5Reasoning.mockClear();
    await runClearAudit({} as never, ledger, createRuntimeBudgetWithLimit(45, 0), undefined, 'escalation');
    expect(createGPT5Reasoning.mock.calls[0][3]).toMatchObject({ model: 'gpt-6.1-sol', timeoutMs: 45 });
  });

  it.each(['routine', 'escalation'] as const)('preserves %s timeout fallback without retrying', async lane => {
    createGPT5Reasoning.mockRejectedValue(createAbortError('synthetic timeout'));
    expect(await runClearAudit({} as never, ledger, undefined, undefined, lane)).toEqual(unavailable);
    expect(createGPT5Reasoning).toHaveBeenCalledTimes(1);
  });

  it.each(['routine', 'escalation'] as const)('preserves %s provider-failure fallback without automatic escalation', async lane => {
    createGPT5Reasoning.mockResolvedValue({ content: 'synthetic unavailable', error: 'synthetic provider error' });
    expect(await runClearAudit({} as never, ledger, undefined, undefined, lane)).toEqual(unavailable);
    expect(createGPT5Reasoning).toHaveBeenCalledTimes(1);
  });

  it.each(['not JSON', 'null', '42'])('preserves deterministic fallback for malformed audit payload %s', async content => {
    createGPT5Reasoning.mockResolvedValue({ content });
    expect(await runClearAudit({} as never, ledger)).toEqual(unavailable);
    expect(createGPT5Reasoning).toHaveBeenCalledTimes(1);
  });

  it('preserves worker admission errors instead of retrying or converting them into scores', async () => {
    const error = Object.assign(new Error('synthetic worker budget error'), { code: 'worker_ai_call_budget_exceeded' });
    createGPT5Reasoning.mockRejectedValue(error);
    await expect(runClearAudit({} as never, ledger)).rejects.toBe(error);
    expect(createGPT5Reasoning).toHaveBeenCalledTimes(1);
  });

  it('retains the original bounded Gaming request in legacy ledger-audit calls', async () => {
    await runClearAudit({} as never, ledger, undefined, 'Synthetic request with evidence [1]');
    expect(JSON.parse(createGPT5Reasoning.mock.calls[0][1] as string)).toEqual({
      ledger, originalGamingRequest: 'Synthetic request with evidence [1]'
    });
    expect(createGPT5Reasoning.mock.calls[0][2]).toContain('untrusted data');
    expect(createGPT5Reasoning.mock.calls[0][3]).toMatchObject({ model: 'gpt-6-luna' });
  });
});

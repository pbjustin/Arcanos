import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

// Keep extraction, stages, routing, honesty and final delivery real. Only the
// provider and unrelated persistence/background effects are replaced.
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }),
  storePattern: jest.fn(),
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: jest.fn(),
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: jest.fn() }));
jest.unstable_mockModule('@analytics/escalationTracker.js', () => ({ trackEscalation: jest.fn() }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(), recordTrinityStageFailure: jest.fn(),
}));

const { runThroughBrain } = await import('../src/core/logic/trinity.js');
const { runTrinityWritingPipeline } = await import('../src/core/logic/trinityWritingPipeline.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const { createRuntimeBudgetWithLimit } = await import('../src/platform/resilience/runtimeBudget.js');
const responsesCreate = jest.fn();
const client = {
  models: { retrieve: jest.fn(async (id: string) => ({ id })) },
  responses: { create: responsesCreate },
} as unknown as OpenAI;
const authority = 'ft:gpt-4.1:synthetic:output-integrity';
const prompt = 'Assess the supplied outline and return only the declared JSON object.';
const raw = ' \n{\n  "answer": "It is literal `value` and **emphasis**. Do not reshape it.",\n  "audit_trace": "This is caller-owned data."\n}\t ';
const contract = {
  name: 'output_integrity',
  schema: {
    type: 'object', additionalProperties: false, required: ['answer', 'audit_trace'],
    properties: { answer: { type: 'string' }, audit_trace: { type: 'string' } },
  },
};
let finalText = raw;
let incomplete = false;
const originalAuthority = process.env.FINETUNED_MODEL_ID;

function response(payload: ResponseCreateParamsNonStreaming) {
  let text = finalText;
  if (payload.text?.format?.type === 'json_schema') {
    text = JSON.stringify({ response_mode: 'answer', achievable_subtasks: ['assess the supplied outline'],
      blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: 'Use the supplied outline.' });
  } else if (String(payload.model) !== authority) {
    text = JSON.stringify(payload).includes('CLEAR principles')
      ? JSON.stringify({ clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5 })
      : 'Assess only the supplied outline.';
  }
  return { id: 'synthetic-integrity-response', model: payload.model,
    status: incomplete && payload.model === authority ? 'incomplete' : 'completed',
    ...(incomplete && payload.model === authority ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output_text: text, output: [], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
}

function run(answerMode: 'direct' | 'explained' = 'explained', finalOutputContract: typeof contract | null = contract) {
  return runTrinityWritingPipeline({
    input: { prompt, sourceEndpoint: 'trinity-output-integrity.fixture' },
    context: { client, runtimeBudget: createRuntimeBudgetWithLimit(20_000, 0), runOptions: {
      disableMemoryAccess: true, disableOptionalSideEffects: true, answerMode,
      ...(finalOutputContract ? { finalOutputContract } : {}),
    } },
  });
}

describe('Trinity caller-declared final JSON integrity at actual provider extraction', () => {
  beforeEach(() => {
    process.env.FINETUNED_MODEL_ID = authority;
    finalText = raw;
    incomplete = false;
    responsesCreate.mockReset().mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => response(payload));
  });
  afterEach(() => {
    if (originalAuthority === undefined) delete process.env.FINETUNED_MODEL_ID;
    else process.env.FINETUNED_MODEL_ID = originalAuthority;
  });

  it('preserves valid JSON through the normal complete path without repair calls', async () => {
      const result = await run();
      expect(result.result).toBe(raw);
      expect(JSON.parse(result.result)).toEqual(JSON.parse(raw));
      expect(result.auditSafe.processedSafely).toBe(true);
      expect(responsesCreate).toHaveBeenCalledTimes(4);
  });

  it('preserves direct-answer JSON including Markdown-like string data', async () => {
    expect((await run('direct')).result).toBe(raw);
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it.each(['direct', 'explained'] as const)('preserves non-claim review and code text through the %s caller path', async mode => {
    finalText = JSON.stringify({
      answer: 'The migration is not validated.',
      audit_trace: '//audit Assumption: check that input is a string before use.',
    });
    const result = await run(mode);
    expect(result.result).toBe(finalText);
    expect(result.auditSafe.processedSafely).toBe(true);
    expect(responsesCreate).toHaveBeenCalledTimes(mode === 'direct' ? 1 : 4);
  });

  it.each(['direct', 'explained'] as const)('rejects malformed %s output rather than reporting delivery success', async mode => {
    const warn = jest.spyOn(logger, 'warn');
    const info = jest.spyOn(logger, 'info');
    finalText = '{"answer":"unfinished"';
    await expect(run(mode)).rejects.toMatchObject({
      code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'invalid_json',
    });
    expect(responsesCreate).toHaveBeenCalledTimes(mode === 'direct' ? 1 : 4);
    expect(warn).toHaveBeenCalledWith('trinity.final_output.integrity_failed', expect.objectContaining({
      errorCode: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'invalid_json',
    }));
    expect(info).not.toHaveBeenCalledWith('trinity.exit', expect.anything());
  });

  it('rejects a schema mismatch without coercing or inventing missing fields', async () => {
    const warn = jest.spyOn(logger, 'warn');
    finalText = '{"answer":42}';
    await expect(run()).rejects.toMatchObject({
      code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'schema_mismatch',
    });
    expect(responsesCreate).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith('trinity.final_output.integrity_failed', expect.objectContaining({
      reason: 'schema_mismatch',
    }));
  });

  it('rejects an absent schema before any provider work', async () => {
    await expect(run('direct', { name: 'unspecified', schema: undefined as never })).rejects.toMatchObject({
      code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'invalid_contract',
    });
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it('rejects unsupported action claims inside otherwise valid JSON', async () => {
    finalText = JSON.stringify({ answer: 'I saved the record in the backend database.', audit_trace: 'Example.' });
    await expect(run('direct')).rejects.toMatchObject({
      code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'unsupported_claim',
    });
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('retains ordinary direct prose processing when no JSON contract is declared', async () => {
    finalText = 'Direct answer: **Use** `value`.';
    expect((await run('direct', null)).result).toBe('Use value.');
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('never enters the optional prose repair stage to repair JSON', async () => {
    finalText = '{"answer":"unfinished"';
    await expect(runThroughBrain(client, prompt, undefined, undefined, {
      disableMemoryAccess: true, disableOptionalSideEffects: true, answerMode: 'direct',
      finalOutputContract: contract,
      directAnswerIntegrityRepair: {
        maxAttempts: 1, timeoutMs: 1_000, tokenLimit: 100, totalOutputTokenCap: 1_000,
        minimumOutputTokens: 100, minimumRuntimeRemainingMs: 1_000, minimumRequestRemainingMs: 1_000,
      },
    }, createRuntimeBudgetWithLimit(20_000, 0))).rejects.toMatchObject({
      code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'invalid_json',
    });
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('preserves incomplete-provider classification even when the partial response parses as JSON', async () => {
    incomplete = true;
    await expect(run('direct')).rejects.toMatchObject({
      // The adapter rejects incompleteness before final JSON processing.
      code: 'OPENAI_COMPLETION_INCOMPLETE',
    });
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('retains the direct request-derived current-state limitation', async () => {
    finalText = JSON.stringify({ answer: 'Use the supplied outline.', audit_trace: 'Example.' });
    await expect(runThroughBrain(client, 'Check latest competitor news and return JSON.', undefined, undefined, {
      disableMemoryAccess: true, disableOptionalSideEffects: true, answerMode: 'direct',
      finalOutputContract: contract,
    }, createRuntimeBudgetWithLimit(20_000, 0))).rejects.toMatchObject({
      code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'missing_required_limitation',
    });
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });
});

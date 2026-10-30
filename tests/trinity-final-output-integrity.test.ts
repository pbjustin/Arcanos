import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { getFinalizedPublicAnswerPresentation } from '../src/shared/http/clientResponseCommon.js';
import { buildTrinityUserVisibleResponse } from '../src/shared/ask/trinityResponseSerializer.js';

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
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client }),
}));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(), recordTrinityStageFailure: jest.fn(),
}));

const { runThroughBrain } = await import('../src/core/logic/trinity.js');
const { runTrinityWritingPipeline } = await import('../src/core/logic/trinityWritingPipeline.js');
const { runTrinity } = await import('../src/trinity/trinity.js');
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
let toolClaimText: string | null = null;
let canCallBackend = false;
const originalAuthority = process.env.FINETUNED_MODEL_ID;

function response(payload: ResponseCreateParamsNonStreaming) {
  let text = finalText;
  if (payload.text?.format?.type === 'json_schema') {
    text = JSON.stringify({ response_mode: 'answer', achievable_subtasks: ['assess the supplied outline'],
      blocked_subtasks: [], user_visible_caveats: [], claim_tags: toolClaimText ? [{
        claim_text: toolClaimText, source_type: 'tool', verification_status: 'verified', confidence: 'high',
      }] : [], final_answer: 'Use the supplied outline.' });
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
      ...(canCallBackend ? { toolBackedCapabilities: { callBackend: true } } : {}),
      ...(finalOutputContract ? { finalOutputContract } : {}),
    } },
  });
}

describe('Trinity caller-declared final JSON integrity at actual provider extraction', () => {
  beforeEach(() => {
    process.env.FINETUNED_MODEL_ID = authority;
    finalText = raw;
    incomplete = false;
    toolClaimText = null;
    canCallBackend = false;
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
      expect(getFinalizedPublicAnswerPresentation(result)).toBe('public-answer-v1');
      expect(buildTrinityUserVisibleResponse({ trinityResult: result }).presentation).toBe('public-answer-v1');
      expect(responsesCreate).toHaveBeenCalledTimes(4);
  });

  it('preserves direct-answer JSON including Markdown-like string data', async () => {
    const result = await run('direct');
    expect(result.result).toBe(raw);
    expect(getFinalizedPublicAnswerPresentation(result)).toBe('public-answer-v1');
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('marks an approved exact-literal public heading without provider work', async () => {
    const result = await runTrinityWritingPipeline({
      input: { prompt: 'Write exactly this text and nothing else: ## Audit Summary', sourceEndpoint: 'presentation.fixture' },
      context: { client, runtimeBudget: createRuntimeBudgetWithLimit(20_000, 0),
        runOptions: { disableMemoryAccess: true, disableOptionalSideEffects: true } },
    });
    const serialized = buildTrinityUserVisibleResponse({ trinityResult: result });
    expect(serialized.result).toBe('## Audit Summary');
    expect(serialized.presentation).toBe('public-answer-v1');
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('presentation');
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it('does not recreate provenance from serialized or changed output', async () => {
    const result = await run('direct');
    const restored = JSON.parse(JSON.stringify(result));
    restored.presentation = 'public-answer-v1';
    expect(buildTrinityUserVisibleResponse({ trinityResult: restored }).presentation).toBeUndefined();
    result.result += '\nchanged after finalization';
    expect(buildTrinityUserVisibleResponse({ trinityResult: result }).presentation).toBeUndefined();
  });

  it('omits presentation for persisted output without changing finalized in-process provenance', async () => {
    const result = await run('direct');
    const queued = buildTrinityUserVisibleResponse({ trinityResult: result, includePresentation: false });
    expect(queued.result).toBe(raw);
    expect(queued).not.toHaveProperty('presentation');
    expect(JSON.parse(JSON.stringify(queued))).not.toHaveProperty('presentation');
    expect(getFinalizedPublicAnswerPresentation(result)).toBe('public-answer-v1');
    expect(buildTrinityUserVisibleResponse({ trinityResult: result }).presentation).toBe('public-answer-v1');
  });

  it('preserves a false verification flag through the structured query-finetune compatibility caller', async () => {
    finalText = ' \n{"verified": false}\t ';
    const result = await runTrinity({ prompt, structured: true });
    expect(result.output).toBe(finalText);
    expect(result.raw.auditSafe.processedSafely).toBe(true);
    expect(responsesCreate).toHaveBeenCalledTimes(4);
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

  it.each(['direct', 'explained'] as const)('rejects an unsupported named-command execution claim in the %s path', async mode => {
    finalText = JSON.stringify({ answer: 'I ran npm test.', audit_trace: 'Local example.' });
    await expect(run(mode)).rejects.toMatchObject({
      code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'unsupported_claim',
    });
    expect(responsesCreate).toHaveBeenCalledTimes(mode === 'direct' ? 1 : 4);
  });

  it.each([
    ['I ran the tests.', 'I deployed the app.'],
    ['I ran npm test.', 'I ran npm run build.'],
    ['I deployed the staging app.', 'I deployed the production app.'],
    ['I ran the tests.', 'I saved the record in the backend database.'],
  ])('does not promote synthetic reasoning evidence for another completed action: %s -> %s', async (evidence, claim) => {
    // These are synthetic metadata inputs; the fixture does not execute tools.
    toolClaimText = evidence;
    canCallBackend = true;
    finalText = JSON.stringify({ answer: claim, audit_trace: 'Synthetic example.' });
    await expect(run()).rejects.toMatchObject({
      code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'unsupported_claim',
    });
    expect(responsesCreate).toHaveBeenCalledTimes(4);
  });

  it('preserves a matching synthetic completed-action claim in the full path', async () => {
    toolClaimText = 'I ran npm test.';
    canCallBackend = true;
    finalText = JSON.stringify({ answer: toolClaimText, audit_trace: 'Synthetic example.' });
    expect((await run()).result).toBe(finalText);
    expect(responsesCreate).toHaveBeenCalledTimes(4);
  });

  it('retains ordinary direct prose processing when no JSON contract is declared', async () => {
    finalText = 'Direct answer: **Use** `value`.';
    const result = await run('direct', null);
    expect(result.result).toBe('Use value.');
    expect(getFinalizedPublicAnswerPresentation(result)).toBe('public-answer-v1');
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('preserves healthy standard final output without a caller-declared JSON contract', async () => {
    finalText = 'Use the supplied outline.';
    const result = await run('explained', null);
    expect(result.result).toBe(finalText);
    expect(buildTrinityUserVisibleResponse({ trinityResult: result }).presentation).toBe('public-answer-v1');
    expect(responsesCreate).toHaveBeenCalledTimes(4);
  });

  it.each(['', '   ', '\u200b'])(
    'rejects an empty visible final answer without a JSON contract before public delivery: %j',
    async output => {
      finalText = output;
      const delivered = jest.fn();
      await expect(run('explained', null).then(delivered)).rejects.toMatchObject({
        code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'empty_output',
      });
      expect(delivered).not.toHaveBeenCalled();
      expect(responsesCreate).toHaveBeenCalledTimes(4);
    }
  );

  it.each([
    ['incomplete', { status: 'incomplete' }],
    ['length', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }],
    ['content filter', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }],
  ])('does not deliver provider %s final output or its public marker without a JSON contract', async (_label, metadata) => {
    finalText = 'The supplied outline has two steps.';
    responsesCreate.mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => ({
      ...response(payload), ...(payload.model === authority ? metadata : {}),
    }));
    const delivered = jest.fn();
    await expect(run('explained', null).then(delivered)).rejects.toMatchObject({
      code: 'OPENAI_COMPLETION_INCOMPLETE',
    });
    expect(delivered).not.toHaveBeenCalled();
    expect(responsesCreate).toHaveBeenCalledTimes(4);
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

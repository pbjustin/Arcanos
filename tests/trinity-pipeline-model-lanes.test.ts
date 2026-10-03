import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

let bypassFinalStage = false;

// Keep routing, request conversion, capability policy, and structured validators real.
// Only the provider boundary and optional persistence/background effects are synthetic.
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }),
  storePattern: jest.fn(),
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: jest.fn(),
}));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({
  runSelfImproveCycle: jest.fn(),
}));
jest.unstable_mockModule('@analytics/escalationTracker.js', () => ({
  trackEscalation: jest.fn(),
}));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage, forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(),
  recordTrinityStageFailure: jest.fn(() => 'retry_once'),
}));

const { runThroughBrain } = await import('../src/core/logic/trinity.js');
const { detectTier } = await import('../src/core/logic/trinityTier.js');
const { createRuntimeBudgetWithLimit } = await import('../src/platform/resilience/runtimeBudget.js');

const responsesCreate = jest.fn();
const retrieveModel = jest.fn();
const client = { models: { retrieve: retrieveModel }, responses: { create: responsesCreate } } as unknown as OpenAI;
const answer = 'The supplied outline describes a staged release.';
// Assessment keeps the real normal pipeline; informational summaries auto-select direct mode.
const simplePrompt = 'Assess the supplied launch outline and its stated limitations.';
const complexPrompt = 'Explain the architecture of the supplied launch outline.';
const criticalPrompt = Array.from({ length: 8 }, () =>
  'Compare the architecture and security constraints in the supplied launch outline, using only its stated facts.'
).join(' ');
const scores = { clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5 };
const authorityModel = 'ft:gpt-4.1:synthetic:trinity-pipeline-authority';
const laneEnvironment = {
  FINETUNED_MODEL_ID: authorityModel,
  TRINITY_INTAKE_MODEL: 'gpt-6-luna',
  TRINITY_REASONING_MODEL: 'gpt-6.1-sol',
  TRINITY_FINAL_MODEL: 'gpt-6-luna',
  TRINITY_FINAL_ESCALATION_MODEL: 'gpt-6.1-sol',
  CLEAR_AUDIT_MODEL: 'gpt-6-luna',
  CLEAR_AUDIT_ESCALATION_MODEL: 'gpt-6.1-sol',
};
const authorityEnvironmentKeys = ['FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'AI_MODEL', 'OPENAI_MODEL', 'RAILWAY_OPENAI_MODEL'];
const originalEnvironment = new Map([...new Set([...Object.keys(laneEnvironment), ...authorityEnvironmentKeys])]
  .map(key => [key, process.env[key]]));

function response(model: string, output: string) {
  return { id: 'synthetic-lane-response', model, created_at: 1, status: 'completed',
    output_text: output, output: [], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
}

function isStructuredRequest(payload: ResponseCreateParamsNonStreaming): boolean {
  return payload.text?.format?.type === 'json_schema';
}

function syntheticResponse(payload: ResponseCreateParamsNonStreaming) {
  let output = answer;
  if (isStructuredRequest(payload)) {
    const compact = payload.text?.format?.type === 'json_schema'
      && payload.text.format.name === 'trinity_structured_reasoning_compact';
    output = JSON.stringify({ response_mode: 'answer', achievable_subtasks: ['summarize'],
      blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: answer,
      ...(compact ? {} : { reasoning_steps: ['Summarize the supplied outline.'], assumptions: [],
        constraints: [], tradeoffs: [], alternatives_considered: [],
        chosen_path_justification: 'A concise summary answers the request.' }) });
  } else if (JSON.stringify(payload).includes('CLEAR principles')) {
    output = JSON.stringify(scores);
  }
  return response(String(payload.model), output);
}

function requests(): ResponseCreateParamsNonStreaming[] {
  return responsesCreate.mock.calls.map(call => call[0] as ResponseCreateParamsNonStreaming);
}

async function run(prompt: string, options: Parameters<typeof runThroughBrain>[4] = {}) {
  return runThroughBrain(client, prompt, undefined, undefined, {
    disableMemoryAccess: true, disableOptionalSideEffects: true, ...options,
  }, createRuntimeBudgetWithLimit(20_000, 0));
}

describe('Trinity model lanes at the actual bounded provider boundary', () => {
  beforeEach(() => {
    Object.assign(process.env, laneEnvironment);
    bypassFinalStage = false;
    retrieveModel.mockReset().mockImplementation(async (model: string) => ({ id: model }));
    responsesCreate.mockReset().mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => syntheticResponse(payload));
  });

  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([false, true])('fails safely on intake validation failure before any generative call (Gaming=%s)', async gaming => {
    // Advance past the production validation-cache TTL without waiting or changing model policy.
    jest.useFakeTimers({ now: Date.now() + 11 * 60_000 });
    retrieveModel.mockRejectedValue(new Error('Synthetic intake model unavailable'));
    const gamingAudit = jest.fn(async () => {
      throw new Error('Gaming audit must not admit unavailable intake.');
    });
    await expect(run(simplePrompt, gaming ? {
      sourceEndpoint: 'arcanos-gaming.guide', gamingGuideIntakePolicy: 'compact-v1',
      gamingClearAnswerAudit: gamingAudit,
    } : {})).rejects.toThrow('Synthetic intake model unavailable');
    expect(retrieveModel).toHaveBeenCalledWith('gpt-6-luna', expect.anything());
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(gamingAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['simple', simplePrompt, 'low', 4],
    ['complex', complexPrompt, 'low', 4],
    ['critical', criticalPrompt, 'medium', 5],
  ] as const)('selects the exact %s pipeline roles and fine-tune authority while preserving caps', async (tier, prompt, effort, maxCalls) => {
    expect(detectTier(prompt)).toBe(tier);
    const result = await run(prompt);
    const calls = requests();
    expect(calls).toHaveLength(maxCalls);
    expect(calls[0]).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'none' } });
    expect(calls[1]).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort },
      max_output_tokens: 8_000, text: { format: { type: 'json_schema', strict: true } } });
    expect(calls[2]).toMatchObject({ model: 'gpt-6-luna' });
    expect(calls.at(-1)).toMatchObject({ model: authorityModel });
    expect(calls.at(-1)).not.toHaveProperty('reasoning');
    expect(result.result).toContain(answer);
    expect(result.fallbackFlag).toBe(false);
    for (const [payload, options] of responsesCreate.mock.calls as [ResponseCreateParamsNonStreaming, { signal: AbortSignal }][]) {
      expect(payload.max_output_tokens).toBeGreaterThan(0);
      expect(payload.max_output_tokens).toBeLessThanOrEqual(8_000);
      expect(payload).not.toHaveProperty('tools');
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('ignores legacy module-local model selectors across intake, reasoning and final composition', async () => {
    process.env.TRINITY_INTAKE_MODEL = 'gpt-4.1-mini';
    process.env.TRINITY_REASONING_MODEL = 'gpt-5.1';
    process.env.TRINITY_FINAL_MODEL = 'gpt-6-luna';
    process.env.TRINITY_FINAL_ESCALATION_MODEL = 'gpt-6.1-sol';
    await run(complexPrompt);
    expect(requests().map(payload => payload.model)).toEqual([
      'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna', authorityModel,
    ]);
    expect(requests()[0]).toMatchObject({ reasoning: { effort: 'none' } });
  });

  it.each(['intake', 'reasoning'] as const)('uses configured authority for bounded %s failure recovery', async failedStage => {
    process.env.TRINITY_INTAKE_MODEL = 'gpt-4.1-mini';
    let failed = false;
    responsesCreate.mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => {
      if (!failed && (failedStage === 'intake' || isStructuredRequest(payload))) {
        failed = true;
        throw Object.assign(new Error('Synthetic local stage timeout'), { name: 'AbortError' });
      }
      return syntheticResponse(payload);
    });
    const result = await run(simplePrompt);
    expect(result.routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(requests().map(payload => payload.model)).toEqual(failedStage === 'intake'
      ? ['gpt-6-luna', authorityModel] : ['gpt-6-luna', 'gpt-6.1-sol', authorityModel]);
    expect(requests().at(-1)).not.toHaveProperty('reasoning');
    expect(result.activeModel).toBe(authorityModel);
  });

  it('aborts Gaming final-authority timeout without retrying or admitting the answer audit', async () => {
    let authorityCalls = 0;
    responsesCreate.mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => {
      if (payload.model === authorityModel && authorityCalls++ === 0) {
        throw Object.assign(new Error('Synthetic final timeout'), { name: 'AbortError' });
      }
      return syntheticResponse(payload);
    });
    const gamingAudit = jest.fn(async () => {
      throw new Error('Gaming audit must not admit timed-out generation.');
    });
    await expect(run(simplePrompt, {
      sourceEndpoint: 'arcanos-gaming.guide', gamingGuideIntakePolicy: 'compact-v1',
      gamingClearAnswerAudit: gamingAudit,
    })).rejects.toMatchObject({ name: 'AbortError', message: 'Synthetic final timeout', timeoutPhase: 'final' });
    expect(requests().map(payload => payload.model)).toEqual([
      'gpt-6-luna', 'gpt-6.1-sol', authorityModel,
    ]);
    expect(requests().at(-1)).not.toHaveProperty('reasoning');
    expect(authorityCalls).toBe(1);
    expect(gamingAudit).not.toHaveBeenCalled();
  });

  it('accepts a direct-answer override only when it confirms configured authority', async () => {
    await run(simplePrompt, { answerMode: 'direct', directAnswerModelOverride: authorityModel });
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ model: authorityModel });
    expect(requests()[0]).not.toHaveProperty('reasoning');
    expect(retrieveModel).not.toHaveBeenCalled();
  });

  it.each(['gpt-4.1', 'gpt-6.1-sol', 'ft:gpt-4.1:synthetic:another-authority'])(
    'rejects module-selected final override %s before provider invocation', async model => {
      await expect(run(simplePrompt, { answerMode: 'direct', directAnswerModelOverride: model }))
        .rejects.toThrow('model override conflicts with final role');
      expect(responsesCreate).not.toHaveBeenCalled();
    }
  );

  it('rejects a conflicting final override before intake and reasoning in the normal pipeline', async () => {
    await expect(run(simplePrompt, { directAnswerModelOverride: 'gpt-6.1-sol' }))
      .rejects.toThrow('model override conflicts with final role');
    expect(retrieveModel).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it.each(['', 'gpt-6.1-sol'])(
    'rejects unavailable configured authority %j before model validation or helper calls', async authority => {
      for (const key of authorityEnvironmentKeys) process.env[key] = '';
      process.env.FINETUNED_MODEL_ID = authority;
      await expect(run(simplePrompt)).rejects.toThrow('configured fine-tune authority unavailable');
      expect(retrieveModel).not.toHaveBeenCalled();
      expect(responsesCreate).not.toHaveBeenCalled();
    }
  );

  it('preserves deterministic exact-literal output when no final authority is configured', async () => {
    for (const key of authorityEnvironmentKeys) process.env[key] = '';
    const result = await run('Write exactly this token and nothing else: AUTHORITY-GUARD-LITERAL');
    expect(result.result).toBe('AUTHORITY-GUARD-LITERAL');
    expect(result.gpt5Used).toBe(false);
    expect(retrieveModel).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it('composes through authority when self-healing bypasses the normal final stage', async () => {
    bypassFinalStage = true;
    const result = await run(simplePrompt);
    expect(requests().map(payload => payload.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', authorityModel]);
    expect(result.activeModel).toBe(authorityModel);
    expect(result.fallbackSummary.finalFallbackUsed).toBe(true);
  });

  it('fails safely if final-authority recovery is unavailable instead of exposing the reasoning draft', async () => {
    let authorityCalls = 0;
    responsesCreate.mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => {
      if (payload.model === authorityModel) {
        authorityCalls++;
        throw Object.assign(new Error('Synthetic authority unavailable'),
          authorityCalls === 1 ? { name: 'AbortError' } : {});
      }
      return syntheticResponse(payload);
    });
    await expect(run(simplePrompt)).rejects.toThrow('Synthetic authority unavailable');
    expect(requests().map(payload => payload.model)).toEqual([
      'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna', authorityModel, authorityModel,
    ]);
  });

  it('does not start final-authority recovery after the runtime budget is exhausted', async () => {
    jest.useFakeTimers();
    responsesCreate.mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => {
      if (payload.model === authorityModel) {
        jest.setSystemTime(Date.now() + 20_001);
        throw Object.assign(new Error('Synthetic final timeout after budget exhaustion'), { name: 'AbortError' });
      }
      return syntheticResponse(payload);
    });
    await expect(run(simplePrompt)).rejects.toThrow('runtime_budget_exhausted');
    expect(requests().map(payload => payload.model)).toEqual([
      'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-luna', authorityModel,
    ]);
  });

  it('keeps existing low-CLEAR escalation to one hop with Sol reasoning and fine-tune final authority', async () => {
    let audits = 0;
    responsesCreate.mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => {
      if (JSON.stringify(payload).includes('CLEAR principles')) {
        audits++;
        return response(String(payload.model), JSON.stringify(audits === 1
          ? { clarity: 0, leverage: 0, efficiency: 0, alignment: 0, resilience: 0, overall: 0 }
          : scores));
      }
      return syntheticResponse(payload);
    });
    const result = await run(complexPrompt);
    expect(result.tierInfo).toMatchObject({ tier: 'critical', escalated: true });
    expect(audits).toBe(2);
    expect(requests()).toHaveLength(8);
    expect(requests().at(-1)).toMatchObject({ model: authorityModel });
    expect(requests().at(-1)).not.toHaveProperty('reasoning');
    expect(requests().filter(isStructuredRequest).map(payload => payload.reasoning?.effort)).toEqual(['low', 'medium']);
  });

  it.each(['incomplete', 'invalid_schema'] as const)('keeps actual %s structured output fail-closed before final generation', async failure => {
    responsesCreate.mockImplementation(async (payload: ResponseCreateParamsNonStreaming) => {
      if (!isStructuredRequest(payload)) return syntheticResponse(payload);
      return failure === 'incomplete'
        ? { ...syntheticResponse(payload), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
        : response(String(payload.model), JSON.stringify({ final_answer: answer }));
    });
    await expect(run(simplePrompt)).rejects.toThrow(failure === 'incomplete'
      ? 'incomplete structured output' : 'failed validation');
    expect(requests().map(payload => payload.model)).toEqual(['gpt-6-luna', 'gpt-6.1-sol']);
  });
});

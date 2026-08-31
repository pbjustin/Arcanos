import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { countWords } from '../src/shared/text/countWords.js';

const mockValidateAIRequest = jest.fn();
const mockHandleAIError = jest.fn((error: unknown) => {
  throw error;
});
const mockCreateChatCompletionWithFallback = jest.fn();
const mockGenerateMockResponse = jest.fn();
const mockRunStructuredReasoning = jest.fn();
const mockTryExecutePromptRouteShortcut = jest.fn();
const mockStorePattern = jest.fn();
const mockRunClearAudit = jest.fn();
const mockRecordTrinityJudgedFeedback = jest.fn();
const mockRunSelfImproveCycle = jest.fn();
const mockTrackEscalation = jest.fn();

const verificationRouter = (await import('express')).default.Router();

jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  extractInput: jest.fn((body: Record<string, unknown>) => typeof body.prompt === 'string' ? body.prompt : null),
  validateAIRequest: mockValidateAIRequest,
  handleAIError: mockHandleAIError
}));

jest.unstable_mockModule('@platform/runtime/security.js', () => ({
  createValidationMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  createRateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getRequestActorKey: () => 'honesty-e2e-actor'
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next()
}));

jest.unstable_mockModule('@services/promptRouteShortcuts.js', () => ({
  tryExecutePromptRouteShortcut: mockTryExecutePromptRouteShortcut
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: () => 'arcanos-intake-model',
  getComplexModel: () => 'arcanos-final-model',
  getFallbackModel: () => 'gpt-4.1',
  getGPT5Model: () => 'gpt-5-reasoning-model',
  getTrinityReasoningModel: () => 'gpt-5-reasoning-model',
  generateMockResponse: mockGenerateMockResponse,
  createChatCompletionWithFallback: mockCreateChatCompletionWithFallback,
  createSingleChatCompletion: mockCreateChatCompletionWithFallback,
  runStructuredReasoning: mockRunStructuredReasoning,
  createGPT5Reasoning: jest.fn()
}));

jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  resolveOpenAIBaseURL: () => undefined,
  resolveOpenAIKey: () => null,
  getOpenAIKeySource: () => 'test',
  resetCredentialCache: jest.fn(),
  hasValidAPIKey: () => true,
  setDefaultModel: jest.fn(),
  getDefaultModel: () => 'arcanos-intake-model',
  getComplexModel: () => 'arcanos-final-model',
  getFallbackModel: () => 'gpt-4.1',
  getGPT5Model: () => 'gpt-5-reasoning-model',
  getTrinityReasoningModel: () => 'gpt-5-reasoning-model'
}));

jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({
  createChatCompletionWithFallback: mockCreateChatCompletionWithFallback,
  createSingleChatCompletion: mockCreateChatCompletionWithFallback
}));

jest.unstable_mockModule('@services/openai/structuredReasoning.js', () => ({
  runStructuredReasoning: mockRunStructuredReasoning
}));

jest.unstable_mockModule('@services/openai/chatFlow/index.js', () => ({
  createGPT5Reasoning: jest.fn()
}));

jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: jest.fn(() => ({
    relevantEntries: [],
    contextSummary: 'No memory context available.',
    accessLog: []
  })),
  storePattern: mockStorePattern
}));

jest.unstable_mockModule('@services/exactLiteralPromptShortcut.js', () => ({
  tryExtractExactLiteralPromptShortcut: jest.fn(() => null)
}));

jest.unstable_mockModule('../src/core/audit/runClearAudit.js', () => ({
  runClearAudit: mockRunClearAudit
}));

jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({
  recordTrinityJudgedFeedback: mockRecordTrinityJudgedFeedback
}));

jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({
  runSelfImproveCycle: mockRunSelfImproveCycle
}));

jest.unstable_mockModule('@analytics/escalationTracker.js', () => ({
  trackEscalation: mockTrackEscalation
}));

jest.unstable_mockModule('../src/routes/api-arcanos-verification.js', () => ({
  default: verificationRouter
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/api-arcanos.js')).default;
const { runThroughBrain } = await import('../src/core/logic/trinity.js');
const { WorkerAiCallBudgetPausedError } = await import(
  '../src/core/adapters/openai.adapter.js'
);
const { createRuntimeBudget, createRuntimeBudgetWithLimit } = await import(
  '@platform/resilience/runtimeBudget.js'
);
const {
  createAiExecutionContext,
  runWithAiExecutionContext,
} = await import('../src/services/openai/aiExecutionContext.js');
const { logger: structuredLogger } = await import(
  '../src/platform/logging/structuredLogging.js'
);

function buildIntegrityRepairOptions(expectedNumberedItemCount?: number) {
  return {
    maxAttempts: 1 as const,
    timeoutMs: 10_000,
    tokenLimit: 96,
    totalOutputTokenCap: 2_400,
    minimumOutputTokens: 96,
    minimumRuntimeRemainingMs: 10_000,
    minimumRequestRemainingMs: 10_000,
    ...(expectedNumberedItemCount
      ? { expectedNumberedItemCount }
      : {}),
  };
}

function buildIntegrityCompletion(input: {
  content: string;
  id: string;
  completionTokens?: number;
  providerMetadata?: Record<string, unknown>;
}) {
  const completionTokens = input.completionTokens ?? 120;
  return {
    choices: [{
      finish_reason: 'stop',
      message: { content: input.content },
    }],
    provider_metadata: {
      finish_reason: 'stop',
      status: 'completed',
      incomplete_details: { reason: 'none' },
      incomplete: false,
      empty_output: input.content.length === 0,
      truncated: false,
      length_truncated: false,
      content_filtered: false,
      ...(input.providerMetadata ?? {}),
    },
    activeModel: 'gpt-4.1',
    fallbackFlag: false,
    usage: {
      prompt_tokens: 80,
      completion_tokens: completionTokens,
      total_tokens: 80 + completionTokens,
    },
    id: input.id,
    created: 1773339300250,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('/api/arcanos/ask honesty e2e', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ASK_ROUTE_MODE = 'compat';

    mockTryExecutePromptRouteShortcut.mockResolvedValue(null);
    mockRunClearAudit.mockResolvedValue({
      clarity: 5,
      leverage: 5,
      efficiency: 5,
      alignment: 5,
      resilience: 5,
      overall: 5
    });
    mockRecordTrinityJudgedFeedback.mockResolvedValue({
      enabled: false,
      attempted: false,
      source: 'clear_audit'
    });
    mockRunSelfImproveCycle.mockResolvedValue(undefined);

    mockValidateAIRequest.mockImplementation((_req: unknown, _res: unknown) => ({
      client: {
        models: {
          retrieve: jest.fn().mockResolvedValue({ id: 'arcanos-intake-model' })
        }
      },
      input: 'Verify the latest competitor moves without browsing and build me a launch plan.',
      body: {
        prompt: 'Verify the latest competitor moves without browsing and build me a launch plan.'
      }
    }));

    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'User needs a launch plan. They also asked to verify the latest competitor moves without browsing, which is not possible in this environment.'
            }
          }
        ],
        activeModel: 'arcanos-intake-model',
        fallbackFlag: false,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25
        },
        id: 'intake-response-1',
        created: 1773339300000
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: [
                'Competitor Moves (as of latest available data):',
                '- Competitors have accelerated feature releases, focusing on AI integration.',
                '- Several have launched bundled offerings and tiered pricing.',
                '',
                'Launch plan:',
                '- Lead with differentiated positioning.',
                '- Prepare a rapid FAQ and objection-handling loop.'
              ].join('\n')
            }
          }
        ],
        activeModel: 'arcanos-final-model',
        fallbackFlag: false,
        usage: {
          prompt_tokens: 20,
          completion_tokens: 30,
          total_tokens: 50
        },
        id: 'final-response-1',
        created: 1773339300100
      });

    mockRunStructuredReasoning.mockResolvedValue({
      reasoning_steps: [
        'Separate the achievable launch-planning work from the unverifiable request to confirm current competitor activity.'
      ],
      assumptions: [
        'No live browsing or external verification capability is available.'
      ],
      constraints: [
        'Current external state cannot be confirmed in this environment.'
      ],
      tradeoffs: [
        'Give a useful launch plan while explicitly declining the unverifiable verification request.'
      ],
      alternatives_considered: [
        'Refusing the whole request'
      ],
      chosen_path_justification: 'Partial refusal preserves usefulness without overstating certainty.',
      response_mode: 'partial_refusal',
      achievable_subtasks: [
        'give the launch plan'
      ],
      blocked_subtasks: [
        'verify the latest competitor moves'
      ],
      user_visible_caveats: [
        'Current competitor activity is unverified here.'
      ],
      claim_tags: [
        {
          claim_text: 'Any competitor commentary here is based on general market patterns rather than live verification.',
          source_type: 'inference',
          confidence: 'low',
          verification_status: 'inferred'
        }
      ],
      final_answer: 'I can provide the launch plan, but I cannot verify the latest competitor moves without live browsing.'
    });
  });

  it('keeps the achievable answer while blocking unsupported verification language at the route boundary', async () => {
    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Verify the latest competitor moves without browsing and build me a launch plan.',
        sessionId: 'honesty-session-1'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.metadata.pipeline).toBe('trinity');
    expect(response.body.result).toContain('Current competitor activity is unverified here.');
    expect(response.body.result).toContain('Lead with differentiated positioning.');
    expect(response.body.result.match(/Current competitor activity is unverified here\./g)).toHaveLength(1);
    expect(response.body.result).not.toContain('Competitors have accelerated feature releases');
    expect(response.body.result).not.toContain('Several have launched bundled offerings');
    expect(response.body.auditSafe).toBeUndefined();
    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(mockRunStructuredReasoning).toHaveBeenCalledTimes(1);
  });

  it('returns a generated prompt for downstream repo work instead of capability disclaimers', async () => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockRunStructuredReasoning.mockReset();

    mockValidateAIRequest.mockImplementation((_req: unknown, _res: unknown) => ({
      client: {
        models: {
          retrieve: jest.fn().mockResolvedValue({ id: 'arcanos-intake-model' })
        }
      },
      input: 'Generate a prompt for Codex to update my documentation in my repo.',
      body: {
        prompt: 'Generate a prompt for Codex to update my documentation in my repo.'
      }
    }));

    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'User wants a prompt for Codex. The downstream executor can inspect the repo, update docs, and run checks.'
            }
          }
        ],
        activeModel: 'arcanos-intake-model',
        fallbackFlag: false,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 12,
          total_tokens: 22
        },
        id: 'intake-response-prompt-1',
        created: 1773339301000
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: [
                "I can't inspect your repo from here.",
                'Prompt for Codex:',
                'Inspect the repository, identify outdated documentation, update the affected docs, run the relevant checks, and summarize the exact files changed.'
              ].join(' ')
            }
          }
        ],
        activeModel: 'arcanos-final-model',
        fallbackFlag: false,
        usage: {
          prompt_tokens: 18,
          completion_tokens: 30,
          total_tokens: 48
        },
        id: 'final-response-prompt-1',
        created: 1773339301100
      });

    mockRunStructuredReasoning.mockResolvedValue({
      reasoning_steps: [
        'The user only wants a prompt for a downstream executor, not direct repo execution here.'
      ],
      assumptions: [
        'Codex can inspect the repository when it receives the generated prompt.'
      ],
      constraints: [],
      tradeoffs: [
        'Preserve actionable downstream instructions without capability disclaimers.'
      ],
      alternatives_considered: [
        'Refusing because the backend cannot inspect the repo directly'
      ],
      chosen_path_justification: 'Prompt generation should treat repo work as downstream instructions.',
      response_mode: 'answer',
      achievable_subtasks: [
        'write a prompt for Codex'
      ],
      blocked_subtasks: [],
      user_visible_caveats: [],
      claim_tags: [
        {
          claim_text: 'The generated prompt may instruct Codex to inspect the repository and run checks.',
          source_type: 'template',
          confidence: 'high',
          verification_status: 'unverified'
        }
      ],
      final_answer: 'Prompt for Codex: Inspect the repository and update the docs.'
    });

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Generate a prompt for Codex to update my documentation in my repo.',
        sessionId: 'honesty-session-prompt-1'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.metadata.pipeline).toBe('trinity');
    expect(response.body.result).toContain('Prompt for Codex:');
    expect(response.body.result).toContain('Inspect the repository');
    expect(response.body.result).not.toContain("I can't inspect your repo from here.");
    expect(response.body.result).not.toContain('cannot verify live or current external information here');
  });

  it('applies honesty rewriting even when direct-answer mode is selected', async () => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockRunStructuredReasoning.mockReset();

    mockValidateAIRequest.mockImplementation((_req: unknown, _res: unknown) => ({
      client: {
        models: {
          retrieve: jest.fn().mockResolvedValue({ id: 'arcanos-intake-model' })
        }
      },
      input: 'Direct answer only: verify the latest competitor moves without browsing and build me a launch plan.',
      body: {
        prompt: 'Direct answer only: verify the latest competitor moves without browsing and build me a launch plan.'
      }
    }));

    mockCreateChatCompletionWithFallback.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: [
              'Latest Competitor Moves (as of June 2024, without live browsing):',
              '',
              '1. Product Innovation: Competitors have accelerated AI integration.',
              '2. Partnerships: Strategic alliances are increasing.',
              '',
              'Launch plan:',
              '1. Lead with differentiated positioning.',
              '2. Prepare a rapid FAQ and objection-handling loop.'
            ].join('\n')
          }
        }
      ],
      activeModel: 'gpt-4.1',
      fallbackFlag: false,
      usage: {
        prompt_tokens: 18,
        completion_tokens: 26,
        total_tokens: 44
      },
      id: 'direct-answer-response-1',
      created: 1773339300200
    });

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Direct answer only: verify the latest competitor moves without browsing and build me a launch plan.',
        sessionId: 'honesty-session-direct-answer-1'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.metadata.pipeline).toBe('trinity');
    expect(response.body.result).toMatch(/can't (?:confirm|verify) current external state here without live access|cannot verify live or current external information here/i);
    expect(response.body.result).toContain('Lead with differentiated positioning.');
    expect(response.body.result).not.toContain('Competitors have accelerated AI integration');
    expect(response.body.result).not.toContain('Strategic alliances are increasing');
    expect(response.body.routingStages).toContain('ARCANOS-DIRECT-ANSWER');
    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(mockRunStructuredReasoning).not.toHaveBeenCalled();
  });

  it('attaches safe bounded diagnostics to direct-answer integrity failures without output text', async () => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockCreateChatCompletionWithFallback.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'The tank should' }
        }
      ],
      provider_metadata: {
        finish_reason: 'stop',
        status: 'completed',
        incomplete_details: { reason: 'none' },
        incomplete: false,
        truncated: false,
        length_truncated: false,
        content_filtered: false
      },
      activeModel: 'gpt-4.1',
      fallbackFlag: false,
      usage: {
        prompt_tokens: 8,
        completion_tokens: 3,
        total_tokens: 11
      },
      id: 'direct-answer-integrity-response-1',
      created: 1773339300250
    });

    let capturedError: unknown;
    try {
      await runThroughBrain(
        {} as Parameters<typeof runThroughBrain>[0],
        'Answer directly: give one tank positioning tip.',
        undefined,
        undefined,
        {
          answerMode: 'direct',
          strictUserVisibleOutput: true,
          sourceEndpoint: 'test.direct-answer-integrity'
        },
        createRuntimeBudget()
      );
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError).toMatchObject({
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      integrityIssues: ['abrupt_mid_sentence_ending'],
      outputChars: 15,
      selectionReason: 'explicit_answer_mode',
      recovery: false,
      trinityStage: 'direct-answer',
      activeModel: 'gpt-4.1',
      finishReason: 'stop',
      responseStatus: 'completed',
      incompleteReason: 'none',
      incomplete: false,
      emptyOutput: false,
      truncated: false,
      lengthTruncated: false,
      contentFiltered: false
    });
    expect(capturedError).not.toHaveProperty('output');
    expect(capturedError).not.toHaveProperty('partialOutput');
    expect(JSON.stringify(capturedError)).not.toContain('The tank should');
  });

  it('repairs broken numbering deterministically without another provider call', async () => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockCreateChatCompletionWithFallback.mockResolvedValueOnce(
      buildIntegrityCompletion({
        content: [
          '1. Cody Rhodes retains cleanly.',
          '3. Rhea Ripley confronts Iyo Sky.',
          '5. CM Punk closes the show.',
        ].join('\n'),
        id: 'integrity-renumber-primary',
      })
    );

    const result = await runThroughBrain(
      {} as Parameters<typeof runThroughBrain>[0],
      'Answer directly with these booking notes.',
      undefined,
      undefined,
      {
        answerMode: 'direct',
        strictUserVisibleOutput: true,
        sourceEndpoint: 'test.backstage-integrity-renumber',
        directAnswerIntegrityRepair: buildIntegrityRepairOptions(),
      },
      createRuntimeBudgetWithLimit(60_000, 0)
    );

    expect(result.result).toBe([
      '1. Cody Rhodes retains cleanly.',
      '2. Rhea Ripley confronts Iyo Sky.',
      '3. CM Punk closes the show.',
    ].join('\n'));
    expect(result.meta.integrityRecovery).toEqual({
      attempted: true,
      method: 'deterministic_renumber',
      originalIssues: ['broken_numbering'],
      repairedIssues: [],
      outcome: 'repaired',
    });
    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it('continues an abrupt ending once, preserves the original facts, and logs only safe classifications', async () => {
    const privateDraft =
      'Cody Rhodes defeats Seth Rollins. PRIVATE-DRAFT-SENTINEL. The closing angle should';
    const privateContinuation =
      'end with Roman Reigns watching from the stage. PRIVATE-CONTINUATION-SENTINEL.';
    mockCreateChatCompletionWithFallback.mockReset();
    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce(buildIntegrityCompletion({
        content: privateDraft,
        id: 'integrity-abrupt-primary',
      }))
      .mockResolvedValueOnce(buildIntegrityCompletion({
        content: privateContinuation,
        id: 'integrity-abrupt-repair',
        completionTokens: 40,
      }));
    const infoSpy = jest
      .spyOn(structuredLogger, 'info')
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(structuredLogger, 'warn')
      .mockImplementation(() => undefined);
    const executionContext = createAiExecutionContext({
      sourceType: 'job',
      sourceName: 'backstage-booker.generateBooking',
      requestId: 'request-integrity-1',
      traceId: 'trace-integrity-1',
      jobId: 'job-integrity-1',
    });

    try {
      const result = await runWithAiExecutionContext(
        executionContext,
        () => runThroughBrain(
          {} as Parameters<typeof runThroughBrain>[0],
          [
            'Answer directly with one complete booking ending.',
            `Use this established ending exactly: The closing angle should ${privateContinuation}`,
          ].join('\n'),
          undefined,
          undefined,
          {
            answerMode: 'direct',
            strictUserVisibleOutput: true,
            sourceEndpoint: 'backstage-booker.generateBooking',
            redactAuditContent: true,
            directAnswerIntegrityRepair: buildIntegrityRepairOptions(),
          },
          createRuntimeBudgetWithLimit(60_000, 0)
        )
      );

      expect(result.result).toContain('Cody Rhodes defeats Seth Rollins.');
      expect(result.result).toContain('PRIVATE-DRAFT-SENTINEL');
      expect(result.result).toContain('The closing angle should');
      expect(result.result).toContain(
        'end with Roman Reigns watching from the stage.'
      );
      expect(result.result).toContain('PRIVATE-CONTINUATION-SENTINEL');
      expect(result.meta.integrityRecovery).toMatchObject({
        attempted: true,
        method: 'bounded_continuation',
        originalIssues: ['abrupt_mid_sentence_ending'],
        repairedIssues: [],
        outcome: 'repaired',
      });
      expect(result.tierInfo?.invocationsUsed).toBe(2);
      expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(2);

      const integrityLogs = [...infoSpy.mock.calls, ...warnSpy.mock.calls]
        .filter(([event]) => String(event).includes('integrity_'));
      const serializedLogs = JSON.stringify(integrityLogs);
      expect(serializedLogs).toContain('trace-integrity-1');
      expect(serializedLogs).toContain('abrupt_mid_sentence_ending');
      expect(serializedLogs).not.toContain('PRIVATE-DRAFT-SENTINEL');
      expect(serializedLogs).not.toContain('PRIVATE-CONTINUATION-SENTINEL');
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('preserves a worker AI budget pause raised by bounded integrity repair', async () => {
    const budgetError = new WorkerAiCallBudgetPausedError(
      '2026-08-30T15:00:00.000Z'
    );
    mockCreateChatCompletionWithFallback.mockReset();
    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce(buildIntegrityCompletion({
        content: 'The closing angle should',
        id: 'integrity-budget-primary',
      }))
      .mockRejectedValueOnce(budgetError);

    await expect(runThroughBrain(
      {} as Parameters<typeof runThroughBrain>[0],
      'Answer directly with this established ending: The closing angle should continue.',
      undefined,
      undefined,
      {
        answerMode: 'direct',
        strictUserVisibleOutput: true,
        sourceEndpoint: 'test.backstage-integrity-budget-pause',
        directAnswerIntegrityRepair: buildIntegrityRepairOptions(),
      },
      createRuntimeBudgetWithLimit(60_000, 0)
    )).rejects.toBe(budgetError);
    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(2);
  });

  it('appends a missing exact final item without changing established items', async () => {
    const establishedItems = [
      '1. Cody Rhodes retains against Seth Rollins.',
      '2. Rhea Ripley confronts Iyo Sky.',
    ].join('\n');
    mockCreateChatCompletionWithFallback.mockReset();
    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce(buildIntegrityCompletion({
        content: establishedItems,
        id: 'integrity-final-section-primary',
      }))
      .mockResolvedValueOnce(buildIntegrityCompletion({
        content: '3. CM Punk closes the show with a staredown.',
        id: 'integrity-final-section-repair',
        completionTokens: 24,
      }));

    const result = await runThroughBrain(
      {} as Parameters<typeof runThroughBrain>[0],
      [
        'Answer directly with exactly three booking items.',
        'The established final sequence is: 2. Rhea Ripley confronts Iyo Sky. 3. CM Punk closes the show with a staredown.',
      ].join('\n'),
      undefined,
      undefined,
      {
        answerMode: 'direct',
        strictUserVisibleOutput: true,
        sourceEndpoint: 'test.backstage-integrity-final-section',
        directAnswerIntegrityRepair: buildIntegrityRepairOptions(3),
      },
      createRuntimeBudgetWithLimit(60_000, 0)
    );

    expect(result.result).toContain('1. Cody Rhodes retains against Seth Rollins.');
    expect(result.result).toContain('2. Rhea Ripley confronts Iyo Sky.');
    expect(result.result).toContain('3. CM Punk closes the show with a staredown.');
    expect(result.meta.integrityRecovery?.originalIssues).toContain(
      'incomplete_final_section'
    );
    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(2);
  });

  it('revalidates a repair once and returns a safe terminal failure when it is still abrupt', async () => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce(buildIntegrityCompletion({
        content: 'The closing angle should',
        id: 'integrity-invalid-primary',
      }))
      .mockResolvedValueOnce(buildIntegrityCompletion({
        content: 'continue and',
        id: 'integrity-invalid-repair',
        completionTokens: 12,
      }));

    let capturedError: unknown;
    try {
      await runThroughBrain(
        {} as Parameters<typeof runThroughBrain>[0],
        'Answer directly with this established ending: The closing angle should continue and',
        undefined,
        undefined,
        {
          answerMode: 'direct',
          strictUserVisibleOutput: true,
          sourceEndpoint: 'test.backstage-integrity-invalid-repair',
          redactAuditContent: true,
          directAnswerIntegrityRepair: buildIntegrityRepairOptions(),
        },
        createRuntimeBudgetWithLimit(60_000, 0)
      );
    } catch (error) {
      capturedError = error;
    }

    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(capturedError).toMatchObject({
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      repairAttempted: true,
      repairFailureReason: 'revalidation_failed',
      originalIntegrityIssues: ['abrupt_mid_sentence_ending'],
      repairedIntegrityIssues: ['abrupt_mid_sentence_ending'],
    });
    expect(JSON.stringify(capturedError)).not.toContain('The closing angle should');
    expect(JSON.stringify(capturedError)).not.toContain('continue and');
  });

  it.each([
    [
      'content-filtered',
      buildIntegrityCompletion({
        content: 'end cleanly without changing the booking.',
        id: 'integrity-repair-content-filtered',
        providerMetadata: {
          finish_reason: 'content_filter',
          incomplete_details: { reason: 'content_filter' },
          incomplete: true,
          content_filtered: true,
        },
      }),
      'content_filtered',
    ],
    [
      'provider-incomplete',
      buildIntegrityCompletion({
        content: 'end cleanly without changing the booking.',
        id: 'integrity-repair-incomplete',
        providerMetadata: {
          finish_reason: 'length',
          incomplete_details: { reason: 'max_output_tokens' },
          incomplete: true,
          truncated: true,
          length_truncated: true,
        },
      }),
      'provider_incomplete',
    ],
    [
      'empty',
      buildIntegrityCompletion({
        content: '',
        id: 'integrity-repair-empty',
      }),
      'empty_output',
    ],
  ])('rejects a %s repair result after exactly one attempt', async (
    _label,
    repairCompletion,
    expectedReason
  ) => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce(buildIntegrityCompletion({
        content: 'The closing angle should',
        id: 'integrity-repair-blocked-primary',
      }))
      .mockResolvedValueOnce(repairCompletion);

    let capturedError: unknown;
    try {
      await runThroughBrain(
        {} as Parameters<typeof runThroughBrain>[0],
        'Answer directly with one complete booking ending.',
        undefined,
        undefined,
        {
          answerMode: 'direct',
          strictUserVisibleOutput: true,
          sourceEndpoint: 'test.backstage-integrity-repair-provider-blocker',
          redactAuditContent: true,
          directAnswerIntegrityRepair: buildIntegrityRepairOptions(),
        },
        createRuntimeBudgetWithLimit(60_000, 0)
      );
    } catch (error) {
      capturedError = error;
    }

    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(capturedError).toMatchObject({
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      repairAttempted: true,
      repairFailureReason: expectedReason,
      originalIntegrityIssues: ['abrupt_mid_sentence_ending'],
      repairedIntegrityIssues: [],
    });
  });

  it.each([
    [
      'content-filtered output',
      buildIntegrityCompletion({
        content: 'The closing angle should',
        id: 'integrity-content-filtered',
        providerMetadata: {
          finish_reason: 'content_filter',
          incomplete_details: { reason: 'content_filter' },
          incomplete: true,
          content_filtered: true,
        },
      }),
      'content_filtered',
    ],
    [
      'empty output',
      buildIntegrityCompletion({
        content: '',
        id: 'integrity-empty',
      }),
      'empty_output',
    ],
    [
      'insufficient remaining tokens',
      buildIntegrityCompletion({
        content: 'The closing angle should',
        id: 'integrity-no-token-budget',
        completionTokens: 2_305,
      }),
      'insufficient_tokens',
    ],
  ])('never repairs %s', async (_label, completion, expectedReason) => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockCreateChatCompletionWithFallback.mockResolvedValueOnce(completion);

    let capturedError: unknown;
    try {
      await runThroughBrain(
        {} as Parameters<typeof runThroughBrain>[0],
        'Answer directly with one complete booking ending.',
        undefined,
        undefined,
        {
          answerMode: 'direct',
          strictUserVisibleOutput: true,
          sourceEndpoint: 'test.backstage-integrity-no-repair',
          redactAuditContent: true,
          directAnswerIntegrityRepair: buildIntegrityRepairOptions(),
        },
        createRuntimeBudgetWithLimit(60_000, 0)
      );
    } catch (error) {
      capturedError = error;
    }

    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(capturedError).toMatchObject({
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      repairAttempted: false,
      repairFailureReason: expectedReason,
    });
  });

  it('normalizes duplicate limitations and scope drift at the route boundary', async () => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockRunStructuredReasoning.mockReset();

    mockValidateAIRequest.mockImplementation((_req: unknown, _res: unknown) => ({
      client: {
        models: {
          retrieve: jest.fn().mockResolvedValue({ id: 'arcanos-intake-model' })
        }
      },
      input: 'Direct answer only under 20 words: give me a launch plan and note any limitation around competitor moves.',
      body: {
        prompt: 'Direct answer only under 20 words: give me a launch plan and note any limitation around competitor moves.',
        answerMode: 'explained'
      }
    }));

    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'User needs a launch plan and a short limitation note about competitor moves.'
            }
          }
        ],
        activeModel: 'arcanos-intake-model',
        fallbackFlag: false,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 10,
          total_tokens: 20
        },
        id: 'intake-response-2',
        created: 1773339300200
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: [
                'I can help with that.',
                "I can't verify current competitor moves or your actual tooling without live browsing.",
                "I can't verify current competitor moves without live browsing.",
                'Plan: spec Mon; build Tue-Wed; QA Thu; launch Fri.'
              ].join(' ')
            }
          }
        ],
        activeModel: 'arcanos-final-model',
        fallbackFlag: false,
        usage: {
          prompt_tokens: 18,
          completion_tokens: 24,
          total_tokens: 42
        },
        id: 'final-response-2',
        created: 1773339300300
      });

    mockRunStructuredReasoning.mockResolvedValue({
      reasoning_steps: [
        'Keep one limitation sentence, then deliver the launch plan.'
      ],
      assumptions: [
        'No live browsing is available.'
      ],
      constraints: [
        'Current competitor moves cannot be verified.'
      ],
      tradeoffs: [
        'Stay concise while preserving the limitation.'
      ],
      alternatives_considered: [
        'Padded preamble'
      ],
      chosen_path_justification: 'A short partial refusal keeps the answer useful and natural.',
      response_mode: 'partial_refusal',
      achievable_subtasks: [
        'give the launch plan'
      ],
      blocked_subtasks: [
        'verify current competitor moves'
      ],
      user_visible_caveats: [
        "I can't verify current competitor moves without live browsing."
      ],
      claim_tags: [
        {
          claim_text: 'Competitor commentary is unverified here.',
          source_type: 'inference',
          confidence: 'low',
          verification_status: 'unverified'
        }
      ],
      final_answer: "I can't verify current competitor moves without live browsing. Plan: spec Mon; build Tue-Wed; QA Thu; launch Fri."
    });

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Direct answer only under 20 words: give me a launch plan and note any limitation around competitor moves.',
        answerMode: 'explained',
        sessionId: 'honesty-session-2'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.result).toContain("I can't verify current competitor moves without live browsing.");
    expect(response.body.result.match(/I can't verify current competitor moves without live browsing\./g)).toHaveLength(1);
    expect(response.body.result).toContain('Plan: spec Mon; build Tue-Wed; QA Thu; launch Fri.');
    expect(response.body.result).not.toContain('I can help with that.');
    expect(response.body.result).not.toContain('actual tooling');
    expect(countWords(response.body.result)).toBeLessThanOrEqual(20);
  });

  it('does not escalate simple-tier requests on low CLEAR scores after compact reasoning succeeds', async () => {
    mockCreateChatCompletionWithFallback.mockReset();
    mockRunStructuredReasoning.mockReset();
    mockRunClearAudit.mockResolvedValue({
      clarity: 1,
      leverage: 1,
      efficiency: 2,
      alignment: 2,
      resilience: 2,
      overall: 1.6
    });

    mockValidateAIRequest.mockImplementation((_req: unknown, _res: unknown) => ({
      client: {
        models: {
          retrieve: jest.fn().mockResolvedValue({ id: 'arcanos-intake-model' })
        }
      },
      input: 'Assess this launch plan and note any limitation around competitor moves.',
      body: {
        prompt: 'Assess this launch plan and note any limitation around competitor moves.',
        answerMode: 'explained'
      }
    }));

    mockCreateChatCompletionWithFallback
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'User needs a launch plan and a limitation note about unverifiable competitor moves.'
            }
          }
        ],
        activeModel: 'arcanos-intake-model',
        fallbackFlag: false,
        usage: {
          prompt_tokens: 12,
          completion_tokens: 10,
          total_tokens: 22
        },
        id: 'intake-response-3',
        created: 1773339300400
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "I can't verify current competitor moves here. Plan: spec Mon; build Tue-Wed; QA Thu; launch Fri."
            }
          }
        ],
        activeModel: 'arcanos-final-model',
        fallbackFlag: false,
        usage: {
          prompt_tokens: 18,
          completion_tokens: 18,
          total_tokens: 36
        },
        id: 'final-response-3',
        created: 1773339300500
      });

    mockRunStructuredReasoning.mockResolvedValue({
      response_mode: 'partial_refusal',
      achievable_subtasks: [
        'give the launch plan'
      ],
      blocked_subtasks: [
        'verify current competitor moves'
      ],
      user_visible_caveats: [
        "I can't verify current competitor moves here."
      ],
      claim_tags: [
        {
          claim_text: 'Competitor commentary is unverified here.',
          source_type: 'inference',
          confidence: 'low',
          verification_status: 'unverified'
        }
      ],
      final_answer: "I can't verify current competitor moves here. Plan: spec Mon; build Tue-Wed; QA Thu; launch Fri."
    });

    const response = await request(buildApp())
      .post('/ask')
      .send({
        prompt: 'Assess this launch plan and note any limitation around competitor moves.',
        answerMode: 'explained',
        sessionId: 'honesty-session-3'
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.result).toContain("I can't verify current competitor moves here.");
    expect(response.body.result).toContain('Plan: spec Mon; build Tue-Wed; QA Thu; launch Fri.');
    expect(mockRunStructuredReasoning).toHaveBeenCalledTimes(1);
    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(mockTrackEscalation).not.toHaveBeenCalled();
  });
});

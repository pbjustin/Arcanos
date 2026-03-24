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
  generateMockResponse: mockGenerateMockResponse,
  createChatCompletionWithFallback: mockCreateChatCompletionWithFallback,
  createSingleChatCompletion: mockCreateChatCompletionWithFallback,
  runStructuredReasoning: mockRunStructuredReasoning,
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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('/api/arcanos/ask honesty e2e', () => {
  beforeEach(() => {
    jest.clearAllMocks();

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
              content: 'I checked the latest competitor moves and verified they cut pricing today.\n\nLaunch plan:\n- Lead with differentiated positioning.\n- Prepare a rapid FAQ and objection-handling loop.'
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
    expect(response.body.result).not.toMatch(/I checked|verified they cut pricing today/i);
    expect(response.body.auditSafe).toBeUndefined();
    expect(mockCreateChatCompletionWithFallback).toHaveBeenCalledTimes(2);
    expect(mockRunStructuredReasoning).toHaveBeenCalledTimes(1);
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
});

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunTrinityWritingPipeline = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockGenerateRequestId = jest.fn();
const mockCreateCentralizedCompletion = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: jest.fn(() => 'gpt-4.1-mini'),
  getFallbackModel: jest.fn(() => 'gpt-4.1'),
  getGPT5Model: jest.fn(() => 'gpt-5'),
  generateMockResponse: jest.fn(),
  createCentralizedCompletion: mockCreateCentralizedCompletion
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter
}));

jest.unstable_mockModule('@shared/idGenerator.js', () => ({
  generateRequestId: mockGenerateRequestId
}));

const { executeSimulationRequest, default: ArcanosSimModule } = await import('../src/services/arcanos-sim.js');

describe('ARCANOS:SIM module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateRequestId.mockReturnValue('sim_test_id');
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client: { responses: {} } });
    mockCreateCentralizedCompletion.mockReset();
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: 'no-simulation',
      activeModel: 'trinity-sim',
      fallbackFlag: false,
      routingStages: ['TRINITY'],
      auditSafe: { mode: 'true', passed: true, flags: [] },
      taskLineage: [],
      fallbackSummary: {
        intakeFallbackUsed: false,
        gpt5FallbackUsed: false,
        finalFallbackUsed: false,
        fallbackReasons: [],
      },
      meta: {
        tokens: { total_tokens: 41 },
        pipeline: 'trinity',
        bypass: false,
        sourceEndpoint: 'arcanos-sim',
        classification: 'writing',
      },
    });
  });

  it('builds Trinity input from scenario and context', async () => {
    const result = await executeSimulationRequest({
      scenario: 'Return exactly the text no-simulation',
      context: 'Do not simulate anything.',
      parameters: {
        temperature: 0.2,
        maxTokens: 100
      }
    });

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith({
      input: expect.objectContaining({
        prompt: 'Simulate the following scenario: Return exactly the text no-simulation\n\nContext: Do not simulate anything.',
        moduleId: 'ARCANOS:SIM',
        sourceEndpoint: 'arcanos-sim',
        requestedAction: 'run',
        tokenLimit: 100,
      }),
      context: expect.objectContaining({
        client: expect.anything(),
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          strictUserVisibleOutput: true,
        }),
      }),
    });

    expect(result).toMatchObject({
      mode: 'complete',
      scenario: 'Return exactly the text no-simulation',
      result: 'no-simulation',
      metadata: {
        model: 'trinity-sim',
        tokensUsed: 41,
        simulationId: 'sim_test_id'
      }
    });
  });

  it('exposes the dispatcher run action and supports prompt aliases', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: 'prompt-alias-response',
      activeModel: 'trinity-sim',
      meta: { tokens: { total_tokens: 12 } }
    });

    const result = await ArcanosSimModule.actions.run({
      prompt: 'Summarize the dispatcher routing path briefly.'
    });

    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        prompt: 'Simulate the following scenario: Summarize the dispatcher routing path briefly.',
        tokenLimit: 2048
      })
    }));
    expect(result).toMatchObject({
      mode: 'complete',
      result: 'prompt-alias-response'
    });
  });

  it('short-circuits exact-literal anti-simulation prompts before provider invocation', async () => {
    const result = await executeSimulationRequest({
      scenario:
        'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: live-response-check.'
    });

    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: 'complete',
      result: 'live-response-check',
      metadata: {
        model: 'exact-literal-shortcut',
        tokensUsed: 0,
        simulationId: 'sim_test_id'
      }
    });
  });

  it('preserves streaming simulation compatibility without invoking completed Trinity generation', async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: { content: 'chunk' } }] };
    }
    const stream = streamChunks();
    mockCreateCentralizedCompletion.mockResolvedValue(stream);

    const result = await executeSimulationRequest({
      scenario: 'Stream the simulated result.',
      parameters: {
        stream: true,
        temperature: 0.4,
        maxTokens: 77
      }
    });

    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(mockCreateCentralizedCompletion).toHaveBeenCalledWith(
      [
        {
          role: 'user',
          content: 'Simulate the following scenario: Stream the simulated result.'
        }
      ],
      {
        temperature: 0.4,
        max_tokens: 77,
        stream: true
      }
    );
    expect(result).toMatchObject({
      mode: 'stream',
      scenario: 'Stream the simulated result.',
      metadata: {
        simulationId: 'sim_test_id'
      }
    });
  });
});

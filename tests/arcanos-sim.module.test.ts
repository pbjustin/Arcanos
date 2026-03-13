import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockCreateCentralizedCompletion = jest.fn();
const mockGenerateRequestId = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  createCentralizedCompletion: mockCreateCentralizedCompletion
}));

jest.unstable_mockModule('@shared/idGenerator.js', () => ({
  generateRequestId: mockGenerateRequestId
}));

const { executeSimulationRequest, default: ArcanosSimModule } = await import('../src/services/arcanos-sim.js');

describe('ARCANOS:SIM module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateRequestId.mockReturnValue('sim_test_id');
  });

  it('builds centralized completion input from scenario and context', async () => {
    mockCreateCentralizedCompletion.mockResolvedValue({
      choices: [{ message: { content: 'no-simulation' } }],
      model: 'ft:test-sim',
      usage: { total_tokens: 41 }
    });

    const result = await executeSimulationRequest({
      scenario: 'Return exactly the text no-simulation',
      context: 'Do not simulate anything.',
      parameters: {
        temperature: 0.2,
        maxTokens: 100
      }
    });

    expect(mockCreateCentralizedCompletion).toHaveBeenCalledWith(
      [
        {
          role: 'user',
          content: 'Simulate the following scenario: Return exactly the text no-simulation\n\nContext: Do not simulate anything.'
        }
      ],
      {
        temperature: 0.2,
        max_tokens: 100,
        stream: false
      }
    );

    expect(result).toMatchObject({
      mode: 'complete',
      scenario: 'Return exactly the text no-simulation',
      result: 'no-simulation',
      metadata: {
        model: 'ft:test-sim',
        tokensUsed: 41,
        simulationId: 'sim_test_id'
      }
    });
  });

  it('exposes the dispatcher run action and supports prompt aliases', async () => {
    mockCreateCentralizedCompletion.mockResolvedValue({
      choices: [{ message: { content: 'prompt-alias-response' } }],
      model: 'ft:test-sim',
      usage: { total_tokens: 12 }
    });

    const result = await ArcanosSimModule.actions.run({
      prompt: 'Summarize the dispatcher routing path briefly.'
    });

    expect(mockCreateCentralizedCompletion).toHaveBeenCalledWith(
      [
        {
          role: 'user',
          content: 'Simulate the following scenario: Summarize the dispatcher routing path briefly.'
        }
      ],
      {
        temperature: 0.8,
        max_tokens: 2048,
        stream: false
      }
    );
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

    expect(mockCreateCentralizedCompletion).not.toHaveBeenCalled();
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
});

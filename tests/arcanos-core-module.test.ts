import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunThroughBrain = jest.fn();
const mockCreateRuntimeBudget = jest.fn(() => ({}));
const mockGenerateMockResponse = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();
const mockExecuteSystemStateRequest = jest.fn();

let ArcanosCoreModule: typeof import('../src/services/arcanos-core.js').default;

beforeEach(async () => {
  jest.resetModules();
  mockRunThroughBrain.mockReset();
  mockCreateRuntimeBudget.mockClear();
  mockGenerateMockResponse.mockReset();
  mockGetOpenAIClientOrAdapter.mockReset();
  mockExecuteSystemStateRequest.mockReset();

  mockGetOpenAIClientOrAdapter.mockReturnValue({ client: null });
  mockGenerateMockResponse.mockReturnValue('mock response');

  jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
    runTrinityWritingPipeline: mockRunThroughBrain,
  }));

  jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
    createRuntimeBudgetWithLimit: mockCreateRuntimeBudget,
    getSafeRemainingMs: jest.fn(() => 36_750),
  }));

  jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
    aiLogger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    logger: {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    },
  }));

  jest.unstable_mockModule('@services/openai.js', () => ({
    generateMockResponse: mockGenerateMockResponse,
  }));

  jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
    getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter,
  }));

  jest.unstable_mockModule('../src/services/systemState.js', () => ({
    executeSystemStateRequest: mockExecuteSystemStateRequest,
  }));

  jest.unstable_mockModule('@arcanos/runtime', () => ({
    getRequestAbortSignal: jest.fn(),
    getRequestAbortContext: jest.fn(() => null),
    getRequestRemainingMs: jest.fn(() => null),
    isAbortError: jest.fn(() => false),
    runWithRequestAbortTimeout: jest.fn(async (_config: unknown, run: () => unknown) => run()),
  }));

  ({ default: ArcanosCoreModule } = await import('../src/services/arcanos-core.js'));
});

describe('ARCANOS core module registration', () => {
  it('registers the canonical arcanos-core GPT ID and required actions', () => {
    expect(ArcanosCoreModule.name).toBe('ARCANOS:CORE');
    expect(ArcanosCoreModule.gptIds).toEqual(
      expect.arrayContaining(['arcanos-core'])
    );
    expect(Object.keys(ArcanosCoreModule.actions)).toEqual(
      expect.arrayContaining(['query', 'system_state'])
    );
  });

  it('fails fast when query payloads omit prompt text', async () => {
    await expect(ArcanosCoreModule.actions.query({})).rejects.toThrow(/Prompt is required/);
  });

  it('keeps system_state on the control path and never invokes Trinity', async () => {
    mockExecuteSystemStateRequest.mockReturnValue({ ok: true, state: 'steady' });

    const result = await ArcanosCoreModule.actions.system_state({});

    expect(result).toEqual({ ok: true, state: 'steady' });
    expect(mockExecuteSystemStateRequest).toHaveBeenCalledWith({});
    expect(mockRunThroughBrain).not.toHaveBeenCalled();
  });
});

import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

const generateMockResponseMock = jest.fn(() => ({
  result: 'mock',
  meta: { id: 'mock', created: Date.now() }
}));
const hasValidAPIKeyMock = jest.fn(() => true);
const getOpenAIClientOrAdapterMock = jest.fn(() => ({ adapter: {}, client: {} }));

let handleAIError: typeof import('../src/transport/http/requestHandler.js').handleAIError;
let isBudgetAbort: typeof import('../src/transport/http/requestHandler.js').isBudgetAbort;

const originalAllowMockFallback = process.env.ALLOW_MOCK_FALLBACK;

function createResponseMock() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(async () => {
  jest.resetModules();
  process.env.ALLOW_MOCK_FALLBACK = 'false';

  generateMockResponseMock.mockClear();
  hasValidAPIKeyMock.mockClear();
  getOpenAIClientOrAdapterMock.mockClear();

  jest.unstable_mockModule('../src/services/openai.js', () => ({
    generateMockResponse: generateMockResponseMock,
    hasValidAPIKey: hasValidAPIKeyMock,
  }));

  jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
    getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock,
  }));

  ({ handleAIError, isBudgetAbort } = await import('../src/transport/http/requestHandler.js'));
});

afterEach(() => {
  if (originalAllowMockFallback === undefined) {
    delete process.env.ALLOW_MOCK_FALLBACK;
  } else {
    process.env.ALLOW_MOCK_FALLBACK = originalAllowMockFallback;
  }
});

describe('requestHandler error mapping', () => {
  it('returns 408 for runtime budget exhaustion', async () => {
    const { RuntimeBudgetExceededError } = await import('../src/runtime/runtimeErrors.js');
    const res = createResponseMock();

    handleAIError(new RuntimeBudgetExceededError(), 'prompt', 'ask', res);

    expect(res.status).toHaveBeenCalledWith(408);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'AI timeout/budget abort',
      code: 'BUDGET_ABORT'
    }));
  });

  it('classifies watchdog threshold messages as budget aborts', () => {
    expect(isBudgetAbort(new Error('Execution exceeded watchdog threshold (70000ms > 60000ms)'))).toBe(true);
  });

  it('returns 500 for non-budget errors when mock fallback is disabled', () => {
    const res = createResponseMock();

    handleAIError(new Error('upstream failure'), 'prompt', 'ask', res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'AI service failure',
      code: 'AI_FAILURE'
    }));
  });
});

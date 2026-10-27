import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const hasValidAPIKeyMock = jest.fn(() => true);
const getOpenAIClientOrAdapterMock = jest.fn(() => ({ adapter: {}, client: {} }));
const recordPromptDebugTraceMock = jest.fn();

jest.unstable_mockModule('../src/services/openai.js', () => ({
  generateMockResponse: jest.fn(),
  hasValidAPIKey: hasValidAPIKeyMock
}));
jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock
}));
jest.unstable_mockModule('../src/services/promptDebugTraceService.js', () => ({
  extractPromptText: (body: { prompt?: unknown }) => typeof body?.prompt === 'string' ? body.prompt : null,
  recordPromptDebugTrace: recordPromptDebugTraceMock
}));

const { validateAIRequest } = await import('../src/transport/http/requestHandler.js');

function validate(body: unknown) {
  const req = { method: 'POST', body, requestId: 'offline-validation' } as Request;
  const res = {} as Response;
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return { req, res, result: validateAIRequest(req, res, 'ask') };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AI request validation compatibility', () => {
  it.each([
    [{ prompt: 42 }, ['prompt: Expected string, received number']],
    [{}, ['prompt: Request must include one of prompt, userInput, content, text, or query fields']],
    [{ prompt: '  ' }, [
      'prompt: Input text must include at least one character',
      'prompt: Request must include one of prompt, userInput, content, text, or query fields'
    ]],
    [{ prompt: 'Valid input', metadata: [] }, ['metadata: Expected object, received array']],
    [{ prompt: 'Valid input', maxWords: 1.5 }, ['maxWords: Expected integer, received float']],
    [{ prompt: 'Valid input', requestedVerbosity: 'verbose' }, [
      "requestedVerbosity: Invalid enum value. Expected 'minimal' | 'normal' | 'detailed', received 'verbose'"
    ]]
  ])('preserves the 400 details and stops before provider access for %j', (body, details) => {
    const { res, result } = validate(body);

    expect(result === null).toBe(true);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request payload for ask', details });
    expect(hasValidAPIKeyMock).not.toHaveBeenCalled();
    expect(getOpenAIClientOrAdapterMock).not.toHaveBeenCalled();
  });

  it('retains arbitrary metadata records and existing input normalization', () => {
    const body = { prompt: '  Valid input  ', metadata: { nested: { items: [1, null, true] } } };
    const { req, res, result } = validate(body);

    expect(result?.input).toBe('Valid input');
    expect(req.body).toEqual({ prompt: 'Valid input', metadata: body.metadata });
    expect(res.status).not.toHaveBeenCalled();
    expect(getOpenAIClientOrAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('retains the UTF-16 input bound for supplementary Unicode characters', () => {
    const { res, result } = validate({ prompt: '😀'.repeat(3001) });

    expect(result === null).toBe(true);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid request payload for ask',
      details: ['prompt: Input text exceeds maximum length of 6000 characters']
    });
    expect(getOpenAIClientOrAdapterMock).not.toHaveBeenCalled();
  });
});

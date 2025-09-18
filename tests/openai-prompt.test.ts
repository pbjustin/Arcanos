import { describe, it, expect, jest, afterEach } from '@jest/globals';

const callOpenAI = jest.fn() as jest.MockedFunction<any>;
const getDefaultModel = jest.fn() as jest.MockedFunction<any>;
const validateAIRequest = jest.fn() as jest.MockedFunction<any>;
const handleAIError = jest.fn() as jest.MockedFunction<any>;

jest.unstable_mockModule('../src/services/openai.js', () => ({
  callOpenAI,
  getDefaultModel
}));

jest.unstable_mockModule('../src/utils/requestHandler.js', () => ({
  validateAIRequest,
  handleAIError
}));

const { handlePrompt } = await import('../src/controllers/openaiController.js');

afterEach(() => {
  jest.clearAllMocks();
});

describe('handlePrompt', () => {
  it('uses provided model when specified', async () => {
    validateAIRequest.mockReturnValue({ input: 'hi', client: {} });
    callOpenAI.mockResolvedValue({ response: {}, output: 'ok' });

    const req: any = { body: { prompt: 'hi', model: 'ft:custom-model' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(callOpenAI).toHaveBeenCalledWith('ft:custom-model', 'hi', 256);
    expect(res.json).toHaveBeenCalledWith({ result: 'ok', model: 'ft:custom-model' });
  });

  it('falls back to default model when none provided', async () => {
    validateAIRequest.mockReturnValue({ input: 'hello', client: {} });
    getDefaultModel.mockReturnValue('ft:default-model');
    callOpenAI.mockResolvedValue({ response: {}, output: 'ok' });

    const req: any = { body: { prompt: 'hello' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(getDefaultModel).toHaveBeenCalled();
    expect(callOpenAI).toHaveBeenCalledWith('ft:default-model', 'hello', 256);
    expect(res.json).toHaveBeenCalledWith({ result: 'ok', model: 'ft:default-model' });
  });
});

import { describe, it, expect, jest, afterEach } from '@jest/globals';

const createCentralizedCompletion = jest.fn();
const getDefaultModel = jest.fn();
const validateAIRequest = jest.fn();
const handleAIError = jest.fn();

jest.unstable_mockModule('../src/services/openai.js', () => ({
  createCentralizedCompletion,
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
    createCentralizedCompletion.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }]
    });

    const req: any = { body: { prompt: 'hi', model: 'ft:custom-model' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(createCentralizedCompletion).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hi' }],
      { model: 'ft:custom-model', max_tokens: 256 }
    );
    expect(res.json).toHaveBeenCalledWith({ result: 'ok', model: 'ft:custom-model' });
  });

  it('falls back to default model when none provided', async () => {
    validateAIRequest.mockReturnValue({ input: 'hello', client: {} });
    getDefaultModel.mockReturnValue('ft:default-model');
    createCentralizedCompletion.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }]
    });

    const req: any = { body: { prompt: 'hello' } };
    const res: any = { json: jest.fn() };

    await handlePrompt(req, res);

    expect(getDefaultModel).toHaveBeenCalled();
    expect(createCentralizedCompletion).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hello' }],
      { model: 'ft:default-model', max_tokens: 256 }
    );
    expect(res.json).toHaveBeenCalledWith({ result: 'ok', model: 'ft:default-model' });
  });
});

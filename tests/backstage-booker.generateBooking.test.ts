import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockCallOpenAI = jest.fn();
const mockGetGPT5Model = jest.fn();
const mockQuery = jest.fn();
const mockSaveMemory = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvNumber = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  callOpenAI: mockCallOpenAI,
  getGPT5Model: mockGetGPT5Model,
  getDefaultModel: jest.fn(() => 'gpt-4.1-mini'),
  getFallbackModel: jest.fn(() => 'gpt-4.1'),
  getComplexModel: jest.fn(() => 'gpt-4.1'),
  hasValidAPIKey: jest.fn(() => true),
  default: {
    callOpenAI: mockCallOpenAI,
    getGPT5Model: mockGetGPT5Model
  }
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  query: mockQuery,
  saveMemory: mockSaveMemory
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber
}));

const { generateBooking } = await import('../src/services/backstage-booker.js');

describe('backstage-booker generateBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(512);
    mockGetGPT5Model.mockReturnValue('gpt-5.1-test');
    mockQuery.mockResolvedValue({ rows: [] });
    mockSaveMemory.mockResolvedValue(undefined);
    mockCallOpenAI.mockResolvedValue({ output: 'Rivalry matrix output' });
  });

  it('falls back to the shared GPT-5 model when USER_GPT_ID is absent', async () => {
    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockCallOpenAI).toHaveBeenCalledWith(
      'gpt-5.1-test',
      expect.stringContaining('Generate three rivalries for RAW after WrestleMania.'),
      512,
      false
    );
  });
});

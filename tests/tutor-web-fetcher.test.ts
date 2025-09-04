import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const fetchAndClean = jest.fn();
const callOpenAI = jest.fn();
const getDefaultModel = jest.fn(() => 'gpt-test');

jest.unstable_mockModule('../src/services/webFetcher.js', () => ({
  fetchAndClean,
}));

jest.unstable_mockModule('../src/services/openai.js', () => ({
  callOpenAI,
  getDefaultModel,
}));

const { handleTutorQuery } = await import('../src/logic/tutor-logic.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Tutor web fetcher integration', () => {
  it('fetches and includes reference text when sourceUrl is credible', async () => {
    fetchAndClean.mockResolvedValue('reference text');
    callOpenAI.mockResolvedValue({ output: 'response' });

    await handleTutorQuery({
      domain: 'default',
      module: 'generic',
      payload: { question: 'What is AI?' },
      sourceUrl: 'https://example.edu/article',
    });

    expect(fetchAndClean).toHaveBeenCalledWith('https://example.edu/article');
    const prompt = callOpenAI.mock.calls[0][1];
    expect(prompt).toContain('reference text');
  });

  it('ignores sourceUrl from non-credible domains', async () => {
    fetchAndClean.mockResolvedValue('reference text');
    callOpenAI.mockResolvedValue({ output: 'response' });

    await handleTutorQuery({
      domain: 'default',
      module: 'generic',
      payload: { question: 'What is AI?' },
      sourceUrl: 'https://example.com',
    });

    expect(fetchAndClean).not.toHaveBeenCalled();
    const prompt = callOpenAI.mock.calls[0][1];
    expect(prompt).not.toContain('reference text');
  });
});

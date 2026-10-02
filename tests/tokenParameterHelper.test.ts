import { getTokenParameter } from '../src/shared/tokenParameterHelper.js';

describe('tokenParameterHelper - Gemini detection and parameter selection', () => {
  test.each([
    ['gemini', 'max_completion_tokens'],
    ['Gemini-1', 'max_completion_tokens'],
    ['google/gemini-1a', 'max_completion_tokens'],
    ['gpt-gemini', 'max_completion_tokens'],
    ['gpt-4.1', 'max_tokens'],
    ['ft:my-finetune', 'max_tokens'],
    ['metagemini', 'max_tokens'] // should NOT match
  ])('model %s -> %s', (modelName, expectedParam) => {
    const result = getTokenParameter(modelName as string, 10);
    if (expectedParam === 'max_tokens') {
      expect(result).toHaveProperty('max_tokens');
      expect(result).not.toHaveProperty('max_completion_tokens');
    } else {
      expect(result).toHaveProperty('max_completion_tokens');
      expect(result).not.toHaveProperty('max_tokens');
    }
  });

  test.each(['gpt-6-luna', 'gpt-6-luna-2026-09-30', 'gpt-6.1-sol', ' GPT-6.1-SOL '])(
    'uses the reviewed GPT-6 completion token parameter for %s', model => {
      expect(getTokenParameter(model, 500)).toEqual({ max_completion_tokens: 500 });
      expect(getTokenParameter(model, 99_999)).toEqual({ max_completion_tokens: 8_000 });
    }
  );

  test('retains unknown-model parameter behavior for unreviewed GPT-6 IDs', () => {
    expect(getTokenParameter('gpt-6-luna-custom', 500)).toEqual({ max_tokens: 500 });
  });

  test('forceParameter option enforces selection', () => {
    const forced = getTokenParameter('gpt-4.1', 5, { forceParameter: 'max_completion_tokens' as any });
    expect(forced).toHaveProperty('max_completion_tokens');
  });
});

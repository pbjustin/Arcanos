import { getTokenParameter } from '../src/utils/tokenParameterHelper';
import { APPLICATION_CONSTANTS } from '../src/utils/constants';

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

  test('forceParameter option enforces selection', () => {
    const forced = getTokenParameter('gpt-4.1', 5, { forceParameter: 'max_completion_tokens' as any });
    expect(forced).toHaveProperty('max_completion_tokens');
  });
});

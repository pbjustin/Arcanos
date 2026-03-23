import { describe, expect, it } from '@jest/globals';
import {
  MOCK_RESPONSE_CONSTANTS,
  MOCK_RESPONSE_MESSAGES,
  truncateInput
} from '../src/platform/runtime/mockResponseConfig.js';

describe('platform/runtime/mockResponseConfig', () => {
  it('exports stable mock constants and messages', () => {
    expect(MOCK_RESPONSE_CONSTANTS.MODEL_NAME).toBe('MOCK');
    expect(MOCK_RESPONSE_CONSTANTS.ROUTING_STAGES).toEqual([
      'ARCANOS-INTAKE:MOCK',
      'GPT5-REASONING',
      'ARCANOS-FINAL'
    ]);
    expect(MOCK_RESPONSE_MESSAGES.NO_API_KEY).toContain('OPENAI_API_KEY');
    expect(MOCK_RESPONSE_MESSAGES.GPT5_ROUTING).toContain('mock');
  });

  it('truncates only when input exceeds the configured preview length', () => {
    expect(truncateInput('short text')).toBe('short text');
    expect(truncateInput('abcdef', 3)).toBe('abc...');
  });
});

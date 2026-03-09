import { describe, expect, it } from '@jest/globals';
import { tryExtractExactLiteralPromptShortcut } from '../src/services/exactLiteralPromptShortcut.js';

describe('exactLiteralPromptShortcut', () => {
  it('extracts literal tokens from explicit colon directives', () => {
    expect(
      tryExtractExactLiteralPromptShortcut(
        'Write exactly this token and nothing else: BLUE-RIVER-1773037986080'
      )
    ).toEqual({
      literal: 'BLUE-RIVER-1773037986080',
      matchedPattern: 'exact_literal_colon'
    });
  });

  it('unwraps quoted reply-with-only directives', () => {
    expect(
      tryExtractExactLiteralPromptShortcut('Reply with "GREEN STONE" only.')
    ).toEqual({
      literal: 'GREEN STONE',
      matchedPattern: 'reply_with_only'
    });
  });

  it('ignores normal generative prompts', () => {
    expect(
      tryExtractExactLiteralPromptShortcut('Return the exact server timestamp and process uptime.')
    ).toBeNull();
  });
});

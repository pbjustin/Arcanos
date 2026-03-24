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

  it('extracts compact reply-with-exactly directives without invoking Trinity', () => {
    expect(
      tryExtractExactLiteralPromptShortcut('Reply with exactly OK.')
    ).toEqual({
      literal: 'OK',
      matchedPattern: 'reply_with_exactly'
    });
  });

  it('accepts directive-only anti-simulation prefixes before a say-exactly clause', () => {
    expect(
      tryExtractExactLiteralPromptShortcut(
        'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: live-response-check.'
      )
    ).toEqual({
      literal: 'live-response-check',
      matchedPattern: 'exact_literal_directive_suffix'
    });
  });

  it('ignores normal generative prompts', () => {
    expect(
      tryExtractExactLiteralPromptShortcut('Return the exact server timestamp and process uptime.')
    ).toBeNull();
  });

  it('ignores say-exactly suffixes when earlier text contains normal semantic content', () => {
    expect(
      tryExtractExactLiteralPromptShortcut(
        'Explain why this response should say exactly: hello'
      )
    ).toBeNull();
  });
});

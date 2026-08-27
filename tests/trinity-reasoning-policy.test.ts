import { describe, expect, it } from '@jest/globals';

import {
  normalizeTrinityReasoningEffort,
  resolveTrinityReasoningMaxOutputTokens,
  resolveTrinityReasoningProviderPolicy,
  supportsDisabledReasoningEffort,
} from '../src/shared/gpt/trinityReasoningPolicy.js';

describe('Trinity reasoning provider policy', () => {
  it.each([
    ['gpt-5', 'none', 'minimal'],
    ['gpt-5-2025-08-07', 'none', 'minimal'],
    ['gpt-5.1', 'none', 'none'],
    ['gpt-5.1-2025-11-13', 'none', 'none'],
    ['gpt-5.6-terra', 'none', 'none'],
    ['gpt-5.6-terra-2026-08-01', 'none', 'none'],
    ['gpt-5-custom', 'none', 'none'],
    ['gpt-5', 'low', 'low'],
    ['gpt-5.6-terra', 'medium', 'medium'],
  ] as const)(
    'maps %s effort %s to %s',
    (model, requestedEffort, expectedEffort) => {
      expect(
        normalizeTrinityReasoningEffort(model, requestedEffort)
      ).toBe(expectedEffort);
    }
  );

  it.each([
    ['gpt-5', false],
    ['gpt-5.1', true],
    ['gpt-5.1-2025-11-13', true],
    ['gpt-5.6-terra', true],
    ['gpt-5.6-terra-2026-08-01', true],
    ['gpt-5-custom', false],
  ] as const)(
    'reports disabled-reasoning support for %s',
    (model, expected) => {
      expect(supportsDisabledReasoningEffort(model)).toBe(expected);
    }
  );

  it.each([
    [undefined, 8_000],
    ['', 8_000],
    ['   ', 8_000],
    ['1.5', 8_000],
    ['4000junk', 8_000],
    ['1e3', 8_000],
    ['+16', 8_000],
    ['0', 8_000],
    ['-1', 8_000],
    ['9007199254740992', 8_000],
    ['1', 16],
    ['15', 16],
    ['16', 16],
    ['4000', 4_000],
    [' 4000 ', 4_000],
    ['8000', 8_000],
    ['12000', 8_000],
  ] as const)(
    'normalizes max-output-token input %j to %i',
    (configuredValue, expectedMaxOutputTokens) => {
      expect(
        resolveTrinityReasoningMaxOutputTokens(configuredValue)
      ).toBe(expectedMaxOutputTokens);
    }
  );

  it('resolves the outbound effort and output cap together', () => {
    expect(resolveTrinityReasoningProviderPolicy({
      model: 'gpt-5.6-terra',
      requestedEffort: 'none',
      configuredMaxOutputTokens: '4000',
    })).toEqual({
      maxOutputTokens: 4_000,
      reasoningEffort: 'none',
    });
  });
});

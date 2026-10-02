import { describe, expect, it } from '@jest/globals';

import {
  normalizeTrinityReasoningEffort,
  normalizeOpenAIModelReasoningEffort,
  resolveOpenAIModelCapabilities,
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
    ['gpt-6-luna', 'none', 'none'],
    ['gpt-6.1-sol', 'none', 'low'],
    ['gpt-6.1-sol-2026-09-30', 'none', 'low'],
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
    ['gpt-6-luna', true],
    ['gpt-6-luna-2026-09-30', true],
    ['gpt-6.1-sol', false],
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

  it.each([
    ['gpt-5', ['minimal', 'low', 'medium', 'high']],
    ['gpt-5.1', ['none', 'low', 'medium', 'high']],
    ['gpt-5.6-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('resolves reviewed capabilities for %s', (model, allowedReasoningEfforts) => {
    expect(resolveOpenAIModelCapabilities(model as string)).toMatchObject({
      allowedReasoningEfforts,
      structuredReasoning: 'supported',
      outputTokenPolicy: {
        responsesParameter: 'max_output_tokens',
        chatParameter: 'max_completion_tokens',
        minimum: 16,
        trinityReasoningMaximum: 8_000,
      },
    });
  });

  it.each(['gpt-6-luna', 'gpt-6.1-sol'])('normalizes minimal to low for %s', model => {
    expect(normalizeOpenAIModelReasoningEffort(model, 'minimal')).toBe('low');
    expect(resolveOpenAIModelCapabilities(model)).toMatchObject({
      normalizeReasoningRequests: true, defaultReasoningEffort: 'medium',
    });
    // API `max` is documented, but cannot be sent through the pinned SDK types.
    expect(() => normalizeOpenAIModelReasoningEffort(model, 'max' as never))
      .toThrow('Reasoning effort max requires an OpenAI SDK update.');
  });

  it.each(['gpt-6-luna-custom', 'gpt-6.1-sol-preview', 'gpt-6.1-luna', 'ft:gpt-6-luna:private', 'constructor', '__proto__']) (
    'does not infer unreviewed capabilities for %s', model => {
      expect(resolveOpenAIModelCapabilities(model)).toMatchObject({
        family: 'unknown', structuredReasoning: 'unverified',
        supportsDisabledReasoning: false, normalizeReasoningRequests: false,
      });
    }
  );

  it('retains the output cap while selecting Sol low for a disabled-reasoning request', () => {
    expect(resolveTrinityReasoningProviderPolicy({
      model: 'gpt-6.1-sol', requestedEffort: 'none', configuredMaxOutputTokens: '99999',
    })).toEqual({ reasoningEffort: 'low', maxOutputTokens: 8_000 });
  });
});

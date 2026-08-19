import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_DEFAULT_ACTION,
  BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS,
  BACKSTAGE_GENERATION_STAGE_TIMEOUT_MAX_MS,
  BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT,
  BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX,
  BACKSTAGE_MUTATION_CONFIRMATION_PROTOCOL,
  buildBackstageBookerTrinityRunOptions,
  buildBackstageMutationConfirmationFingerprintBody,
  isBackstageGptRoute,
  isBackstageMutationAction,
  isBackstagePublicAction,
  resolveBackstageGenerationStageTimeoutMs,
  resolveBackstageGenerationTokenLimit,
  resolveBackstageGptAction,
  resolveBackstageLegacyAction,
} from '../src/shared/backstage/backstageActionPolicy.js';

describe('Backstage action policy', () => {
  it('recognizes only canonical and compatibility Backstage routes', () => {
    expect(isBackstageGptRoute(' BACKSTAGE-BOOKER ')).toBe(true);
    expect(isBackstageGptRoute('backstage')).toBe(true);
    expect(isBackstageGptRoute('arcanos-core')).toBe(false);
  });

  it.each([
    ['non-finite', Number.NaN, BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS],
    ['non-positive', 0, BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS],
    ['sub-millisecond', 0.5, 1],
    ['fractional', 1_234.9, 1_234],
    ['above maximum', 90_000, BACKSTAGE_GENERATION_STAGE_TIMEOUT_MAX_MS],
  ])('bounds a %s generation stage timeout', (_caseName, configured, expected) => {
    expect(resolveBackstageGenerationStageTimeoutMs(configured)).toBe(expected);
  });

  it.each([
    ['non-finite', Number.NaN, BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT],
    ['non-positive', 0, BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT],
    ['sub-token', 0.5, 1],
    ['fractional', 1_200.9, 1_200],
    ['above maximum', 9_000, BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX],
  ])('bounds a %s generation token limit', (_caseName, configured, expected) => {
    expect(resolveBackstageGenerationTokenLimit(configured)).toBe(expected);
  });

  it('assembles strict direct-answer Trinity options without changing inputs', () => {
    expect(buildBackstageBookerTrinityRunOptions({
      model: 'gpt-5.1',
      tokenLimit: 900,
      userIntentPrompt: 'Who is champion?',
      modelStageTimeoutMs: 40_000,
    })).toEqual({
      answerMode: 'direct',
      internalMode: false,
      strictUserVisibleOutput: true,
      directAnswerModelOverride: 'gpt-5.1',
      directAnswerTokenLimitOverride: 900,
      directAnswerTokenCapOverride: BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX,
      directAnswerUserIntentPrompt: 'Who is champion?',
      modelStageTimeoutMs: 40_000,
    });
  });

  it.each([undefined, null, '', '   '])(
    'uses the default action for an absent value %#',
    (value) => {
      expect(resolveBackstageGptAction(value)).toBe(BACKSTAGE_DEFAULT_ACTION);
    }
  );

  it('normalizes supported GPT actions and rejects other values', () => {
    expect(resolveBackstageGptAction(' QUERYCONTINUITY ')).toBe('queryContinuity');
    expect(resolveBackstageGptAction('unknownAction')).toBeNull();
    expect(resolveBackstageGptAction(42)).toBeNull();
  });

  it('accepts only exact legacy actions', () => {
    expect(resolveBackstageLegacyAction('queryContinuity')).toBe('queryContinuity');
    expect(resolveBackstageLegacyAction('QUERYCONTINUITY')).toBeNull();
    expect(resolveBackstageLegacyAction(42)).toBeNull();
  });

  it('classifies public and mutation actions independently', () => {
    expect(isBackstagePublicAction('queryContinuity')).toBe(true);
    expect(isBackstagePublicAction('upsertStoryline')).toBe(false);
    expect(isBackstageMutationAction('upsertStoryline')).toBe(true);
    expect(isBackstageMutationAction('queryContinuity')).toBe(false);
  });

  it('binds mutation confirmation to the protocol, action, and exact body', () => {
    const body = { universeId: 'my-universe-2k26', title: 'Raw' };

    expect(buildBackstageMutationConfirmationFingerprintBody(
      'upsertStoryline',
      body
    )).toEqual({
      protocol: BACKSTAGE_MUTATION_CONFIRMATION_PROTOCOL,
      action: 'upsertStoryline',
      body,
    });
  });
});

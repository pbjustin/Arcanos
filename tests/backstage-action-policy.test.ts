import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_DEFAULT_ACTION,
  BACKSTAGE_BOOKING_HEAVY_CONTEXT_CODE_UNITS,
  BACKSTAGE_BOOKING_HEAVY_EXPECTED_WORDS,
  BACKSTAGE_BOOKING_HEAVY_ITEM_COUNT,
  BACKSTAGE_BOOKING_HEAVY_PROMPT_CODE_UNITS,
  BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS,
  BACKSTAGE_GENERATION_STAGE_TIMEOUT_MAX_MS,
  BACKSTAGE_GENERATION_TOKEN_LIMIT_DEFAULT,
  BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX,
  BACKSTAGE_MUTATION_CONFIRMATION_PROTOCOL,
  buildBackstageBookerTrinityRunOptions,
  buildBackstageMutationConfirmationFingerprintBody,
  classifyBackstageBookerWorkload,
  isBackstageGptRoute,
  isBackstageMutationAction,
  isBackstagePublicAction,
  resolveBackstageGenerationStageTimeoutMs,
  resolveBackstageGenerationTokenLimit,
  resolveBackstageGptAction,
  resolveBackstageLegacyAction,
} from '../src/shared/backstage/backstageActionPolicy.js';

const BASE_WORKLOAD_INPUT = {
  action: 'generateBooking' as const,
  authorizationEstablished: true,
  requestedExecutionMode: null,
  promptCodeUnits: 120,
  contextCodeUnits: 0,
  expectedItemCount: 1,
  expectedOutputWords: 120,
  notionAuthorityContext: false,
  providerInvocationRequired: true,
};

describe('Backstage action policy', () => {
  describe('booking workload classification', () => {
    it('requires the queue for a production-sized booking even when sync was requested', () => {
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        requestedExecutionMode: 'sync',
        expectedItemCount: 6,
      })).toMatchObject({
        workloadClass: 'production_generation',
        queueRequired: true,
        forceSynchronous: false,
        reason: 'expected_item_count',
        requestedExecutionMode: 'sync',
      });
    });

    it('keeps lightweight continuity synchronous', () => {
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        action: 'queryContinuity',
        requestedExecutionMode: 'async',
      })).toMatchObject({
        workloadClass: 'lightweight',
        queueRequired: false,
        forceSynchronous: true,
        reason: 'continuity_sync',
      });
    });

    it('keeps a bounded one-match booking synchronous by default and honors safe async', () => {
      expect(classifyBackstageBookerWorkload(BASE_WORKLOAD_INPUT)).toMatchObject({
        workloadClass: 'bounded_small',
        queueRequired: false,
        forceSynchronous: false,
        reason: 'bounded_small_sync',
      });
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        requestedExecutionMode: 'async',
      })).toMatchObject({
        workloadClass: 'bounded_small',
        queueRequired: false,
        reason: 'safe_explicit_async',
      });
    });

    it('does not grant queue execution to unknown, mutation, or unauthenticated work', () => {
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        action: null,
        expectedItemCount: 12,
      })).toMatchObject({
        workloadClass: 'not_applicable',
        queueRequired: false,
      });
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        action: 'upsertStoryline',
        expectedItemCount: 12,
      })).toMatchObject({
        workloadClass: 'not_applicable',
        queueRequired: false,
      });
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        action: 'simulateMatch',
        expectedItemCount: 12,
      })).toMatchObject({
        workloadClass: 'not_applicable',
        queueRequired: false,
        reason: 'unknown_or_non_generation_action',
      });
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        authorizationEstablished: false,
        expectedItemCount: 12,
      })).toMatchObject({
        workloadClass: 'validation_only',
        queueRequired: false,
        reason: 'authorization_not_established',
      });
    });

    it('keeps exact no-provider generation synchronous', () => {
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        requestedExecutionMode: 'async',
        promptCodeUnits: BACKSTAGE_BOOKING_HEAVY_PROMPT_CODE_UNITS,
        providerInvocationRequired: false,
      })).toMatchObject({
        workloadClass: 'lightweight',
        queueRequired: false,
        forceSynchronous: true,
        reason: 'provider_not_required',
      });
    });

    it.each([
      ['prompt', 'promptCodeUnits', BACKSTAGE_BOOKING_HEAVY_PROMPT_CODE_UNITS],
      ['context', 'contextCodeUnits', BACKSTAGE_BOOKING_HEAVY_CONTEXT_CODE_UNITS],
      ['items', 'expectedItemCount', BACKSTAGE_BOOKING_HEAVY_ITEM_COUNT],
      ['words', 'expectedOutputWords', BACKSTAGE_BOOKING_HEAVY_EXPECTED_WORDS],
    ] as const)('uses a deterministic inclusive %s boundary', (_label, key, boundary) => {
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        [key]: boundary - 1,
      }).queueRequired).toBe(false);
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        [key]: boundary,
      }).queueRequired).toBe(true);
    });

    it('classifies HRC and Notion-authoritative generation as queue-required', () => {
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        action: 'generateBookingWithHRC',
      })).toMatchObject({ queueRequired: true, reason: 'generate_booking_with_hrc' });
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        notionAuthorityContext: true,
      })).toMatchObject({ queueRequired: true, reason: 'notion_authority_context' });
      expect(classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        action: 'generateBookingWithHRC',
        providerInvocationRequired: false,
      })).toMatchObject({ queueRequired: true, reason: 'generate_booking_with_hrc' });
    });

    it('returns only bounded workload metadata and never accepts raw content', () => {
      const decision = classifyBackstageBookerWorkload({
        ...BASE_WORKLOAD_INPUT,
        contextCodeUnits: 7_500,
      });
      const serializedDecision = JSON.stringify(decision);

      expect(serializedDecision).not.toContain('private-prompt-sentinel');
      expect(serializedDecision).not.toContain('private-notion-sentinel');
      expect(Object.keys(decision).sort()).toEqual([
        'contextCodeUnits',
        'expectedItemCount',
        'expectedOutputWords',
        'forceSynchronous',
        'notionAuthorityContext',
        'promptCodeUnits',
        'providerInvocationRequired',
        'queueRequired',
        'reason',
        'requestedExecutionMode',
        'workloadClass',
      ]);
    });
  });

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
      watchdogTimeoutMs: 50_000,
      modelStageTimeoutMs: 40_000,
    })).toEqual({
      answerMode: 'direct',
      intentMode: 'EXECUTE_TASK',
      internalMode: false,
      strictUserVisibleOutput: true,
      directAnswerModelOverride: 'gpt-5.1',
      directAnswerTokenLimitOverride: 900,
      directAnswerTokenCapOverride: BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX,
      directAnswerUserIntentPrompt: 'Who is champion?',
      watchdogModelTimeoutMs: 50_000,
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

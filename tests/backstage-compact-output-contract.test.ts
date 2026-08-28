import { describe, expect, it, jest } from '@jest/globals';

import {
  parseBackstageDirectAnswerOutputContract,
  resolveBackstageCompactOutputContract,
  runBackstageBookerCompactOutputAttempts,
  type BackstageCompactOutputAttemptEvent,
} from '../src/shared/backstage/backstageCompactOutputContract.js';

function lengthExhaustion(privatePartial: string): Error {
  return Object.assign(new Error(privatePartial), {
    code: 'OPENAI_COMPLETION_INCOMPLETE',
    finishReason: 'length',
    incompleteReason: 'max_output_tokens',
    outputText: privatePartial,
  });
}

describe('Backstage compact output count semantics', () => {
  it.each([
    'Answer directly. Give me one complete Raw card.',
    'Answer directly. Give me two complete Raw cards as independent alternatives.',
  ])('does not treat a wrestling card as one compact output item: %s', prompt => {
    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requiresShortBullets: false,
    });
    expect(resolveBackstageCompactOutputContract(prompt, 6_000).itemPolicy)
      .toEqual({ mode: 'default', count: 8, budgetItemCount: 8 });
  });

  it('honors an explicit compact bullet contract attached to a complete card', () => {
    const prompt = 'Give me one complete Raw card in three short bullets.';

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'exact',
      requiresShortBullets: true,
    });
  });

  it.each([
    ['Give me 1 short bullet.', 1, true],
    ['Give me 3 booking ideas.', 3, false],
    ['Give me 5 possible matches.', 5, false],
    ['Give me 6 options.', 6, false],
  ] as const)('preserves genuine compact request %s', (prompt, count, short) => {
    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: count,
      requestedBulletCountMode: 'exact',
      requiresShortBullets: short,
    });
  });
});

describe('Backstage compact output attempt state machine', () => {
  it('runs exactly one eligible compact retry and reports bounded state transitions', async () => {
    const events: BackstageCompactOutputAttemptEvent[] = [];
    const runAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-FIRST-PARTIAL'))
      .mockResolvedValueOnce('1. Complete compact result.');

    await expect(runBackstageBookerCompactOutputAttempts(
      runAttempt,
      () => true,
      event => events.push(event)
    )).resolves.toEqual({
      result: '1. Complete compact result.',
      usedCompactOutputRetry: true,
    });

    expect(runAttempt.mock.calls).toEqual([[false], [true]]);
    expect(events).toEqual([
      'initial_length_exhaustion',
      'compact_retry_started',
      'compact_retry_provider_completed',
    ]);
  });

  it('does not let a throwing telemetry observer alter retry semantics', async () => {
    const runAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-FIRST-PARTIAL'))
      .mockResolvedValueOnce('1. Complete compact result.');

    await expect(runBackstageBookerCompactOutputAttempts(
      runAttempt,
      () => true,
      () => {
        throw new Error('telemetry unavailable');
      }
    )).resolves.toEqual({
      result: '1. Complete compact result.',
      usedCompactOutputRetry: true,
    });
    expect(runAttempt.mock.calls).toEqual([[false], [true]]);
  });

  it('does not retry content filtering or arbitrary provider errors', async () => {
    const contentFilter = Object.assign(new Error('filtered'), {
      code: 'OPENAI_COMPLETION_INCOMPLETE',
      finishReason: 'content_filter',
      incompleteReason: 'content_filter',
      contentFiltered: true,
    });

    for (const failure of [contentFilter, new Error('provider unavailable')]) {
      const runAttempt = jest
        .fn<(compactOutputRetry: boolean) => Promise<string>>()
        .mockRejectedValueOnce(failure);
      const events: BackstageCompactOutputAttemptEvent[] = [];

      await expect(runBackstageBookerCompactOutputAttempts(
        runAttempt,
        () => true,
        event => events.push(event)
      )).rejects.toBe(failure);
      expect(runAttempt).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);
    }
  });

  it('skips retry when the finite recovery gate is unavailable', async () => {
    const events: BackstageCompactOutputAttemptEvent[] = [];
    const runAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-SKIPPED-PARTIAL'));

    await expect(runBackstageBookerCompactOutputAttempts(
      runAttempt,
      () => false,
      event => events.push(event)
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
      retryable: false,
    });
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'initial_length_exhaustion',
      'compact_retry_skipped_insufficient_budget',
    ]);
  });

  it('fails closed after a second length exhaustion without a third attempt or partial leak', async () => {
    const events: BackstageCompactOutputAttemptEvent[] = [];
    const runAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-FIRST-PARTIAL'))
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-RETRY-PARTIAL'));

    let failure: unknown;
    try {
      await runBackstageBookerCompactOutputAttempts(
        runAttempt,
        () => true,
        event => events.push(event)
      );
    } catch (error) {
      failure = error;
    }

    expect(runAttempt.mock.calls).toEqual([[false], [true]]);
    expect(events).toEqual([
      'initial_length_exhaustion',
      'compact_retry_started',
      'compact_retry_length_exhausted',
    ]);
    expect(failure).toMatchObject({
      code: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
      message:
        'Backstage Booker could not produce a complete response within the output limit. Narrow the request and try again.',
      retryable: false,
    });
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain('PRIVATE-FIRST-PARTIAL');
    expect(JSON.stringify(failure)).not.toContain('PRIVATE-RETRY-PARTIAL');
  });
});

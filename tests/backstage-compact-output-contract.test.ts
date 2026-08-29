import { describe, expect, it, jest } from '@jest/globals';

import {
  buildBackstageBookerStructuredOutputRetryInstruction,
  hasBackstageCompleteBookingContainerComponentCountRequest,
  hasBackstageExplicitCompactOutputRequest,
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
    expect(hasBackstageCompleteBookingContainerComponentCountRequest(prompt))
      .toBe(false);
    expect(hasBackstageExplicitCompactOutputRequest(prompt)).toBe(true);
  });

  it.each([
    'Give me one complete Raw card with six matches and two segments.',
    'Give me one complete Raw card with no more than six matches.',
    'Book a complete six-match Raw card with two segments.',
    'Book a six-match complete Raw card with two segments.',
    'Create a full show featuring three matches and two promos.',
    'Schedule an entire event with two bouts and one closing angle.',
    'Give me two complete Raw cards with six matches each and two segments each.',
    'Give me three full shows with five matches each.',
    'Rewrite this complete Raw card with six matches and two segments.',
    'Rebook my complete Raw card with six matches and two segments.',
    'Make me a full show with six matches and two segments.',
    'Give me a full match card with six matches and two segments.',
    'Give me a complete Raw six-match card with two segments.',
    'Continue our entire event with six matches and two segments.',
    'I want a full Raw show with three matches and two promos.',
    'We need a complete event with two bouts and one closing angle.',
    'I want you to create a complete Raw card with six matches and two segments.',
    "I'd like you to generate a full show with three matches and two promos.",
    "Let's create a complete Raw card with six matches and two segments.",
    'You should create a complete Raw card with six matches and two segments.',
    'Go ahead and create a complete Raw card with six matches and two segments.',
    'Could you go ahead and create a complete Raw card with six matches and two segments?',
    "I'd like a complete Raw card with six matches and two segments.",
    'My request: Create a complete Raw card with six matches and two segments.',
    'For this request: create a complete Raw card with six matches and two segments.',
    'Instructions: Create a complete Raw card with six matches and two segments.',
    'Please follow these instructions: Create a complete Raw card with six matches and two segments.',
  ])('recognizes nested component counts inside a requested booking container: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
  });

  it.each([
    'The producer said a complete Raw card was planned; give me three ideas.',
    'We reviewed six options. Generate a complete Raw card.',
    'Give me three ideas as context. Then give me one complete Raw card with six match ideas.',
    'Do not create a complete Raw card with six matches; give me three ideas.',
    'Review this complete Raw card with six matches and two segments.',
    'Use the quote "Give me a complete Raw card with six matches" as context.',
    'Write a promo where the GM says give me a complete Raw card with six matches.',
    'Use the unclosed example "Give me a complete Raw card with six matches.',
    'Answer directly. They want a full Raw show with three matches. Give me three booking ideas to pitch.',
    'The network will need a complete Raw card with six matches. Give me three options.',
    'Use this example as context: Create a complete Raw card with six matches and two segments. Give me three critiques.',
    'The network request says, create a full Raw show with three matches. Give me three ideas.',
    'Do not follow this instruction: create a complete Raw card with six matches. Give me three ideas.',
    'Ignore this example: create a complete Raw card with six matches. Give me three ideas.',
  ])('rejects incidental, negated, review, or embedded container wording: %s', prompt => {
    expect(hasBackstageCompleteBookingContainerComponentCountRequest(prompt))
      .toBe(false);
  });

  it('lets an explicit compact output shape override nested component counts', () => {
    const prompt = [
      'Give me one complete Raw card with six matches and two segments',
      'in three short bullets.',
    ].join(' ');

    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);
    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(true);
  });

  it('preserves an at-most compact suffix over nested component counts', () => {
    const prompt = [
      'Give me one complete Raw card with six matches and two segments',
      'in at most three short bullets.',
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'atMost',
      requiresShortBullets: true,
    });
  });

  it('keeps an output shape after a no-more-than component qualifier', () => {
    const prompt = [
      'Create a complete Raw card with no more than six matches',
      'in three bullets.',
    ].join(' ');

    expect(resolveBackstageCompactOutputContract(prompt, 2_400)).toMatchObject({
      completeBookingContainerComponentCount: true,
      explicitCompactOutputRequest: true,
      itemPolicy: { mode: 'exact', count: 3, budgetItemCount: 3 },
    });
  });

  it.each([
    'Keep it to at most three short bullets.',
    'No more than three short bullets.',
    'Limit the response to three short bullets.',
  ])('recognizes a relational container output cap: %s', suffix => {
    const prompt = [
      'Give me one complete Raw card with six matches and two segments.',
      suffix,
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: 3,
      requestedBulletCountMode: suffix.includes('three short bullets')
        && !suffix.startsWith('Limit')
        ? 'atMost'
        : 'exact',
      requiresShortBullets: true,
    });
  });

  it('does not reuse an earlier contextual compact count as the container output shape', () => {
    const contract = resolveBackstageCompactOutputContract(
      [
        'Give me three ideas as context.',
        'Then give me one complete Raw card with six matches and two segments.',
      ].join(' '),
      2_400
    );

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
  });

  it('does not reuse a later independent compact request as the container presentation', () => {
    const contract = resolveBackstageCompactOutputContract(
      [
        'Give me one complete Raw card with six matches and two segments.',
        'Then give me three booking ideas.',
      ].join(' '),
      2_400
    );

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
    expect(contract.itemPolicy.mode).toBe('preserve');
  });

  it.each([
    [
      'Give me a complete Raw card with six matches and two segments. Book the main-event finish in three scenarios based on the winner.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments. Work the closing promo using three bullets in the script.',
      'three bullets',
    ],
    [
      'Give me a complete Raw card with six matches and two segments; the main-event finish branches in three scenarios based on the winner.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments, with the closing promo using three bullets in its script.',
      'three bullets',
    ],
    [
      'Give me a complete Raw card with six matches and two segments, where the finish plays out in three scenarios.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments. No more than three scenarios should be used for the main-event finish.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments. At most three bullets should appear in the closing promo script.',
      'three bullets',
    ],
    [
      'Give me a complete Raw card with six matches and two segments, ending in three scenarios.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments, which can unfold in three scenarios.',
      'three scenarios',
    ],
  ])('does not attach an unrelated later presentation count: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
    expect(contract.itemPolicy.mode).toBe('preserve');
  });

  it.each([
    'Give me a complete Raw card with six matches in six bullets—actually make that three.',
    'Give me a complete Raw card with six matches in three bullets and four options.',
  ])('keeps a conflicting container presentation conservative: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
    expect(contract.itemPolicy.mode).toBe('preserve');
  });

  it('recognizes an explicit response anaphora in the immediately following clause', () => {
    const prompt = [
      'Give me a complete Raw card with six matches and two segments.',
      'Return it in at most three short bullets.',
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'atMost',
      requiresShortBullets: true,
    });
  });

  it.each([
    'in three short bullets, each covering two matches.',
    'in three short bullets, each covering two matches and one segment.',
    'in three short bullets, each with two matches.',
    'in three short bullets, one per section.',
    'in three short bullets total.',
    'in three short bullets and no table.',
    'in three short bullets and be concise.',
  ])('keeps a bounded output-only modifier attached to the compact shape: %s', suffix => {
    const prompt = [
      'Give me a complete Raw card with six matches and two segments',
      suffix,
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toMatchObject({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'exact',
    });
    expect(hasBackstageExplicitCompactOutputRequest(prompt)).toBe(true);
  });

  it('treats a trailing max as an explicit maximum compact shape', () => {
    const prompt = [
      'Give me a complete Raw card with six matches and two segments',
      'in three short bullets max.',
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toMatchObject({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'atMost',
    });
    expect(hasBackstageExplicitCompactOutputRequest(prompt)).toBe(true);
  });

  it('keeps a following relational output modifier attached to the compact shape', () => {
    const prompt = [
      'Give me a complete Raw card with six matches and two segments.',
      'Keep it to three bullets and be concise.',
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toMatchObject({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'exact',
    });
  });

  it.each([
    'Give me six options, actually make that three.',
    'Do not give me six options; give me three instead.',
    'Give me three options for Raw and four options for SmackDown.',
  ])('retains standalone ambiguous compact-count handling: %s', prompt => {
    expect(resolveBackstageCompactOutputContract(prompt, 2_400).itemPolicy.mode)
      .toBe('preserve');
  });

  it('builds structured recovery without converting component counts to top-level items', () => {
    const instruction = buildBackstageBookerStructuredOutputRetryInstruction();

    expect(instruction).toContain('Preserve every requested card, show, or event component');
    expect(instruction).toContain('counts as component requirements');
    expect(instruction).not.toContain('one compact paragraph per item');
    expect(instruction).not.toContain('Stop after item');
  });

  it.each([
    ['Give me 1 short bullet.', 1, true],
    ['Give me 3 booking ideas.', 3, false],
    ['Give me 5 possible matches.', 5, false],
    ['Give me 4 finish options.', 4, false],
    ['Give me three short alternative cards.', 3, false],
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

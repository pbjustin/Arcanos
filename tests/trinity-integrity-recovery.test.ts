import { describe, expect, it } from '@jest/globals';

import {
  appendTrinityIntegrityContinuation,
  buildTrinityIntegrityRepairSystemPolicy,
  buildTrinityIntegrityRepairUntrustedContext,
  classifyTrinityIntegrityRepairFailure,
  classifyTrinityProviderIntegrityBlocker,
  repairTrinityBrokenNumbering,
  resolveTrinityIntegrityRepairDecision,
  TRINITY_INTEGRITY_REPAIR_UNAVAILABLE,
} from '../src/core/logic/trinityIntegrityRecovery.js';
import {
  computeTierSoftCap,
  createTrinityWatchdog,
} from '../src/core/logic/trinityGuards.js';
import { validateTrinityAnswerIntegrity } from '../src/core/logic/trinityHonesty.js';
import type { TrinityDirectAnswerIntegrityRepairOptions } from '../src/core/logic/trinityTypes.js';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';

const REPAIR_OPTIONS: TrinityDirectAnswerIntegrityRepairOptions = {
  maxAttempts: 1,
  timeoutMs: 45_000,
  tokenLimit: 1_200,
  totalOutputTokenCap: 6_000,
  minimumOutputTokens: 1_200,
  minimumRuntimeRemainingMs: 45_000,
  minimumRequestRemainingMs: 45_000,
  expectedNumberedItemCount: 3,
};

function decide(overrides: Partial<Parameters<
  typeof resolveTrinityIntegrityRepairDecision
>[0]> = {}) {
  return resolveTrinityIntegrityRepairDecision({
    options: REPAIR_OPTIONS,
    integrity: {
      valid: false,
      issues: ['abrupt_mid_sentence_ending'],
    },
    provider: {
      finishReason: 'stop',
      responseStatus: 'completed',
      incomplete: false,
      emptyOutput: false,
      truncated: false,
      lengthTruncated: false,
      contentFiltered: false,
    },
    outputCodeUnits: 2_000,
    sourceCodeUnits: 12_000,
    primaryCompletionTokens: 4_800,
    runtimeRemainingMs: 45_000,
    requestRemainingMs: 45_000,
    repairAttempted: false,
    ...overrides,
  });
}

describe('Trinity bounded integrity recovery', () => {
  it('reserves one bounded repair stage without exceeding runtime or model caps', () => {
    const runtimeBudget = createRuntimeBudgetWithLimit(170_000, 0);
    const watchdog = createTrinityWatchdog(
      'complex',
      runtimeBudget,
      'gpt-5.1',
      170_000,
      60_000
    );

    expect(watchdog.recoveryReserveMs).toBe(45_000);
    expect(watchdog.tierSoftCap).toBe(computeTierSoftCap('complex') + 45_000);
    expect(watchdog.effectiveLimit).toBeLessThanOrEqual(170_000);
    expect(watchdog.effectiveLimit).toBeLessThanOrEqual(watchdog.modelCapMs);
    expect(watchdog.effectiveLimit).toBeLessThanOrEqual(watchdog.remainingBudgetMs);
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN, -1, 0])(
    'does not introduce an unbounded watchdog reserve for %s',
    (recoveryReserveMs) => {
      const watchdog = createTrinityWatchdog(
        'complex',
        createRuntimeBudgetWithLimit(170_000, 0),
        'gpt-5.1',
        170_000,
        recoveryReserveMs
      );

      expect(watchdog.recoveryReserveMs).toBe(0);
      expect(watchdog.tierSoftCap).toBe(computeTierSoftCap('complex'));
      expect(Number.isFinite(watchdog.effectiveLimit)).toBe(true);
    }
  );

  it.each([
    ['broken numbering', ['broken_numbering'], 'deterministic_renumber'],
    ['abrupt ending', ['abrupt_mid_sentence_ending'], 'bounded_continuation'],
    ['incomplete final section', ['incomplete_final_section'], 'bounded_continuation'],
  ] as const)('admits one narrowly recoverable %s pass', (
    _label,
    issues,
    method
  ) => {
    expect(decide({ integrity: { valid: false, issues: [...issues] } })).toEqual({
      eligible: true,
      method,
      timeoutMs: 45_000,
      tokenLimit: 1_200,
    });
  });

  it('rejects safety-bearing and fallback-splice classifications', () => {
    expect(decide({
      integrity: {
        valid: false,
        issues: ['broken_numbering', 'fallback_spliced_mid_answer'],
      },
    })).toEqual({ eligible: false, reason: 'non_recoverable_issue' });
  });

  it.each([
    ['content filter', { contentFiltered: true }, 'content_filtered'],
    ['length truncation', { lengthTruncated: true }, 'provider_incomplete'],
    ['incomplete response', { incomplete: true }, 'provider_incomplete'],
    ['empty output', { emptyOutput: true }, 'empty_output'],
  ] as const)('never repairs provider %s metadata', (_label, provider, reason) => {
    expect(decide({ provider })).toEqual({ eligible: false, reason });
  });

  it.each([
    [{ contentFiltered: true }, 'content_filtered'],
    [{ finishReason: 'content_filter' }, 'content_filtered'],
    [{ emptyOutput: true }, 'empty_output'],
    [{ incomplete: true }, 'provider_incomplete'],
    [{ lengthTruncated: true }, 'provider_incomplete'],
    [undefined, null],
  ] as const)('classifies provider repair blockers from closed metadata', (
    provider,
    expected
  ) => {
    expect(classifyTrinityProviderIntegrityBlocker(provider)).toBe(expected);
  });

  it('never repairs an actually empty answer', () => {
    expect(decide({ outputCodeUnits: 0 })).toEqual({
      eligible: false,
      reason: 'empty_output',
    });
  });

  it('enforces the exact time boundary without an unbounded timeout', () => {
    expect(decide({ runtimeRemainingMs: 45_000 })).toMatchObject({
      eligible: true,
      timeoutMs: 45_000,
    });
    expect(decide({ runtimeRemainingMs: 44_999 })).toEqual({
      eligible: false,
      reason: 'insufficient_time',
    });
    expect(decide({
      options: { ...REPAIR_OPTIONS, timeoutMs: Number.POSITIVE_INFINITY },
    })).toEqual({ eligible: false, reason: 'invalid_configuration' });
    expect(decide({
      options: { ...REPAIR_OPTIONS, timeoutMs: 0.5 },
    })).toEqual({ eligible: false, reason: 'invalid_configuration' });
    expect(decide({
      options: { ...REPAIR_OPTIONS, expectedNumberedItemCount: 2.5 },
    })).toEqual({ eligible: false, reason: 'invalid_configuration' });
  });

  it('reserves the repair token floor from the shared total cap', () => {
    expect(decide({ primaryCompletionTokens: 4_800 })).toMatchObject({
      eligible: true,
      tokenLimit: 1_200,
    });
    expect(decide({ primaryCompletionTokens: 4_801 })).toEqual({
      eligible: false,
      reason: 'insufficient_tokens',
    });
    expect(decide({ primaryCompletionTokens: Number.NaN })).toEqual({
      eligible: false,
      reason: 'insufficient_tokens',
    });
    expect(decide({ primaryCompletionTokens: 0 })).toEqual({
      eligible: false,
      reason: 'insufficient_tokens',
    });
  });

  it('cannot authorize a second repair attempt', () => {
    expect(decide({ repairAttempted: true })).toEqual({
      eligible: false,
      reason: 'already_attempted',
    });
  });

  it('renumbers detected markers while preserving every item body', () => {
    const repaired = repairTrinityBrokenNumbering(
      '1. Cody Rhodes retains cleanly. 3. Rhea Ripley confronts Iyo Sky. 5. CM Punk closes the show.'
    );

    expect(repaired).toBe(
      '1. Cody Rhodes retains cleanly. 2. Rhea Ripley confronts Iyo Sky. 3. CM Punk closes the show.'
    );
    expect(repaired).toContain('Cody Rhodes retains cleanly.');
    expect(repaired).toContain('Rhea Ripley confronts Iyo Sky.');
    expect(repaired).toContain('CM Punk closes the show.');
  });

  it('renumbers only top-level multiline items and preserves nested numbering', () => {
    const repaired = repairTrinityBrokenNumbering([
      ' 1. Raw opener.',
      '   1. Nested production note.',
      ' 3. Raw main event.',
    ].join('\n'));

    expect(repaired).toBe([
      ' 1. Raw opener.',
      '   1. Nested production note.',
      ' 2. Raw main event.',
    ].join('\n'));
  });

  it('does not reinterpret event numbers in single-line prose as list markers', () => {
    const original =
      'At WrestleMania 41. Cody Rhodes retains. At WrestleMania 42. Roman Reigns challenges.';

    expect(repairTrinityBrokenNumbering(original)).toBe(original);
  });

  it('does not renumber line-leading event sequence facts that do not begin at one', () => {
    const original = [
      '41. WrestleMania closes with Cody Rhodes retaining.',
      '42. WrestleMania opens the next chapter.',
    ].join('\n');

    expect(repairTrinityBrokenNumbering(original)).toBe(original);
  });

  it('fails closed instead of rewriting a factual year mixed into a numbered list', () => {
    const original = [
      '1. Cody Rhodes retains cleanly.',
      '2026. The Raw season continues after WrestleMania.',
      '3. Rhea Ripley wins the main event.',
    ].join('\n');
    const repaired = repairTrinityBrokenNumbering(original, 3);

    expect(repaired).toBe(original);
    expect(repaired).toContain('2026.');
    expect(validateTrinityAnswerIntegrity({
      text: repaired,
      expectedNumberedItemCount: 3,
    })).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(['broken_numbering']),
    });
  });

  it('renumbers a genuine single-line list without rewriting numbers inside item prose', () => {
    const original =
      '1. At WrestleMania 41. Cody Rhodes retains. 3. At WrestleMania 42. Roman Reigns challenges.';

    expect(repairTrinityBrokenNumbering(original)).toBe(
      '1. At WrestleMania 41. Cody Rhodes retains. 2. At WrestleMania 42. Roman Reigns challenges.'
    );
  });

  it('uses an append-only continuation that preserves established facts byte-for-byte', () => {
    const original = 'Cody Rhodes defeats Seth Rollins. The closing angle should';
    const repaired = appendTrinityIntegrityContinuation(
      original,
      'end with Roman Reigns watching from the stage.',
      {
        sourceRequestAndContext:
          'The closing angle should end with Roman Reigns watching from the stage.',
      }
    );

    expect(repaired).toBe(
      'Cody Rhodes defeats Seth Rollins. The closing angle should end with Roman Reigns watching from the stage.'
    );
    expect(repaired?.startsWith(original)).toBe(true);
  });

  it('rejects a structurally valid continuation that is not grounded in supplied facts', () => {
    expect(appendTrinityIntegrityContinuation(
      'Cody Rhodes defeats Seth Rollins. The closing angle should',
      'end with INVENTED-RESULT-777 awarding CM Punk the WWE title.',
      {
        sourceRequestAndContext:
          'Cody Rhodes defeats Seth Rollins and celebrates after the closing angle.',
      }
    )).toBeNull();
  });

  it('rejects a repeated grounded fact that does not continue the draft trailing anchor', () => {
    expect(appendTrinityIntegrityContinuation(
      'Cody Rhodes defeats Seth Rollins. The closing angle should',
      'Cody Rhodes defeats Seth Rollins.',
      {
        sourceRequestAndContext:
          'Cody Rhodes defeats Seth Rollins. The closing angle should end with Roman Reigns watching from the stage.',
      }
    )).toBeNull();
  });

  it.each([
    ['', 'empty'],
    [TRINITY_INTEGRITY_REPAIR_UNAVAILABLE, 'unavailable sentinel'],
    [
      'Cody Rhodes defeats Seth Rollins. The closing angle should be rewritten completely.',
      'repeated draft',
    ],
  ])('rejects an unsafe %s continuation', (continuation) => {
    expect(appendTrinityIntegrityContinuation(
      'Cody Rhodes defeats Seth Rollins. The closing angle should',
      continuation,
      {
        sourceRequestAndContext:
          'Cody Rhodes defeats Seth Rollins. The closing angle should end safely.',
      }
    )).toBeNull();
  });

  it('frames the private draft and continuity only as untrusted provider input', () => {
    const privateDraft = 'PRIVATE-DRAFT-SENTINEL';
    const privateContinuity = 'PRIVATE-CONTINUITY-SENTINEL';
    const policy = buildTrinityIntegrityRepairSystemPolicy([
      'abrupt_mid_sentence_ending',
    ]);
    const context = buildTrinityIntegrityRepairUntrustedContext({
      sourceRequestAndContext: 'Book Raw.',
      supplementalContext: privateContinuity,
      originalDraft: privateDraft,
    });

    expect(policy).toContain('Return only the minimal text');
    expect(policy).toContain('Do not introduce or change names');
    expect(policy).not.toContain(privateDraft);
    expect(policy).not.toContain(privateContinuity);
    expect(context).toContain(privateDraft);
    expect(context).toContain(privateContinuity);
    expect(context).toContain('UNTRUSTED_INTEGRITY_REPAIR_DATA');
  });

  it.each([
    [{ contentFiltered: true }, 'content_filtered'],
    [{ code: 'OPENAI_COMPLETION_INCOMPLETE' }, 'provider_incomplete'],
    [{ name: 'AbortError' }, 'provider_timeout'],
    [new Error('private provider failure'), 'provider_failure'],
  ] as const)('reduces repair failures to a safe classification', (error, expected) => {
    expect(classifyTrinityIntegrityRepairFailure(error)).toBe(expected);
  });
});

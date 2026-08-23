import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE,
  BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE,
  BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE,
  BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_MESSAGE,
  BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE,
  BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_MESSAGE,
  BackstageBookerOutputIncompleteError,
  BackstageBookerIntegrityFailedError,
  BackstageContinuityQueryFailedError,
  isBackstageBookerOutputIncompleteError,
  isBackstageBookerIntegrityFailedError,
  isBackstageContinuityQueryFailedError,
  isBackstageProviderOutputLengthExhaustionError,
  toBackstageBookerIntegrityFailedError,
} from '../src/shared/backstage/backstageGenerationError.js';

describe('Backstage generation errors', () => {
  it.each([
    ['maximum output tokens', { code: 'OPENAI_COMPLETION_INCOMPLETE', incompleteReason: 'max_output_tokens' }],
    ['length finish reason', { code: 'OPENAI_COMPLETION_INCOMPLETE', finishReason: 'length' }],
    ['length-truncated marker', { code: 'OPENAI_COMPLETION_INCOMPLETE', lengthTruncated: true }],
  ])('recognizes provider %s exhaustion', (_caseName, error) => {
    expect(isBackstageProviderOutputLengthExhaustionError(error)).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['wrong code', { code: 'OTHER', incompleteReason: 'max_output_tokens' }],
    ['content-filtered marker', { code: 'OPENAI_COMPLETION_INCOMPLETE', contentFiltered: true, incompleteReason: 'max_output_tokens' }],
    ['content-filter finish reason', { code: 'OPENAI_COMPLETION_INCOMPLETE', finishReason: 'content_filter', lengthTruncated: true }],
    ['content-filter incomplete reason', { code: 'OPENAI_COMPLETION_INCOMPLETE', incompleteReason: 'content_filter', lengthTruncated: true }],
    ['unrecognized incomplete reason', { code: 'OPENAI_COMPLETION_INCOMPLETE', incompleteReason: 'other' }],
    ['unknown incomplete reason over legacy length flags', {
      code: 'OPENAI_COMPLETION_INCOMPLETE',
      incompleteReason: 'unknown',
      finishReason: 'length',
      lengthTruncated: true,
    }],
    ['missing-reason sentinel over legacy length flags', {
      code: 'OPENAI_COMPLETION_INCOMPLETE',
      incompleteReason: 'none',
      finishReason: 'length',
      lengthTruncated: true,
    }],
  ])('rejects %s as output-length exhaustion', (_caseName, error) => {
    expect(isBackstageProviderOutputLengthExhaustionError(error)).toBe(false);
  });

  it('constructs and recognizes the cause-free output-incomplete error', () => {
    const error = new BackstageBookerOutputIncompleteError();

    expect(error).toMatchObject({
      name: 'BackstageBookerOutputIncompleteError',
      code: BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE,
      message: BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE,
      retryable: false,
    });
    expect(isBackstageBookerOutputIncompleteError(error)).toBe(true);
    expect(isBackstageBookerOutputIncompleteError(new Error('other'))).toBe(false);
  });

  it('constructs and recognizes the cause-free continuity-query failure', () => {
    const error = new BackstageContinuityQueryFailedError();

    expect(error).toMatchObject({
      name: 'BackstageContinuityQueryFailedError',
      code: BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE,
      message: BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_MESSAGE,
      retryable: false,
    });
    expect(isBackstageContinuityQueryFailedError(error)).toBe(true);
    expect(isBackstageContinuityQueryFailedError(new Error('other'))).toBe(false);
  });

  it('collapses Trinity repair diagnostics to a cause-free safe terminal error', () => {
    const error = toBackstageBookerIntegrityFailedError({
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      integrityIssues: ['abrupt_mid_sentence_ending', 'PRIVATE-ISSUE'],
      originalIntegrityIssues: ['abrupt_mid_sentence_ending'],
      repairedIntegrityIssues: ['broken_numbering', 'PRIVATE-REPAIRED-ISSUE'],
      repairAttempted: true,
      repairFailureReason: 'revalidation_failed',
      output: 'PRIVATE-GENERATED-OUTPUT',
    });

    expect(error).toBeInstanceOf(BackstageBookerIntegrityFailedError);
    expect(error).toMatchObject({
      name: 'BackstageBookerIntegrityFailedError',
      code: BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE,
      message: BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_MESSAGE,
      retryable: false,
      integrityIssues: ['abrupt_mid_sentence_ending'],
      originalIntegrityIssues: ['abrupt_mid_sentence_ending'],
      repairedIntegrityIssues: ['broken_numbering'],
      repairAttempted: true,
      repairFailureReason: 'revalidation_failed',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(isBackstageBookerIntegrityFailedError(error)).toBe(true);
  });

  it('rejects non-Trinity failures and unknown repair reasons', () => {
    expect(toBackstageBookerIntegrityFailedError(new Error('other'))).toBeNull();
    expect(toBackstageBookerIntegrityFailedError(null)).toBeNull();
    expect(toBackstageBookerIntegrityFailedError({
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      integrityIssues: ['broken_numbering'],
      repairAttempted: false,
    })).toMatchObject({
      repairFailureReason: undefined,
    });
    const error = new BackstageBookerIntegrityFailedError({
      integrityIssues: ['broken_numbering'],
      repairAttempted: false,
      repairFailureReason: 'PRIVATE-REASON',
    });

    expect(error.repairFailureReason).toBeUndefined();
    expect(isBackstageBookerIntegrityFailedError(new Error('other'))).toBe(false);
  });

  it('preserves the original classification when repair was skipped', () => {
    const error = toBackstageBookerIntegrityFailedError({
      code: 'TRINITY_OUTPUT_INTEGRITY_FAILED',
      integrityIssues: ['abrupt_mid_sentence_ending'],
      repairAttempted: false,
      repairFailureReason: 'insufficient_time',
    });

    expect(error).toMatchObject({
      integrityIssues: ['abrupt_mid_sentence_ending'],
      originalIntegrityIssues: ['abrupt_mid_sentence_ending'],
      repairedIntegrityIssues: [],
      repairAttempted: false,
      repairFailureReason: 'insufficient_time',
    });
  });
});

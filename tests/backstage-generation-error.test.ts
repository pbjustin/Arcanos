import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE,
  BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE,
  BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE,
  BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_MESSAGE,
  BackstageBookerOutputIncompleteError,
  BackstageContinuityQueryFailedError,
  isBackstageBookerOutputIncompleteError,
  isBackstageContinuityQueryFailedError,
  isBackstageProviderOutputLengthExhaustionError,
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
});

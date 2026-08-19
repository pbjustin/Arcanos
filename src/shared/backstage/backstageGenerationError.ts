export const BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE =
  'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE';
export const BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE =
  'Backstage Booker could not produce a complete response within the output limit. Narrow the request and try again.';
export const BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE =
  'BACKSTAGE_CONTINUITY_QUERY_FAILED';
export const BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_MESSAGE =
  'Backstage Booker could not complete the continuity query.';

interface ProviderCompletionErrorShape {
  code?: unknown;
  contentFiltered?: unknown;
  finishReason?: unknown;
  incompleteReason?: unknown;
  lengthTruncated?: unknown;
}

/**
 * Recognize only provider completion failures caused by exhausting the output
 * length budget. Content-filtered responses must never enter compact retry.
 */
export function isBackstageProviderOutputLengthExhaustionError(
  value: unknown
): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as ProviderCompletionErrorShape;
  if (
    candidate.code !== 'OPENAI_COMPLETION_INCOMPLETE'
    || candidate.contentFiltered === true
    || candidate.finishReason === 'content_filter'
    || candidate.incompleteReason === 'content_filter'
  ) {
    return false;
  }

  return candidate.incompleteReason === 'max_output_tokens'
    || candidate.finishReason === 'length'
    || candidate.lengthTruncated === true;
}

/** Safe terminal error for any Booker action that cannot fit a complete output. */
export class BackstageBookerOutputIncompleteError extends Error {
  readonly code = BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE;
  readonly retryable = false;

  constructor() {
    super(BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE);
    this.name = 'BackstageBookerOutputIncompleteError';
  }
}

export function isBackstageBookerOutputIncompleteError(
  value: unknown
): value is BackstageBookerOutputIncompleteError {
  return value instanceof BackstageBookerOutputIncompleteError;
}

/** Cause-free terminal error for an internal continuity-query failure. */
export class BackstageContinuityQueryFailedError extends Error {
  readonly code = BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_CODE;
  readonly retryable = false;

  constructor() {
    super(BACKSTAGE_CONTINUITY_QUERY_FAILED_ERROR_MESSAGE);
    this.name = 'BackstageContinuityQueryFailedError';
  }
}

export function isBackstageContinuityQueryFailedError(
  value: unknown
): value is BackstageContinuityQueryFailedError {
  return value instanceof BackstageContinuityQueryFailedError;
}

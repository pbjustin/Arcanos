export const BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_CODE =
  'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE';
export const BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE_ERROR_MESSAGE =
  'Backstage Booker could not produce a complete response within the output limit. Narrow the request and try again.';
export const BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE =
  'BACKSTAGE_BOOKER_INTEGRITY_FAILED';
export const BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_MESSAGE =
  'Backstage Booker could not produce a structurally complete response.';
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

const BACKSTAGE_SAFE_INTEGRITY_ISSUES = new Set([
  'abrupt_mid_sentence_ending',
  'broken_numbering',
  'incomplete_final_section',
  'fallback_spliced_mid_answer',
]);

const BACKSTAGE_SAFE_INTEGRITY_FAILURE_REASONS = new Set([
  'already_attempted',
  'content_filtered',
  'disabled',
  'empty_output',
  'insufficient_time',
  'insufficient_tokens',
  'invalid_configuration',
  'invalid_continuation',
  'non_recoverable_issue',
  'provider_failure',
  'provider_incomplete',
  'provider_timeout',
  'repair_source_too_large',
  'revalidation_failed',
]);

function readSafeIntegrityIssues(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (issue): issue is string =>
            typeof issue === 'string'
            && BACKSTAGE_SAFE_INTEGRITY_ISSUES.has(issue)
        )
        .slice(0, 8)
    : [];
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

  if (
    candidate.incompleteReason !== undefined
    && candidate.incompleteReason !== null
  ) {
    return candidate.incompleteReason === 'max_output_tokens';
  }

  return candidate.finishReason === 'length'
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

/** Cause-free terminal structural failure safe for HTTP and durable jobs. */
export class BackstageBookerIntegrityFailedError extends Error {
  readonly code = BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_CODE;
  readonly retryable = false;
  readonly integrityIssues: string[];
  readonly originalIntegrityIssues: string[];
  readonly repairedIntegrityIssues: string[];
  readonly repairAttempted: boolean;
  readonly repairFailureReason?: string;

  constructor(input: {
    integrityIssues: string[];
    originalIntegrityIssues?: string[];
    repairedIntegrityIssues?: string[];
    repairAttempted: boolean;
    repairFailureReason?: string;
  }) {
    super(BACKSTAGE_BOOKER_INTEGRITY_FAILED_ERROR_MESSAGE);
    this.name = 'BackstageBookerIntegrityFailedError';
    this.integrityIssues = readSafeIntegrityIssues(input.integrityIssues);
    const originalIntegrityIssues = readSafeIntegrityIssues(
      input.originalIntegrityIssues ?? input.integrityIssues
    );
    this.originalIntegrityIssues = originalIntegrityIssues.length > 0
      ? originalIntegrityIssues
      : this.integrityIssues;
    this.repairedIntegrityIssues = readSafeIntegrityIssues(
      input.repairedIntegrityIssues
    );
    this.repairAttempted = input.repairAttempted;
    if (
      input.repairFailureReason
      && BACKSTAGE_SAFE_INTEGRITY_FAILURE_REASONS.has(input.repairFailureReason)
    ) {
      this.repairFailureReason = input.repairFailureReason;
    }
  }
}

export function isBackstageBookerIntegrityFailedError(
  value: unknown
): value is BackstageBookerIntegrityFailedError {
  return value instanceof BackstageBookerIntegrityFailedError;
}

/** Collapse a Trinity integrity error to a bounded cause-free Booker error. */
export function toBackstageBookerIntegrityFailedError(
  value: unknown
): BackstageBookerIntegrityFailedError | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.code !== 'TRINITY_OUTPUT_INTEGRITY_FAILED') {
    return null;
  }
  return new BackstageBookerIntegrityFailedError({
    integrityIssues: readSafeIntegrityIssues(candidate.integrityIssues),
    originalIntegrityIssues: readSafeIntegrityIssues(
      candidate.originalIntegrityIssues
    ),
    repairedIntegrityIssues: readSafeIntegrityIssues(
      candidate.repairedIntegrityIssues
    ),
    repairAttempted: candidate.repairAttempted === true,
    ...(typeof candidate.repairFailureReason === 'string'
      ? { repairFailureReason: candidate.repairFailureReason }
      : {}),
  });
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

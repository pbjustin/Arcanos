/**
 * Reusable Error Handling Utilities
 * 
 * Provides consistent error classification, retry eligibility determination,
 * and user-friendly error messages across the entire codebase.
 * 
 * Features:
 * - Railway-native error handling
 * - Consistent error classification
 * - Retry eligibility determination
 * - User-friendly error messages
 * - Audit trail for all error handling
 * 
 * @module reusable
 */

import { ErrorType, classifyError, isRetryableError as isRetryable } from './classification.js';
import { resolveErrorMessage, mapErrorToFriendlyMessage } from './messages.js';
import { aiLogger } from '@platform/logging/structuredLogging.js';
import { recordTraceEvent } from '@platform/logging/telemetry.js';

/**
 * Error classification result
 */
export interface ErrorClassification {
  /** Error type classification */
  type: ErrorType;
  /** Whether error is retryable */
  retryable: boolean;
  /** User-friendly error message */
  message: string;
  /** Original error message */
  originalMessage: string;
  /** HTTP status code if available */
  statusCode?: number;
  /** Error code if available */
  errorCode?: string;
}

/**
 * Retry delay calculation result
 */
export interface RetryDelayResult {
  /** Calculated delay in milliseconds */
  delay: number;
  /** Whether jitter was applied */
  jitterApplied: boolean;
  /** Reason for the delay calculation */
  reason: string;
}

/**
 * Classifies an OpenAI error and determines retry eligibility
 * 
 * This function provides consistent error handling across the codebase:
 * - Classifies error type (rate limit, network, server, etc.)
 * - Determines if error is retryable
 * - Provides user-friendly error messages
 * - Logs error with proper context
 * 
 * @param error - Error to classify
 * @returns Error classification result
 */
export function classifyOpenAIError(error: unknown): ErrorClassification {
  const startTime = Date.now();
  const traceId = recordTraceEvent('error.classify.start', {
    errorType: error instanceof Error ? error.constructor.name : typeof error
  });

  try {
    const errorType = classifyError(error);
    const retryable = isRetryable(error);
    const originalMessage = resolveErrorMessage(error);
    const friendlyMessage = mapErrorToFriendlyMessage(error) || originalMessage;

    // Extract status code and error code if available
    let statusCode: number | undefined;
    let errorCode: string | undefined;

    if (error && typeof error === 'object') {
      const errorObj = error as { status?: unknown; code?: unknown };
      if (typeof errorObj.status === 'number') {
        statusCode = errorObj.status;
      }
      if (typeof errorObj.code === 'string') {
        errorCode = errorObj.code;
      }
    }

    const classification: ErrorClassification = {
      type: errorType,
      retryable,
      message: friendlyMessage,
      originalMessage,
      statusCode,
      errorCode
    };

    const duration = Date.now() - startTime;
    recordTraceEvent('error.classify.success', {
      traceId,
      duration,
      errorType,
      retryable,
      statusCode
    });

    return classification;
  } catch (classificationError) {
    const duration = Date.now() - startTime;
    aiLogger.error('Failed to classify error', {
      module: 'errors.reusable',
      operation: 'classifyOpenAIError',
      duration
    }, undefined, classificationError as Error);

    recordTraceEvent('error.classify.error', {
      traceId,
      duration,
      error: classificationError instanceof Error ? classificationError.message : String(classificationError)
    });

    // Fallback classification
    return {
      type: ErrorType.UNKNOWN,
      retryable: false,
      message: 'An unexpected error occurred',
      originalMessage: resolveErrorMessage(error)
    };
  }
}

/**
 * Determines if an error is retryable
 * 
 * This is a convenience wrapper around the classification function
 * for cases where only retry eligibility is needed.
 * 
 * @param error - Error to check
 * @returns True if error is retryable, false otherwise
 */
export function isRetryableError(error: unknown): boolean {
  return isRetryable(error);
}

/**
 * Calculates retry delay with exponential backoff and jitter
 * 
 * Implements Railway-native retry strategy:
 * - Exponential backoff for transient errors
 * - Additional jitter for rate limit errors
 * - Configurable base delay and max delay
 * - Deterministic calculation (same inputs = same output)
 * 
 * @param error - Error that triggered the retry
 * @param attempt - Current retry attempt (1-indexed)
 * @param baseDelayMs - Base delay in milliseconds (default: 1000)
 * @param maxDelayMs - Maximum delay in milliseconds (default: 30000)
 * @param multiplier - Exponential multiplier (default: 2)
 * @param jitterMaxMs - Maximum jitter in milliseconds for rate limits (default: 2000)
 * @returns Retry delay result
 */
export function getRetryDelay(
  error: unknown,
  attempt: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 30000,
  multiplier: number = 2,
  jitterMaxMs: number = 2000
): RetryDelayResult {
  const classification = classifyOpenAIError(error);
  
  // Calculate exponential backoff
  const exponentialDelay = Math.min(
    baseDelayMs * Math.pow(multiplier, attempt - 1),
    maxDelayMs
  );

  // Add jitter for rate limit errors
  let delay = exponentialDelay;
  let jitterApplied = false;

  if (classification.type === ErrorType.RATE_LIMIT) {
    const jitter = Math.random() * jitterMaxMs;
    delay = exponentialDelay + jitter;
    jitterApplied = true;
  }

  const reason = classification.type === ErrorType.RATE_LIMIT
    ? 'rate_limit_with_jitter'
    : classification.retryable
    ? 'exponential_backoff'
    : 'no_retry';

  return {
    delay: Math.round(delay),
    jitterApplied,
    reason
  };
}

/**
 * Formats an error message for user display
 * 
 * Provides user-friendly error messages while preserving
 * technical details for logging and debugging.
 * 
 * @param error - Error to format
 * @param includeTechnical - Whether to include technical details (default: false)
 * @returns Formatted error message
 */
export function formatErrorMessage(error: unknown, includeTechnical: boolean = false): string {
  const classification = classifyOpenAIError(error);
  
  if (includeTechnical) {
    return `${classification.message} (${classification.type}${classification.statusCode ? `, status: ${classification.statusCode}` : ''})`;
  }
  
  return classification.message;
}

/**
 * Determines if an error should be retried based on attempt count
 * 
 * Combines error classification with attempt limits to determine
 * if a retry should be attempted.
 * 
 * @param error - Error that occurred
 * @param attempt - Current attempt number (1-indexed)
 * @param maxRetries - Maximum number of retries allowed
 * @returns True if retry should be attempted, false otherwise
 */
export function shouldRetry(error: unknown, attempt: number, maxRetries: number): boolean {
  if (attempt >= maxRetries) {
    return false;
  }
  
  return isRetryableError(error);
}

/**
 * Gets a user-friendly error message for an error
 * 
 * Convenience function that combines classification and formatting.
 * 
 * @param error - Error to get message for
 * @returns User-friendly error message
 */
export function getUserFriendlyMessage(error: unknown): string {
  return formatErrorMessage(error, false);
}

/**
 * Gets a technical error message for logging
 * 
 * Includes technical details useful for debugging and monitoring.
 * 
 * @param error - Error to get message for
 * @returns Technical error message
 */
export function getTechnicalMessage(error: unknown): string {
  return formatErrorMessage(error, true);
}

/**
 * Default export for convenience
 */
export default {
  classifyOpenAIError,
  isRetryableError,
  getRetryDelay,
  formatErrorMessage,
  shouldRetry,
  getUserFriendlyMessage,
  getTechnicalMessage
};

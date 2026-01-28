/**
 * OpenAI-Specific Error Handling
 * Provides specialized error handling logic for OpenAI API requests
 */

import { isRetryableError, classifyError, ErrorType } from './classification.js';
import { resolveErrorMessage } from './messages.js';
import { logOpenAIFailure, logOpenAIEvent } from '../../utils/openaiLogger.js';
import { OPENAI_LOG_MESSAGES } from '../../config/openaiLogMessages.js';

/**
 * Handle OpenAI request error with classification and logging
 * Extracts nested error handling logic from makeOpenAIRequest
 * 
 * @returns Object indicating whether to retry and relevant metadata
 */
export const handleOpenAIRequestError = (
  err: unknown,
  attempt: number,
  maxRetries: number
): {
  shouldRetry: boolean;
  errorType: ErrorType;
  message: string;
} => {
  const isRetryable = isRetryableError(err);
  //audit Assumption: retry only if error is retryable and attempts remain
  const shouldRetry = attempt < maxRetries && isRetryable;
  const errorType = classifyError(err);
  const message = resolveErrorMessage(err);
  const errorInstance = err instanceof Error ? err : undefined;

  // Log the failure with classification
  //audit Assumption: logging should include classification metadata for audit
  logOpenAIFailure(
    'warn',
    OPENAI_LOG_MESSAGES.REQUEST.FAILED_ATTEMPT(attempt, maxRetries, String(errorType)),
    {
      attempt,
      maxRetries,
      errorType,
      message
    },
    errorInstance
  );

  if (!shouldRetry) {
    //audit Assumption: final failure requires error-level log; Handling: emit once
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.REQUEST.FAILED_PERMANENT(attempt), undefined, errorInstance);
  } else {
    //audit Assumption: retry attempts should be traceable; Handling: info log
    logOpenAIEvent('info', OPENAI_LOG_MESSAGES.REQUEST.RETRY, {
      attemptsRemaining: maxRetries - attempt,
      errorType,
      message
    });
  }

  return {
    shouldRetry,
    errorType,
    message
  };
};

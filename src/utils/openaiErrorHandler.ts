/**
 * OpenAI Error Handling Utilities
 * Provides reusable error handling logic for OpenAI requests
 */

import { isRetryableError, classifyError } from './errorClassification.js';
import { logOpenAIFailure, logOpenAIEvent } from './openaiLogger.js';
import { OPENAI_LOG_MESSAGES } from '../config/openaiLogMessages.js';

/**
 * Handle OpenAI request error with classification and logging
 * Extracts nested error handling logic from makeOpenAIRequest
 * 
 * @returns Object indicating whether to retry and relevant metadata
 */
export const handleOpenAIRequestError = (
  err: any,
  attempt: number,
  maxRetries: number
): {
  shouldRetry: boolean;
  errorType: string;
  message: string;
} => {
  const isRetryable = isRetryableError(err);
  const shouldRetry = attempt < maxRetries && isRetryable;
  const errorType = classifyError(err);
  const message = err.message || 'Unknown error';

  // Log the failure with classification
  logOpenAIFailure(
    'warn',
    OPENAI_LOG_MESSAGES.REQUEST.FAILED_ATTEMPT(attempt, maxRetries, errorType),
    {
      attempt,
      maxRetries,
      errorType,
      message
    },
    err
  );

  if (!shouldRetry) {
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.REQUEST.FAILED_PERMANENT(attempt), undefined, err);
  } else {
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

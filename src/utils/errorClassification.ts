/**
 * Error Classification Utilities
 * Reusable functions for classifying and handling errors
 */

/**
 * Error types for classification
 */
export enum ErrorType {
  RATE_LIMIT = 'RATE_LIMIT',
  SERVER_ERROR = 'SERVER_ERROR',
  TIMEOUT = 'TIMEOUT',
  NETWORK_ERROR = 'NETWORK_ERROR',
  CLIENT_ERROR = 'CLIENT_ERROR',
  UNKNOWN = 'UNKNOWN'
}

/**
 * Determines if an error is retryable based on error taxonomy
 * 
 * Error Taxonomy:
 * - 429 (Rate Limit): Retryable with exponential backoff + jitter
 * - 5xx (Server Error): Retryable with capped retries
 * - Network errors (ECONNRESET, ETIMEDOUT): Retryable with backoff
 * - 4xx (Client Error, except 429): Not retryable
 * 
 * @param error - Error object to classify
 * @returns True if the error should be retried, false otherwise
 */
export function isRetryableError(error: any): boolean {
  // Network errors and timeouts are retryable
  if (error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
    return true;
  }
  
  // OpenAI API rate limits (429) and server errors (5xx) are retryable
  if (error.status) {
    return error.status === 429 || error.status >= 500;
  }
  
  // Default to non-retryable for unknown errors
  return false;
}

/**
 * Classifies an error into a specific error type
 * 
 * @param error - Error object to classify
 * @returns ErrorType classification
 */
export function classifyError(error: any): ErrorType {
  if (error.status === 429) {
    return ErrorType.RATE_LIMIT;
  }
  
  if (error.status >= 500) {
    return ErrorType.SERVER_ERROR;
  }
  
  if (error.code === 'ETIMEDOUT' || error.name === 'AbortError') {
    return ErrorType.TIMEOUT;
  }
  
  if (error.code === 'ECONNRESET') {
    return ErrorType.NETWORK_ERROR;
  }
  
  if (error.status >= 400 && error.status < 500) {
    return ErrorType.CLIENT_ERROR;
  }
  
  return ErrorType.UNKNOWN;
}

/**
 * Checks if an error is a network-related error
 * 
 * @param error - Error object to check
 * @returns True if error is network-related
 */
export function isNetworkError(error: any): boolean {
  const errorType = classifyError(error);
  return errorType === ErrorType.NETWORK_ERROR || errorType === ErrorType.TIMEOUT;
}

/**
 * Checks if an error is a rate limit error
 * 
 * @param error - Error object to check
 * @returns True if error is a rate limit error
 */
export function isRateLimitError(error: any): boolean {
  return classifyError(error) === ErrorType.RATE_LIMIT;
}

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
type ErrorLike = {
  status?: number;
  code?: string;
  name?: string;
};

const isErrorLike = (error: unknown): error is ErrorLike => {
  //audit Assumption: error-like objects are non-null objects; Failure risk: primitives
  return typeof error === 'object' && error !== null;
};

const getErrorStatus = (error: unknown): number | undefined => {
  if (!isErrorLike(error)) {
    return undefined;
  }
  return typeof error.status === 'number' ? error.status : undefined;
};

const getErrorCode = (error: unknown): string | undefined => {
  if (!isErrorLike(error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
};

const getErrorName = (error: unknown): string | undefined => {
  if (!isErrorLike(error)) {
    return undefined;
  }
  return typeof error.name === 'string' ? error.name : undefined;
};

export function isRetryableError(error: unknown): boolean {
  const errorName = getErrorName(error);
  const errorCode = getErrorCode(error);
  const errorStatus = getErrorStatus(error);

  // Network errors and timeouts are retryable
  //audit Assumption: retrying network/timeouts is safe; Risk: repeated failures
  if (errorName === 'AbortError' || errorCode === 'ECONNRESET' || errorCode === 'ETIMEDOUT') {
    return true;
  }
  
  // OpenAI API rate limits (429) and server errors (5xx) are retryable
  //audit Assumption: 429/5xx are transient; Invariant: status is numeric when present
  if (typeof errorStatus === 'number') {
    return errorStatus === 429 || errorStatus >= 500;
  }
  
  // Default to non-retryable for unknown errors
  //audit Assumption: unknown errors should not retry; Risk: missed transient cases
  return false;
}

/**
 * Classifies an error into a specific error type
 * 
 * @param error - Error object to classify
 * @returns ErrorType classification
 */
export function classifyError(error: unknown): ErrorType {
  const errorStatus = getErrorStatus(error);
  const errorCode = getErrorCode(error);
  const errorName = getErrorName(error);

  //audit Assumption: 429 indicates rate limiting; Handling: tag as retryable type
  if (errorStatus === 429) {
    return ErrorType.RATE_LIMIT;
  }
  
  //audit Assumption: 5xx indicates server issues; Handling: classify as server error
  if (typeof errorStatus === 'number' && errorStatus >= 500) {
    return ErrorType.SERVER_ERROR;
  }
  
  //audit Assumption: timeout codes map to TIMEOUT; Handling: classify for retry
  if (errorCode === 'ETIMEDOUT' || errorName === 'AbortError') {
    return ErrorType.TIMEOUT;
  }
  
  //audit Assumption: ECONNRESET implies network disruption; Handling: classify network
  if (errorCode === 'ECONNRESET') {
    return ErrorType.NETWORK_ERROR;
  }
  
  //audit Assumption: other 4xx are client errors; Handling: avoid retry
  if (typeof errorStatus === 'number' && errorStatus >= 400 && errorStatus < 500) {
    return ErrorType.CLIENT_ERROR;
  }
  
  //audit Assumption: unrecognized errors remain unknown; Risk: misclassification
  return ErrorType.UNKNOWN;
}

/**
 * Checks if an error is a network-related error
 * 
 * @param error - Error object to check
 * @returns True if error is network-related
 */
export function isNetworkError(error: unknown): boolean {
  const errorType = classifyError(error);
  //audit Assumption: TIMEOUT is treated as network; Handling: combine types
  return errorType === ErrorType.NETWORK_ERROR || errorType === ErrorType.TIMEOUT;
}

/**
 * Checks if an error is a rate limit error
 * 
 * @param error - Error object to check
 * @returns True if error is a rate limit error
 */
export function isRateLimitError(error: unknown): boolean {
  //audit Assumption: RATE_LIMIT classification is authoritative; Handling: proxy check
  return classifyError(error) === ErrorType.RATE_LIMIT;
}

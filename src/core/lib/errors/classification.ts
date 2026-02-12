/**
 * Error Classification Utilities
 * Consolidated error type detection and classification logic
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

export function isNetworkError(error: any): boolean {
  if (!error) return false;
  const message = error.message?.toLowerCase() || '';
  return message.includes('network') || message.includes('econnreset') || message.includes('etimedout');
}

export function isRateLimitError(error: any): boolean {
  if (!error) return false;
  return error.status === 429 || error.httpCode === 429 || error.code === 'rate_limit_exceeded';
}

export function isRetryableError(error: any): boolean {
  return isRateLimitError(error) || isNetworkError(error);
}

export function classifyError(error: any): ErrorType {
  if (isRateLimitError(error)) return ErrorType.RATE_LIMIT;
  if (isNetworkError(error)) return ErrorType.NETWORK_ERROR;
  if (error.status >= 500) return ErrorType.SERVER_ERROR;
  return ErrorType.UNKNOWN;
}

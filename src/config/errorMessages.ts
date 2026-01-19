/**
 * Centralized user-facing error messages for OpenAI prompt handling
 * Keeping these strings in configuration ensures they are easy to adjust
 * without touching business logic.
 */

export const ARCANOS_ERROR_MESSAGES = {
  networkResolution: 'Network connectivity issue: Unable to resolve OpenAI API hostname. Check internet connection and DNS settings.',
  connectionRefused: 'Network connectivity issue: Connection refused by OpenAI API. Check firewall settings and network access.',
  timeout: 'Request timeout: OpenAI API did not respond within the timeout period. Network may be slow or unstable.',
  unauthorized: 'API authentication failed: Invalid or missing OpenAI API key. Check your API key configuration.',
  forbidden: 'API access forbidden: Your API key does not have permission to access the requested resource.',
  rateLimit: 'API rate limit exceeded: Too many requests to OpenAI API. Please wait before retrying.',
  serviceUnavailable: 'OpenAI API service unavailable: The API is temporarily down or overloaded. Please try again later.',
  modelNotFound: 'Model not found: The fine-tuned model is not available. Check model configuration and availability.'
} as const;

export const ERROR_MESSAGE_PATTERNS = [
  { patterns: ['enotfound', 'getaddrinfo enotfound'], message: ARCANOS_ERROR_MESSAGES.networkResolution },
  { patterns: ['econnrefused', 'connect econnrefused', 'connection refused'], message: ARCANOS_ERROR_MESSAGES.connectionRefused },
  { patterns: ['etimedout', 'timeout', 'esockettimedout'], message: ARCANOS_ERROR_MESSAGES.timeout },
  { patterns: ['401', 'unauthorized', 'api key'], message: ARCANOS_ERROR_MESSAGES.unauthorized },
  { patterns: ['403', 'forbidden'], message: ARCANOS_ERROR_MESSAGES.forbidden },
  { patterns: ['429', 'rate limit'], message: ARCANOS_ERROR_MESSAGES.rateLimit },
  { patterns: ['502', '503', '504', 'service unavailable'], message: ARCANOS_ERROR_MESSAGES.serviceUnavailable },
  { patterns: ['model does not exist', 'model not found'], message: ARCANOS_ERROR_MESSAGES.modelNotFound },
] as const;

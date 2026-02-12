/**
 * Consolidated Error Handling Library
 *
 * Purpose: provide a single public entrypoint for app errors, messages,
 * response helpers, OpenAI classification, and retry helpers.
 * Inputs/Outputs: re-exports symbols from the canonical error modules.
 * Edge cases: preserves legacy base error exports for existing middleware.
 */

// Legacy base error classes still consumed by middleware and storage utilities.
export {
  AppError,
  HttpCode,
  ApiError,
  DatabaseError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  FileStorageError
} from '../../core/lib/errors/base.js';

// Error classification and detection
export {
  ErrorType,
  isRetryableError as isRetryableErrorBase,
  classifyError,
  isNetworkError,
  isRateLimitError
} from './classification.js';

// Error message resolution and mapping
export {
  resolveErrorMessage,
  mapErrorToFriendlyMessage
} from './messages.js';

// HTTP error responses for Express
export {
  type ValidationErrorOptions,
  type ValidationErrorPayload,
  type StandardErrorPayload,
  type NotFoundErrorPayload,
  type UnauthorizedErrorPayload,
  buildValidationErrorResponse,
  sendValidationError,
  sendServerError,
  sendNotFoundError,
  sendUnauthorizedError
} from './responses.js';

// OpenAI-specific error handling
export {
  handleOpenAIRequestError
} from './openai.js';

// Reusable error handling utilities
export {
  classifyOpenAIError,
  isRetryableError,
  getRetryDelay,
  formatErrorMessage,
  shouldRetry,
  getUserFriendlyMessage,
  getTechnicalMessage,
  type ErrorClassification,
  type RetryDelayResult
} from './reusable.js';

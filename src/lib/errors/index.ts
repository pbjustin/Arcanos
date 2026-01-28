/**
 * Consolidated Error Handling Library
 * 
 * This module provides a unified interface for all error handling utilities
 * across the Arcanos codebase, consolidating previously scattered modules:
 * - errorClassification.ts → classification.ts
 * - errorHandling.ts → messages.ts
 * - errorMessageMapper.ts → messages.ts
 * - errorResponse.ts → responses.ts
 * - openaiErrorHandler.ts → openai.ts
 * 
 * Usage:
 *   import { classifyError, resolveErrorMessage, sendValidationError } from '../lib/errors/index.js';
 */

// Error classification and detection
export {
  ErrorType,
  isRetryableError,
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

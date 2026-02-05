/**
 * Re-export standardized error response helpers from the consolidated library.
 *
 * Purpose: Provide a stable import path for legacy call sites while deduplicating logic.
 * Inputs/Outputs: Re-exports error response helpers and types.
 * Edge cases: Keeping this shim avoids breaking consumers that still import from utils.
 */

export {
  buildValidationErrorResponse,
  sendValidationError,
  sendServerError,
  sendNotFoundError,
  sendUnauthorizedError,
  type ValidationErrorOptions,
  type ValidationErrorPayload,
  type StandardErrorPayload,
  type NotFoundErrorPayload,
  type UnauthorizedErrorPayload
} from '../lib/errors/responses.js';

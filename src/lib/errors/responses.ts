/**
 * HTTP Error Response Utilities
 * Standardized error response formatting for Express endpoints
 */

import type { Response } from 'express';
import { buildTimestampedPayload } from '../../utils/responseHelpers.js';

export interface ValidationErrorOptions {
  acceptedFields?: readonly string[];
  maxLength?: number;
}

export interface ValidationErrorPayload {
  error: string;
  details: string[];
  timestamp: string;
  acceptedFields?: readonly string[];
  maxLength?: number;
}

/**
 * Build a standardized validation error payload.
 *
 * @param details - Validation error messages.
 * @param options - Optional payload extensions for accepted fields and max length.
 * @returns Validation error payload with timestamp.
 * @edgeCases Includes optional fields only when provided to avoid noisy responses.
 */
export function buildValidationErrorResponse(
  details: string[],
  options: ValidationErrorOptions = {}
): ValidationErrorPayload {
  //audit Assumption: timestamp helper yields ISO string; risk: inconsistent timestamps; invariant: payload includes ISO timestamp; handling: buildTimestampedPayload.
  const response: ValidationErrorPayload = buildTimestampedPayload({
    error: 'Validation failed',
    details
  });

  //audit Assumption: acceptedFields is optional; risk: leaking extra metadata; invariant: only include when provided; handling: conditional assignment.
  if (options.acceptedFields) {
    response.acceptedFields = options.acceptedFields;
  }

  //audit Assumption: maxLength is optional; risk: mismatched schema limits; invariant: only include when provided; handling: conditional assignment.
  if (typeof options.maxLength === 'number') {
    response.maxLength = options.maxLength;
  }

  return response;
}

/**
 * Send a standardized validation error response
 * 
 * @param res - Express response object
 * @param details - Array of validation error messages
 * @param options - Optional validation options
 */
export function sendValidationError(
  res: Response,
  details: string[],
  options?: ValidationErrorOptions
): void {
  const response = buildValidationErrorResponse(details, options);
  res.status(400).json(response);
}

/**
 * Standard error response payload structure
 * @confidence 1.0 - Standardized error format
 */
export interface StandardErrorPayload {
  error: string;
  details?: string[];
  timestamp: string;
}

/**
 * Not found error response payload
 * @confidence 1.0 - Standardized error format
 */
export interface NotFoundErrorPayload {
  error: string;
  timestamp: string;
}

/**
 * Unauthorized error response payload
 * @confidence 1.0 - Standardized error format
 */
export interface UnauthorizedErrorPayload {
  error: string;
  timestamp: string;
}

/**
 * Send a standardized server error response
 * 
 * @param res - Express response object
 * @param message - Error message
 * @param error - Optional error object for details
 * @confidence 1.0 - Type-safe error response
 */
export function sendServerError(
  res: Response,
  message: string,
  error?: Error
): void {
  //audit Assumption: error details are safe for clients; risk: leaking sensitive info; invariant: details omitted when error is absent; handling: conditional mapping.
  const details = error ? [error.message] : undefined;

  //audit Assumption: timestamp helper yields ISO string; risk: inconsistent timestamps; invariant: payload includes ISO timestamp; handling: buildTimestampedPayload.
  const response: StandardErrorPayload = buildTimestampedPayload({
    error: message,
    details
  });

  res.status(500).json(response);
}

/**
 * Send a standardized not found error response
 * 
 * @param res - Express response object
 * @param resource - Name of the resource that was not found
 * @confidence 1.0 - Type-safe error response
 */
export function sendNotFoundError(
  res: Response,
  resource: string
): void {
  //audit Assumption: resource is safe to echo; risk: leaking internal identifiers; invariant: response includes ISO timestamp; handling: buildTimestampedPayload.
  const response: NotFoundErrorPayload = buildTimestampedPayload({
    error: `${resource} not found`
  });

  res.status(404).json(response);
}

/**
 * Send a standardized unauthorized error response
 * 
 * @param res - Express response object
 * @param message - Optional custom message
 * @confidence 1.0 - Type-safe error response
 */
export function sendUnauthorizedError(
  res: Response,
  message: string = 'Unauthorized'
): void {
  //audit Assumption: message is safe to echo; risk: leaking auth context; invariant: response includes ISO timestamp; handling: buildTimestampedPayload.
  const response: UnauthorizedErrorPayload = buildTimestampedPayload({
    error: message
  });

  res.status(401).json(response);
}

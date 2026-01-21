/**
 * Shared Error Response Utilities
 * Standardized error response formatting across endpoints
 */

import type { Response } from 'express';

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
  const response: ValidationErrorPayload = {
    error: 'Validation failed',
    details,
    timestamp: new Date().toISOString()
  };

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
 * @param acceptedFields - Optional array of accepted field names
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
 * Send a standardized server error response
 * 
 * @param res - Express response object
 * @param message - Error message
 * @param error - Optional error object for details
 */
export function sendServerError(
  res: Response,
  message: string,
  error?: Error
): void {
  const response: any = {
    error: message,
    details: error ? [error.message] : undefined,
    timestamp: new Date().toISOString()
  };

  res.status(500).json(response);
}

/**
 * Send a standardized not found error response
 * 
 * @param res - Express response object
 * @param resource - Name of the resource that was not found
 */
export function sendNotFoundError(
  res: Response,
  resource: string
): void {
  const response: any = {
    error: `${resource} not found`,
    timestamp: new Date().toISOString()
  };

  res.status(404).json(response);
}

/**
 * Send a standardized unauthorized error response
 * 
 * @param res - Express response object
 * @param message - Optional custom message
 */
export function sendUnauthorizedError(
  res: Response,
  message: string = 'Unauthorized'
): void {
  const response: any = {
    error: message,
    timestamp: new Date().toISOString()
  };

  res.status(401).json(response);
}

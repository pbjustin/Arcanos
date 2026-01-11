/**
 * Shared Error Response Utilities
 * Standardized error response formatting across endpoints
 */

import type { Response } from 'express';
import type { ErrorResponseDTO } from '../types/dto.js';

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
  acceptedFields?: string[]
): void {
  const response: ErrorResponseDTO & { acceptedFields?: string[] } = {
    error: 'Validation failed',
    details,
    timestamp: new Date().toISOString()
  };

  if (acceptedFields) {
    response.acceptedFields = acceptedFields;
  }

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
  const response: ErrorResponseDTO = {
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
  const response: ErrorResponseDTO = {
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
  const response: ErrorResponseDTO = {
    error: message,
    timestamp: new Date().toISOString()
  };

  res.status(401).json(response);
}

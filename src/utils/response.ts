/**
 * Common Response Utilities for ARCANOS Backend
 * Consolidates repeated response patterns across routes
 */

import { Response } from "express";

/**
 * Standard error response structure
 */
export interface ErrorResponse {
  success: false;
  error: string;
  details?: string;
  timestamp?: string;
}

/**
 * Standard success response structure
 */
export interface SuccessResponse<T = any> {
  success: true;
  message?: string;
  data?: T;
  timestamp?: string;
}

/**
 * Sends a standardized error response
 * @param res - Express response object
 * @param status - HTTP status code
 * @param error - Error message
 * @param details - Optional error details
 */
export function sendErrorResponse(
  res: Response,
  status: number,
  error: string,
  details?: string,
): void {
  const response: ErrorResponse = {
    success: false,
    error,
    timestamp: new Date().toISOString(),
  };

  if (details) {
    response.details = details;
  }

  res.status(status).json(response);
}

/**
 * Sends a standardized success response
 * @param res - Express response object
 * @param message - Success message
 * @param data - Optional response data
 * @param status - HTTP status code (default: 200)
 */
export function sendSuccessResponse<T = any>(
  res: Response,
  message: string,
  data?: T,
  status: number = 200,
): void {
  const response: SuccessResponse<T> = {
    success: true,
    message,
    timestamp: new Date().toISOString(),
  };

  if (data !== undefined) {
    response.data = data;
  }

  res.status(status).json(response);
}

/**
 * Handles common catch block error responses
 * @param res - Express response object
 * @param error - Caught error
 * @param context - Context/operation name for logging
 */
export function handleCatchError(
  res: Response,
  error: any,
  context: string,
): void {
  console.error(`❌ ${context} error:`, error);
  sendErrorResponse(res, 500, `${context} error`, error.message);
}

/**
 * Common response for service result patterns used across routes
 * @param res - Express response object
 * @param result - Service result with success/error pattern
 * @param successMessage - Message for successful operations
 */
export function handleServiceResult(
  res: Response,
  result: {
    success: boolean;
    error?: string;
    response?: any;
    [key: string]: any;
  },
  successMessage: string,
): void {
  if (result.success) {
    sendSuccessResponse(res, successMessage, result.response || result);
  } else {
    sendErrorResponse(res, 500, result.error || "Service operation failed");
  }
}

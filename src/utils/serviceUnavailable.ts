import { Response } from 'express';
import { buildTimestampedPayload } from './responseHelpers.js';

export const OPENAI_SERVICE_UNAVAILABLE_DETAILS = 'OpenAI service is not configured';
export const OPENAI_PROCESSING_FAILED_ERROR = 'Internal Server Error';

export function sendOpenAIServiceUnavailable<T>(
  res: Response<T>,
  details: string = OPENAI_SERVICE_UNAVAILABLE_DETAILS,
  error: string = 'Service Unavailable'
): void {
  res.status(503).json(buildTimestampedPayload({
    error,
    details
  }) as T);
}

export function sendOpenAIProcessingFailed<T>(
  res: Response<T>,
  details: string,
  error: string = OPENAI_PROCESSING_FAILED_ERROR
): void {
  res.status(500).json(buildTimestampedPayload({
    error,
    details
  }) as T);
}

export function sendTimestampedStatus<T, P extends object>(
  res: Response<T>,
  statusCode: number,
  payload: P
): void {
  res.status(statusCode).json(buildTimestampedPayload(payload as Record<string, unknown>) as T);
}

export function sendTimestampedServiceUnavailable<T>(
  res: Response<T>,
  payload: Record<string, unknown>
): void {
  sendTimestampedStatus(res, 503, payload);
}

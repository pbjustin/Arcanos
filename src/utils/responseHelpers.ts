import { Response } from 'express';

export function sendJsonError(
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  context: Record<string, unknown> = {}
): void {
  const payload = {
    error,
    message,
    timestamp: new Date().toISOString(),
    ...context
  };

  res.status(statusCode).json(payload);
}

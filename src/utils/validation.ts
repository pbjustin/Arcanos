import { Response } from 'express';

/**
 * Ensures that a field value is present. Sends a 400 response if missing.
 *
 * @param res Express response instance
 * @param value The value to validate
 * @param name Name of the field for error messaging
 * @returns true if the field is present, false otherwise
 */
export function requireField(res: Response, value: any, name: string): boolean {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    res.status(400).json({ error: `${name} is required` });
    return false;
  }
  return true;
}


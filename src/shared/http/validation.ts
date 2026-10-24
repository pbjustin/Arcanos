import type { NextFunction, Request, Response, RequestHandler } from 'express';
import type { z } from 'zod';
import { sendBadRequest, sendValidationError } from './errors.js';
import { formatZodIssues } from '../validation/zodIssues.js';

function formatValidationDetails(error: Pick<z.ZodError, 'issues'>, input: unknown, schema: ZodSchemaLike<unknown>): string[] {
  return formatZodIssues(error, input, schema as z.ZodType).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'root';
    return `${path}: ${issue.message}`;
  });
}

type ZodSchemaLike<T> = Pick<z.ZodType<T>, 'safeParse'>;


export interface ValidateOptions {
  /**
   * When provided, validation failures return a simple { error: CODE } shape (optionally with details),
   * preserving existing endpoint contracts that use code-style errors.
   */
  errorCode?: string;
  includeDetails?: boolean;
}

function ensureValidatedBucket(req: Request): NonNullable<Request['validated']> {
  if (!req.validated) {
    req.validated = {};
  }
  return req.validated;
}

export function validateBody<T>(schema: ZodSchemaLike<T>, options: ValidateOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const details = formatValidationDetails(parsed.error, req.body, schema);
      if (options.errorCode) {
        sendBadRequest(res, options.errorCode, options.includeDetails ? details : undefined);
        return;
      }
      sendValidationError(res, details);
      return;
    }
    const bucket = ensureValidatedBucket(req);
    bucket.body = parsed.data;
    next();
  };
}

export function validateParams<T>(schema: ZodSchemaLike<T>, options: ValidateOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      const details = formatValidationDetails(parsed.error, req.params, schema);
      if (options.errorCode) {
        sendBadRequest(res, options.errorCode, options.includeDetails ? details : undefined);
        return;
      }
      sendValidationError(res, details);
      return;
    }
    const bucket = ensureValidatedBucket(req);
    bucket.params = parsed.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchemaLike<T>, options: ValidateOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      const details = formatValidationDetails(parsed.error, req.query, schema);
      if (options.errorCode) {
        sendBadRequest(res, options.errorCode, options.includeDetails ? details : undefined);
        return;
      }
      sendValidationError(res, details);
      return;
    }
    const bucket = ensureValidatedBucket(req);
    bucket.query = parsed.data;
    next();
  };
}

import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { sendBadRequest, sendValidationError } from './errors.js';

function formatZodIssues(issues: Array<{ path: (string | number)[]; message: string }>): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
    return `${path}: ${issue.message}`;
  });
}

type ZodSchemaLike<T> = {
  safeParse: (input: unknown) =>
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } };
};


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
      const details = formatZodIssues(parsed.error.issues);
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
      const details = formatZodIssues(parsed.error.issues);
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
      const details = formatZodIssues(parsed.error.issues);
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

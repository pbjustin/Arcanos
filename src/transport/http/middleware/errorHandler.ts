import { Request, Response, NextFunction } from 'express';
import { AppError } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import {
  buildPublicGamingCanaryFailure,
  prepareGuardedPublicGamingCanaryResponse,
  publicGamingCanaryFailureStatus,
  type PublicGamingCanaryFailureCode
} from '@services/publicGamingCanary.js';
import { resolvePublicGamingPath } from '@shared/http/publicGamingPath.js';
import { resolveSafeRequestPath } from "@shared/requestPathSanitizer.js";

function isAppError(err: unknown): err is AppError {
  //audit Assumption: AppError may cross module boundaries and fail instanceof in some build contexts; failure risk: valid operational errors treated as 500; expected invariant: error-like objects with numeric httpCode and string message are treated as AppError; handling strategy: structural guard plus instanceof.
  if (err instanceof AppError) {
    return true;
  }

  if (!err || typeof err !== 'object') {
    return false;
  }

  const candidate = err as Record<string, unknown>;
  return typeof candidate.httpCode === 'number' && typeof candidate.message === 'string';
}

function isJsonSchemaParseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const candidate = err as Record<string, unknown>;
  const type = typeof candidate.type === 'string' ? candidate.type : '';
  const status = typeof candidate.status === 'number' ? candidate.status : null;
  const body = candidate.body;

  //audit Assumption: malformed JSON bodies should surface as client schema errors, not internal server failures; failure risk: operator dashboards count client mistakes as backend incidents; expected invariant: body-parser syntax failures map to HTTP 400; handling strategy: detect the parser-specific status/type/body shape before generic 500 handling.
  return type === 'entity.parse.failed' || (status === 400 && typeof body === 'string');
}

function isRequestEntityTooLarge(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const candidate = err as Record<string, unknown>;
  return candidate.type === 'entity.too.large'
    || candidate.status === 413
    || candidate.statusCode === 413;
}

const REQUEST_BODY_PARSER_ERROR_SIGNATURES = new Set([
  'charset.unsupported:415',
  'encoding.unsupported:415',
  'entity.parse.failed:400',
  'entity.too.large:413',
  'entity.verify.failed:403',
  'request.aborted:400',
  'request.size.invalid:400',
  'stream.encoding.set:500',
  'stream.not.readable:500'
]);

function isRecognizedRequestBodyParserError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const candidate = err as Record<string, unknown>;
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : candidate.statusCode;
  return typeof candidate.type === 'string'
    && typeof status === 'number'
    && REQUEST_BODY_PARSER_ERROR_SIGNATURES.has(`${candidate.type}:${status}`);
}

function isPublicGptRequestPath(requestPath: string): boolean {
  return requestPath === '/gpt' || requestPath.startsWith('/gpt/');
}

function buildPublicGptErrorPayload(params: {
  code: string;
  message: string;
  requestId: string;
  traceId: string;
}): Record<string, unknown> {
  return {
    ok: false,
    requestId: params.requestId,
    traceId: params.traceId,
    error: {
      code: params.code,
      message: params.message
    }
  };
}

function buildGuardedPublicCanaryFailure(params: {
  code: PublicGamingCanaryFailureCode;
  requestId: string;
  traceId: string;
}): { statusCode: 400 | 500 | 503; payload: Record<string, unknown> } {
  const response = buildPublicGamingCanaryFailure({
    code: params.code,
    requestId: params.requestId,
    traceId: params.traceId
  });
  const guarded = prepareGuardedPublicGamingCanaryResponse({
    response,
    statusCode: publicGamingCanaryFailureStatus(response.code),
    requestId: params.requestId,
    traceId: params.traceId
  });
  return {
    statusCode: guarded.statusCode === 200 ? 500 : guarded.statusCode,
    payload: { ...guarded.response }
  };
}

/**
 * Purpose: Centralize HTTP error responses with request-id correlation and stack logging.
 * Inputs/Outputs: Express error middleware; writes JSON error payload and status code.
 * Edge cases: Falls back to 500/internal message for unknown error types.
 */
const errorHandler = (err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = req.requestId ?? 'unknown';
  const traceId = req.traceId ?? requestId;
  const requestPath = resolveSafeRequestPath(req);
  const publicGptRequest = isPublicGptRequestPath(requestPath);
  const publicCanaryRequest = resolvePublicGamingPath(requestPath)?.operation === 'canary';
  const invalidJson = isJsonSchemaParseError(err);
  const requestEntityTooLarge = isRequestEntityTooLarge(err);
  const recognizedRequestBodyParserError = isRecognizedRequestBodyParserError(err);
  const publicCanaryParserRejection = publicCanaryRequest
    && (invalidJson || requestEntityTooLarge || recognizedRequestBodyParserError);
  const publicCanaryFailureCode: PublicGamingCanaryFailureCode | null = publicCanaryRequest
    ? publicCanaryParserRejection
      ? 'PUBLIC_CANARY_REQUEST_REJECTED'
      : isAppError(err) && err.httpCode < 500
        ? 'BAD_REQUEST'
        : 'PUBLIC_CANARY_ROUTE_FAILURE'
    : null;

  // Normalize unknown error input into an Error-like shape for safe logging.
  let name = 'UnknownError';
  let message = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (err instanceof Error) {
    name = err.name || 'Error';
    message = err.message || message;
    stack = err.stack;
  } else if (err && typeof err === 'object') {
    const candidate = err as Record<string, unknown>;
    if (typeof candidate.name === 'string') {
      name = candidate.name;
    }
    if (typeof candidate.message === 'string') {
      message = candidate.message;
    }
    if (typeof candidate.stack === 'string') {
      stack = candidate.stack;
    }
  } else if (typeof err === 'string') {
    message = err;
  } else if (err !== undefined) {
    message = String(err);
  }

  let statusCode = 500;
  let payload: Record<string, unknown> = publicGptRequest
    ? buildPublicGptErrorPayload({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected GPT route error occurred.',
        requestId,
        traceId
      })
    : {
        error: 'Internal Server Error',
        code: 500,
        requestId,
        traceId
      };

  if (publicCanaryFailureCode) {
    ({ statusCode, payload } = buildGuardedPublicCanaryFailure({
      code: publicCanaryFailureCode,
      requestId,
      traceId
    }));
  } else if (invalidJson) {
    statusCode = 400;
    payload = publicGptRequest
      ? buildPublicGptErrorPayload({
          code: 'INVALID_JSON',
          message: 'Request body must be valid JSON.',
          requestId,
          traceId
        })
      : {
          error: 'invalid request schema',
          code: 400,
          requestId,
          traceId
        };
  } else if (publicGptRequest && requestEntityTooLarge) {
    statusCode = 400;
    payload = buildPublicGptErrorPayload({
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'Request body exceeds the configured JSON size limit.',
      requestId,
      traceId
    });
  } else if (isAppError(err)) {
    const appError = err as AppError;
    statusCode = appError.httpCode;
    payload = publicGptRequest
      ? buildPublicGptErrorPayload({
          code: statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'GPT_REQUEST_REJECTED',
          message: statusCode >= 500
            ? 'An unexpected GPT route error occurred.'
            : 'The GPT request could not be accepted.',
          requestId,
          traceId
        })
      : {
          error: appError.message,
          code: appError.httpCode,
          requestId,
          traceId
        };
  }

  const safePublicCanaryErrorName = publicCanaryFailureCode === 'BAD_REQUEST'
    || publicCanaryFailureCode === 'PUBLIC_CANARY_REQUEST_REJECTED'
    ? 'PublicCanaryRequestRejected'
    : 'PublicCanaryRouteFailure';
  const logDetails = {
    traceId,
    requestId,
    method: req.method,
    path: requestPath,
    errorType: publicCanaryFailureCode ? safePublicCanaryErrorName : name,
    statusCode,
    name: publicCanaryFailureCode ? safePublicCanaryErrorName : name,
    message: publicCanaryFailureCode
      ? 'Public canary request failed safely.'
      : message,
    stack: publicCanaryFailureCode ? undefined : stack
  };

  const logLevel: 'warn' | 'error' = statusCode >= 500 ? 'error' : 'warn';
  if (req.logger) {
    req.logger[logLevel]('request.failed', logDetails);
  } else {
    logger[logLevel]('request.failed', logDetails);
  }

  res.status(statusCode).json(payload);
};

export default errorHandler;

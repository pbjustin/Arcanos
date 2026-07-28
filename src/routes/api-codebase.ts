import express, { type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from "@shared/http/index.js";
import { createRateLimitMiddleware, securityHeaders } from "@platform/runtime/security.js";
import {
  listDirectory,
  MAX_CODEBASE_LINE_NUMBER,
  MAX_CODEBASE_READ_BYTES,
  readRepositoryFile,
} from "@services/codebaseAccess.js";
import { buildTimestampedPayload } from "@transport/http/responseHelpers.js";
import {
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneHttpScopes,
  requireControlPlaneOperator,
} from '@services/controlPlane/httpAuth.js';

const router = express.Router();
const requireRepositoryReadScope = requireControlPlaneHttpScopes(
  ['repo:read'],
  'codebase.http_authorization.denied'
);

function parseOptionalPositiveInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d*$/u.test(value)
  ) {
    throw new Error('Invalid numeric codebase query parameter');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error('Codebase query parameter exceeds its limit');
  }
  return parsed;
}

function setCodebaseNoStore(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

router.use(
  securityHeaders,
  setCodebaseNoStore,
  createRateLimitMiddleware(60, 5 * 60 * 1000),
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
  requireRepositoryReadScope
);

router.get('/tree', asyncHandler(async (req: Request, res: Response) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';

  try {
    const result = await listDirectory(relativePath);
    res.json(buildTimestampedPayload({
      status: 'success',
      message: 'Directory contents retrieved',
      data: result,
    }));
  } catch {
    req.logger?.warn?.('codebase.directory_read.failed', {
      requestId: req.requestId,
    });
    res.status(400).json(buildTimestampedPayload({
      status: 'error',
      message: 'Unable to list directory',
    }));
  }
}));

router.get('/file', asyncHandler(async (req: Request, res: Response) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : undefined;
  //audit Assumption: path is required; risk: missing query parameter; invariant: request is rejected early; handling: respond with 400 error.
  if (!relativePath) {
    return res.status(400).json(buildTimestampedPayload({
      status: 'error',
      message: 'Query parameter "path" is required',
    }));
  }

  try {
    const startLine = parseOptionalPositiveInteger(
      req.query.startLine,
      MAX_CODEBASE_LINE_NUMBER,
    );
    const endLine = parseOptionalPositiveInteger(
      req.query.endLine,
      MAX_CODEBASE_LINE_NUMBER,
    );
    const maxBytes = parseOptionalPositiveInteger(
      req.query.maxBytes,
      MAX_CODEBASE_READ_BYTES,
    );
    const result = await readRepositoryFile(relativePath, { startLine, endLine, maxBytes });
    res.json(buildTimestampedPayload({
      status: 'success',
      message: 'File content retrieved',
      data: result,
    }));
  } catch {
    req.logger?.warn?.('codebase.file_read.failed', {
      requestId: req.requestId,
    });
    res.status(400).json(buildTimestampedPayload({
      status: 'error',
      message: 'Unable to read file',
    }));
  }
}));

router.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Route Not Found',
    code: 404
  });
});

export default router;

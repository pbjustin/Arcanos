import express, { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createRateLimitMiddleware } from '../utils/security.js';
import { listDirectory, readRepositoryFile } from '../services/codebaseAccess.js';
import { buildTimestampedPayload } from '../utils/responseHelpers.js';
import { resolveErrorMessage } from '../utils/errorHandling.js';

const router = express.Router();

router.use(createRateLimitMiddleware(60, 5 * 60 * 1000));

router.get('/tree', asyncHandler(async (req: Request, res: Response) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';

  try {
    const result = await listDirectory(relativePath);
    res.json(buildTimestampedPayload({
      status: 'success',
      message: 'Directory contents retrieved',
      data: result,
    }));
  } catch (error) {
    //audit Assumption: errors from listDirectory indicate a bad request; risk: masking server issues; invariant: 400 responses include message; handling: fallback to safe message.
    res.status(400).json(buildTimestampedPayload({
      status: 'error',
      message: resolveErrorMessage(error, 'Unable to list directory'),
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

  const startLineRaw = typeof req.query.startLine === 'string' ? Number(req.query.startLine) : undefined;
  const endLineRaw = typeof req.query.endLine === 'string' ? Number(req.query.endLine) : undefined;

  //audit Assumption: numeric bounds are optional; risk: NaN propagates; invariant: undefined when invalid; handling: guard with Number.isFinite.
  const startLine = Number.isFinite(startLineRaw) ? startLineRaw : undefined;
  //audit Assumption: numeric bounds are optional; risk: NaN propagates; invariant: undefined when invalid; handling: guard with Number.isFinite.
  const endLine = Number.isFinite(endLineRaw) ? endLineRaw : undefined;

  const maxBytesRaw = typeof req.query.maxBytes === 'string' ? Number(req.query.maxBytes) : undefined;
  //audit Assumption: maxBytes should be numeric when provided; risk: NaN or invalid sizes; invariant: undefined when invalid; handling: guard with Number.isFinite.
  const maxBytes = Number.isFinite(maxBytesRaw) ? maxBytesRaw : undefined;

  try {
    const result = await readRepositoryFile(relativePath, { startLine, endLine, maxBytes });
    res.json(buildTimestampedPayload({
      status: 'success',
      message: 'File content retrieved',
      data: result,
    }));
  } catch (error) {
    //audit Assumption: readRepositoryFile errors are request-related; risk: hiding server errors; invariant: 400 responses include message; handling: fallback to safe message.
    res.status(400).json(buildTimestampedPayload({
      status: 'error',
      message: resolveErrorMessage(error, 'Unable to read file'),
    }));
  }
}));

export default router;

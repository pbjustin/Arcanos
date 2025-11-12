import express, { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createRateLimitMiddleware } from '../utils/security.js';
import { listDirectory, readRepositoryFile } from '../services/codebaseAccess.js';

const router = express.Router();

router.use(createRateLimitMiddleware(60, 5 * 60 * 1000));

router.get('/tree', asyncHandler(async (req: Request, res: Response) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';

  try {
    const result = await listDirectory(relativePath);
    res.json({
      status: 'success',
      message: 'Directory contents retrieved',
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(400).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unable to list directory',
      timestamp: new Date().toISOString(),
    });
  }
}));

router.get('/file', asyncHandler(async (req: Request, res: Response) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : undefined;
  if (!relativePath) {
    return res.status(400).json({
      status: 'error',
      message: 'Query parameter "path" is required',
      timestamp: new Date().toISOString(),
    });
  }

  const startLineRaw = typeof req.query.startLine === 'string' ? Number(req.query.startLine) : undefined;
  const endLineRaw = typeof req.query.endLine === 'string' ? Number(req.query.endLine) : undefined;

  const startLine = Number.isFinite(startLineRaw) ? startLineRaw : undefined;
  const endLine = Number.isFinite(endLineRaw) ? endLineRaw : undefined;

  const maxBytesRaw = typeof req.query.maxBytes === 'string' ? Number(req.query.maxBytes) : undefined;
  const maxBytes = Number.isFinite(maxBytesRaw) ? maxBytesRaw : undefined;

  try {
    const result = await readRepositoryFile(relativePath, { startLine, endLine, maxBytes });
    res.json({
      status: 'success',
      message: 'File content retrieved',
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(400).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unable to read file',
      timestamp: new Date().toISOString(),
    });
  }
}));

export default router;

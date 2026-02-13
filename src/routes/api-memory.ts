import express, { Request, Response } from 'express';
import { promises as fs } from 'fs';
import { getSessionLogPath } from "@shared/logPath.js";
import { saveMemory, loadMemory, deleteMemory, getStatus, query } from "@core/db/index.js";
import { asyncHandler } from "@transport/http/asyncHandler.js";
import { requireField } from "@shared/validation.js";
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { createRateLimitMiddleware } from "@platform/runtime/security.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

const router = express.Router();

// Apply rate limiting for API routes
router.use(createRateLimitMiddleware(100, 15 * 60 * 1000)); // 100 requests per 15 minutes

// Database health check endpoint
router.get("/health", (_: Request, res: Response) => {
  const dbStatus = getStatus();
  res.json({
    status: 'success',
    message: 'Memory service health check',
    data: {
      database: dbStatus.connected,
      error: dbStatus.error,
      timestamp: new Date().toISOString()
    }
  });
});

// Save memory endpoint
router.post("/save", confirmGate, asyncHandler(async (req: Request, res: Response) => {
  const { key, value } = req.body;

  if (!requireField(res, key, 'key') || !requireField(res, value, 'value')) {
    return;
  }
  
  const result = await saveMemory(key, value);
  res.json({
    status: 'success',
    message: 'Memory saved successfully',
    data: {
      key,
      timestamp: result.updated_at
    }
  });
}));

// Load memory endpoint
router.get("/load", asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.query;
  if (!requireField(res, key, 'key') || typeof key !== 'string') {
    return;
  }
  const value = await loadMemory(key);

  if (value === null) {
    return res.status(404).json({
      status: 'error',
      message: 'Memory not found',
      data: { key },
      timestamp: new Date().toISOString()
    });
  }

  res.json({
    status: 'success',
    message: 'Memory loaded successfully',
    data: {
      key,
      value
    }
  });
}));

// Delete memory endpoint
router.delete("/delete", confirmGate, asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.body;
  if (!requireField(res, key, 'key')) {
    return;
  }
  
  const deleted = await deleteMemory(key);

  if (!deleted) {
    return res.status(404).json({
      status: 'error',
      message: 'Memory not found',
      data: { key },
      timestamp: new Date().toISOString()
    });
  }

  res.json({
    status: 'success',
    message: 'Memory deleted successfully',
    data: { key }
  });
}));

// List recent memory entries
router.get("/list", asyncHandler(async (req: Request, res: Response) => {
  const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const parsedLimit = Number.parseInt(limitParam === undefined ? '' : String(limitParam), 10);
  const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? 50 : parsedLimit;
  
  const result = await query(
    'SELECT key, value, created_at, updated_at FROM memory ORDER BY updated_at DESC LIMIT $1',
    [limit]
  );

  res.json({
    status: 'success',
    message: 'Memory entries retrieved successfully',
    data: {
      count: result.rows.length,
      entries: result.rows
    }
  });
}));

// 🧠 Kernel memory viewer (legacy file-based)
router.get("/view", asyncHandler(async (_: Request, res: Response) => {
  try {
    const memoryPath = getSessionLogPath();
    const log = await fs.readFile(memoryPath, "utf-8");
    
    res.json({
      status: 'success',
      message: 'Memory file retrieved',
      data: {
        content: log,
        path: memoryPath,
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    const errorMessage = resolveErrorMessage(err);
    res.status(500).json({
      status: 'error',
      message: 'Cannot read memory file',
      error: errorMessage,
      timestamp: new Date().toISOString()
    });
  }
}));

// Bulk operations endpoint
router.post("/bulk", confirmGate, asyncHandler(async (req: Request, res: Response) => {
  const { operations } = req.body;
  
  if (!Array.isArray(operations)) {
    return res.status(400).json({
      status: 'error',
      message: 'Operations must be an array',
      timestamp: new Date().toISOString()
    });
  }

  const results = [];
  
  for (const op of operations) {
    try {
      switch (op.type) {
        case 'save':
          await saveMemory(op.key, op.value);
          results.push({ key: op.key, status: 'saved' });
          break;
        case 'delete':
          await deleteMemory(op.key);
          results.push({ key: op.key, status: 'deleted' });
          break;
        default:
          results.push({ key: op.key, status: 'unknown_operation' });
      }
    } catch (error) {
      results.push({ 
        key: op.key, 
        status: 'error', 
        error: resolveErrorMessage(error) 
      });
    }
  }

  res.json({
    status: 'success',
    message: 'Bulk operations completed',
    data: {
      processed: results.length,
      results
    }
  });
}));

export default router;

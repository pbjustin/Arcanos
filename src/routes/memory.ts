import express, { Request, Response } from 'express';
import { promises as fs } from 'fs';
import { getSessionLogPath } from '../utils/logPath.js';
import { saveMemory, loadMemory, deleteMemory, getStatus, query } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireField } from '../utils/validation.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { sessionMemoryController } from '../controllers/sessionMemoryController.js';

const router = express.Router();

// Database health check endpoint
router.get("/memory/health", (_: Request, res: Response) => {
  const dbStatus = getStatus();
  res.json({
    database: dbStatus.connected,
    error: dbStatus.error,
    timestamp: new Date().toISOString()
  });
});

// Save memory endpoint
router.post("/memory/save", confirmGate, asyncHandler(async (req: Request, res: Response) => {
  const { key, value, includeMeta } = req.body;

  if (!requireField(res, key, 'key') || !requireField(res, value, 'value')) {
    return;
  }

  const result = await saveMemory(key, value);

  const response: any = {
    success: true,
    message: 'Memory saved successfully'
  };

  if (includeMeta === true) {
    response.key = key;
    response.timestamp = result.updated_at;
  }

  res.json(response);
}));

// Load memory endpoint
router.get("/memory/load", asyncHandler(async (req: Request, res: Response) => {
  const { key, includeMeta } = req.query;
  if (!requireField(res, key, 'key') || typeof key !== 'string') {
    return;
  }
  const value = await loadMemory(key);

  if (value === null) {
    return res.status(404).json({
      error: 'Memory not found',
      key
    });
  }

  const response: any = {
    success: true,
    value,
    message: 'Memory loaded successfully'
  };

  // Only include metadata when explicitly requested
  if (includeMeta === 'true') {
    response.key = key;
  }

  res.json(response);
}));

// Delete memory endpoint
router.delete("/memory/delete", confirmGate, asyncHandler(async (req: Request, res: Response) => {
  const { key, includeMeta } = req.body;
  if (!requireField(res, key, 'key')) {
    return;
  }

  const deleted = await deleteMemory(key);

  if (!deleted) {
    return res.status(404).json({
      error: 'Memory not found',
      key
    });
  }

  const response: any = {
    success: true,
    message: 'Memory deleted successfully'
  };

  if (includeMeta === true) {
    response.key = key;
  }

  res.json(response);
}));

// List recent memory entries
router.get("/memory/list", asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const includeMeta = req.query.includeMeta === 'true';

  const result = await query(
    'SELECT key, value, created_at, updated_at FROM memory ORDER BY updated_at DESC LIMIT $1',
    [limit]
  );

  const entries = includeMeta
    ? result.rows
    : result.rows.map((row: any) => row.value);

  res.json({
    success: true,
    count: entries.length,
    entries,
    message: 'Memory entries retrieved successfully'
  });
}));

// 🧠 Kernel memory viewer (legacy file-based)
router.get("/memory/view", asyncHandler(async (_: Request, res: Response) => {
  try {
    const memoryPath = getSessionLogPath();
    const log = await fs.readFile(memoryPath, "utf-8");
    res.type("text/plain").send(log);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).send("❌ Cannot read memory: " + errorMessage);
  }
}));

// Session-based conversation memory
router.post(
  "/memory/dual/save",
  asyncHandler(sessionMemoryController.saveDual)
);

router.get(
  "/memory/dual/:sessionId/core",
  asyncHandler(sessionMemoryController.getCore)
);

router.get(
  "/memory/dual/:sessionId/meta",
  asyncHandler(sessionMemoryController.getMeta)
);

// Default to core conversation when no channel specified
router.get(
  "/memory/dual/:sessionId",
  asyncHandler(sessionMemoryController.getCore)
);

export default router;
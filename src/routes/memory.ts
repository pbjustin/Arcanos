import express, { Request, Response } from 'express';
import { readFileSync } from 'fs';
import { getSessionLogPath } from '../utils/logPath.js';
import { saveMemory, loadMemory, deleteMemory, getStatus, query } from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// Database health check endpoint
router.get("/memory/health", (req: Request, res: Response) => {
  const dbStatus = getStatus();
  res.json({
    database: dbStatus.connected,
    error: dbStatus.error,
    timestamp: new Date().toISOString()
  });
});

// Save memory endpoint
router.post("/memory/save", asyncHandler(async (req: Request, res: Response) => {
  const { key, value } = req.body;
  
  if (!key) {
    return res.status(400).json({ error: 'key is required' });
  }
  
  if (value === undefined) {
    return res.status(400).json({ error: 'value is required' });
  }
  
  const result = await saveMemory(key, value);
  res.json({
    success: true,
    key,
    timestamp: result.updated_at,
    message: 'Memory saved successfully'
  });
}));

// Load memory endpoint
router.get("/memory/load", asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.query;
  
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'key parameter is required' });
  }
  
  const value = await loadMemory(key);

  if (value === null) {
    return res.status(404).json({
      error: 'Memory not found',
      key
    });
  }

  res.json({
    success: true,
    key,
    value,
    message: 'Memory loaded successfully'
  });
}));

// Delete memory endpoint
router.delete("/memory/delete", asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.body;
  
  if (!key) {
    return res.status(400).json({ error: 'key is required' });
  }
  
  const deleted = await deleteMemory(key);

  if (!deleted) {
    return res.status(404).json({
      error: 'Memory not found',
      key
    });
  }

  res.json({
    success: true,
    key,
    message: 'Memory deleted successfully'
  });
}));

// List recent memory entries
router.get("/memory/list", asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  
  const result = await query(
    'SELECT key, value, created_at, updated_at FROM memory ORDER BY updated_at DESC LIMIT $1',
    [limit]
  );

  res.json({
    success: true,
    count: result.rows.length,
    entries: result.rows,
    message: 'Memory entries retrieved successfully'
  });
}));

// 🧠 Kernel memory viewer (legacy file-based)
router.get("/memory/view", (req: Request, res: Response) => {
  try {
    const memoryPath = getSessionLogPath();
    const log = readFileSync(memoryPath, "utf-8");
    res.type("text/plain").send(log);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).send("❌ Cannot read memory: " + errorMessage);
  }
});

export default router;
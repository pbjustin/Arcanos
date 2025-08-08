import express, { Request, Response } from 'express';
import { readFileSync } from 'fs';
import { getSessionLogPath } from '../utils/logPath.js';

const router = express.Router();

// 🧠 Kernel memory viewer
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
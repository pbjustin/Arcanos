import express, { Request, Response } from 'express';
import { readFileSync } from 'fs';

const router = express.Router();

// 📁 Memory log path
const MEMORY_PATH = "/var/arc/log/session.log";

// 🧠 Kernel memory viewer
router.get("/memory/view", (req: Request, res: Response) => {
  try {
    const log = readFileSync(MEMORY_PATH, "utf-8");
    res.type("text/plain").send(log);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).send("❌ Cannot read memory: " + errorMessage);
  }
});

export default router;
import express, { Request, Response } from 'express';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { confirmGate } from '../middleware/confirmGate.js';

interface HeartbeatPayload {
  write_override: boolean;
  db_write_enable: boolean;
  suppression_level: string;
  confirmation: string;
}

interface HeartbeatRequest {
  timestamp: string;
  mode: string;
  payload: HeartbeatPayload;
}

const router = express.Router();

const logDir = path.join(process.cwd(), 'logs');
const logFile = path.join(logDir, 'heartbeat.log');

function logHeartbeat(entry: HeartbeatRequest): void {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

router.post('/heartbeat', confirmGate, (req: Request<{}, any, HeartbeatRequest>, res: Response) => {
  const { timestamp, mode, payload } = req.body;

  if (!timestamp || !mode || !payload) {
    return res.status(400).json({ error: 'Invalid heartbeat payload' });
  }

  logHeartbeat({ timestamp, mode, payload });

  const writeStatus = payload.db_write_enable ? 'enabled' : 'disabled';
  const message = `Heartbeat acknowledged. Mode: ${mode}, write operations ${writeStatus}, suppression level: ${payload.suppression_level}. Confirmation: ${payload.confirmation}.`;

  res.json({ message });
});

export default router;

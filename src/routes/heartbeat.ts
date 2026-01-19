import express, { Request, Response } from 'express';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { confirmGate } from '../middleware/confirmGate.js';
import { HEARTBEAT_LOG_FILENAME, HEARTBEAT_RESPONSE_TEMPLATE } from '../config/heartbeat.js';

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
const logFile = path.join(logDir, HEARTBEAT_LOG_FILENAME);

function formatHeartbeatMessage(mode: string, payload: HeartbeatPayload): string {
  const writeStatus = payload.db_write_enable ? 'enabled' : 'disabled';

  return HEARTBEAT_RESPONSE_TEMPLATE
    .replace('{mode}', mode)
    .replace('{writeStatus}', writeStatus)
    .replace('{suppressionLevel}', payload.suppression_level)
    .replace('{confirmation}', payload.confirmation);
}

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

  const message = formatHeartbeatMessage(mode, payload);

  res.json({ message });
});

export default router;

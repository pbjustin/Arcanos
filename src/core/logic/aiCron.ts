import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import { logger } from "@platform/logging/structuredLogging.js";
import { writeJsonFile } from "@shared/fileStorage.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

/**
 * Sets up recurring AI maintenance tasks.
 * Currently runs a heartbeat log every minute.
 */
const HB_FILE = path.join(process.cwd(), 'memory', 'heartbeat.json');

async function writeHeartbeat(): Promise<void> {
  const hb = { ts: Date.now(), pid: process.pid };
  try {
    await writeJsonFile(HB_FILE, hb, { space: 0 });
  } catch (err) {
    logger.error('Failed to write heartbeat file', {
      module: 'aiCron',
      operation: 'heartbeat-write',
      error: resolveErrorMessage(err),
      file: HB_FILE
    });
  }
  logger.info('Heartbeat written', {
    module: 'aiCron', 
    operation: 'heartbeat',
    timestamp: new Date(hb.ts).toISOString(),
    pid: process.pid
  });
}

async function recoverHeartbeat(): Promise<void> {
  try {
    const content = await fs.readFile(HB_FILE, 'utf8');
    const last = JSON.parse(content);
    logger.info('Previous heartbeat recovered', {
      module: 'aiCron',
      operation: 'heartbeat-recovery', 
      lastHeartbeat: new Date(last.ts).toISOString(),
      lastPid: last.pid
    });
  } catch {
    logger.info('No previous heartbeat found, starting fresh', {
      module: 'aiCron',
      operation: 'heartbeat-recovery'
    });
  }
}

function initAICron(): void {
  console.log('[🤖 AI Cron] initialized. Heartbeat scheduled every minute');
  recoverHeartbeat();
  cron.schedule('* * * * *', writeHeartbeat);
}

// Initialize cron tasks on import
initAICron();

export {};

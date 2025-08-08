import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';

/**
 * Sets up recurring AI maintenance tasks.
 * Currently runs a heartbeat log every minute.
 */
const HB_FILE = path.join(process.cwd(), 'memory', 'heartbeat.json');

async function writeHeartbeat(): Promise<void> {
  const hb = { ts: Date.now(), pid: process.pid };
  try {
    await fs.mkdir(path.dirname(HB_FILE), { recursive: true });
    await fs.writeFile(HB_FILE, JSON.stringify(hb));
  } catch (err) {
    console.error('[🤖 AI Cron] failed to write heartbeat', err);
  }
  console.log('[🤖 AI Cron] heartbeat', new Date(hb.ts).toISOString());
}

async function recoverHeartbeat(): Promise<void> {
  try {
    const content = await fs.readFile(HB_FILE, 'utf8');
    const last = JSON.parse(content);
    console.log('[🤖 AI Cron] recovered heartbeat', new Date(last.ts).toISOString());
  } catch {
    console.log('[🤖 AI Cron] no previous heartbeat found');
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

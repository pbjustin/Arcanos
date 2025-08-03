import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../logs');
const MAX_LOG_SIZE_MB = 5;

const LOG_LEVELS = { debug: 0, info: 1, error: 2 } as const;
export type LogLevel = keyof typeof LOG_LEVELS;

const envLevel = process.env.LOG_LEVEL as LogLevel;
const CURRENT_LEVEL: LogLevel = envLevel && envLevel in LOG_LEVELS ? envLevel : 'info';

async function ensureLogDir(): Promise<void> {
  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create log directory', err);
  }
}

function getLogFile(): string {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `arcanos-${date}.log`);
}

async function rotateLogIfNeeded(file: string): Promise<void> {
  try {
    const stats = await fsp.stat(file);
    if (stats.size >= MAX_LOG_SIZE_MB * 1024 * 1024) {
      const archiveName = `${file.replace('.log', '')}-${Date.now()}.log.gz`;
      const source = fs.createReadStream(file);
      const gzip = zlib.createGzip();
      const dest = fs.createWriteStream(archiveName);
      await pipeline(source, gzip, dest);
      await fsp.writeFile(file, '');
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.error('Failed to rotate log', err);
    }
  }
}

export async function writeLog(level: LogLevel, message: string, context: any = {}): Promise<void> {
  if (LOG_LEVELS[level] < LOG_LEVELS[CURRENT_LEVEL]) return;

  const file = getLogFile();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context,
  };

  try {
    await ensureLogDir();
    await rotateLogIfNeeded(file);
    await fsp.appendFile(file, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('Failed to write log', err);
  }
}

export const logInfo = (msg: string, ctx?: any) => writeLog('info', msg, ctx);
export const logError = (msg: string, ctx?: any) => writeLog('error', msg, ctx);
export const logDebug = (msg: string, ctx?: any) => writeLog('debug', msg, ctx);


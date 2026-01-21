import fs from 'fs';
import path from 'path';
import { DecisionRecord, AfolLogEntry } from './types.js';

const defaultLogPath = path.resolve(process.cwd(), 'logs', 'afol-decisions.log');

let logFilePath = defaultLogPath;

function ensureLogDestination(): void {
  const directory = path.dirname(logFilePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, '', { encoding: 'utf8' });
  }
}

export function configureLogger(options: { filePath?: string } = {}): void {
  if (options.filePath) {
    logFilePath = options.filePath;
  } else {
    logFilePath = defaultLogPath;
  }
}

export function getLogFilePath(): string {
  return logFilePath;
}

export function logDecision(input: unknown, decision: DecisionRecord): void {
  ensureLogDestination();
  const entry: AfolLogEntry = {
    timestamp: new Date().toISOString(),
    input,
    decision
  };
  fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
}

export function logError(context: string, error: unknown): void {
  ensureLogDestination();
  const entry: AfolLogEntry = {
    timestamp: new Date().toISOString(),
    context,
    error: error instanceof Error ? error.message : String(error)
  };
  fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
}

export function getRecent(limit = 10): AfolLogEntry[] {
  try {
    if (!fs.existsSync(logFilePath)) {
      return [];
    }
    const raw = fs.readFileSync(logFilePath, { encoding: 'utf8' });
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const slice = lines.slice(-Math.max(limit, 0));
    return slice.map((line) => JSON.parse(line) as AfolLogEntry);
  } catch {
    return [];
  }
}

export function clearLogs(): void {
  if (fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, '', { encoding: 'utf8' });
  }
}

export function resetLogger(): void {
  logFilePath = defaultLogPath;
}

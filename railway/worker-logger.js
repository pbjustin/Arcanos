import fs from 'fs';
import path from 'path';
import { run as memorySync } from '../workers/memorySync.js';
import { run as codeImprovement } from '../workers/codeImprovement.js';
import { run as auditProcessor } from '../workers/auditProcessor.js';
import { run as errorLogger } from '../workers/worker-error-logger.js';
import { run as plannerEngine } from '../workers/worker-planner-engine.js';

const logPath = path.resolve('logs', 'worker-heartbeat.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });

async function runWorker(id, fn) {
  try {
    await fn();
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ✅ ${id}\n`);
  } catch (err) {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ❌ ${id}: ${err.message}\n`);
    setTimeout(() => runWorker(id, fn), 5000);
  }
}

const schedules = [
  { id: 'memorySync', fn: () => memorySync({}), interval: 5 * 60 * 1000 },
  { id: 'codeImprovement', fn: () => codeImprovement({}), interval: 15 * 60 * 1000 },
  { id: 'auditProcessor', fn: () => auditProcessor({}), interval: 20 * 60 * 1000 },
  { id: 'worker-error-logger', fn: () => errorLogger({ schema: { bad_key: true } }), interval: 60 * 1000 },
  { id: 'worker-planner-engine', fn: () => plannerEngine({}), interval: 10 * 60 * 1000 }
];

schedules.forEach(({ id, fn, interval }) => {
  runWorker(id, fn);
  setInterval(() => runWorker(id, fn), interval);
});

import fs from 'fs';
import path from 'path';
import { getEnvironmentSecuritySummary } from './environmentSecurity.js';

interface WorkerHealth {
  expected: boolean;
  directoryExists: boolean;
  healthy: boolean;
  files: string[];
  reason?: string;
}

export interface HealthCheckReport {
  status: 'ok' | 'degraded';
  summary: string;
  raw: NodeJS.MemoryUsage;
  security: ReturnType<typeof getEnvironmentSecuritySummary>;
  components: {
    workers: WorkerHealth;
    memory: {
      heapMB: string;
      rssMB: string;
      externalMB: string;
    };
  };
}

function evaluateWorkerHealth(): WorkerHealth {
  const workersDir = path.resolve(process.cwd(), 'workers');
  const runWorkersEnv = process.env.RUN_WORKERS;
  const workersEnabled = runWorkersEnv === 'true' || runWorkersEnv === '1';
  const directoryExists = fs.existsSync(workersDir);

  if (!workersEnabled) {
    return {
      expected: false,
      directoryExists,
      healthy: true,
      files: [],
      reason: 'Workers disabled via RUN_WORKERS'
    };
  }

  if (!directoryExists) {
    return {
      expected: true,
      directoryExists: false,
      healthy: false,
      files: [],
      reason: 'Workers directory not found'
    };
  }

  let workerFiles: string[] = [];
  try {
    workerFiles = fs
      .readdirSync(workersDir)
      .filter(file => file.endsWith('.js') && !file.includes('shared'));
  } catch (error) {
    return {
      expected: true,
      directoryExists: true,
      healthy: false,
      files: [],
      reason: error instanceof Error ? error.message : 'Failed to read workers directory'
    };
  }

  if (workerFiles.length === 0) {
    return {
      expected: true,
      directoryExists: true,
      healthy: false,
      files: workerFiles,
      reason: 'No worker modules found'
    };
  }

  return {
    expected: true,
    directoryExists: true,
    healthy: true,
    files: workerFiles
  };
}

export function runHealthCheck(): HealthCheckReport {
  console.log('[🩺 HealthCheck] Running diagnostics');
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  const rssMB = (mem.rss / 1024 / 1024).toFixed(2);
  const externalMB = (mem.external / 1024 / 1024).toFixed(2);
  const uptime = process.uptime().toFixed(1);
  const security = getEnvironmentSecuritySummary();
  const workers = evaluateWorkerHealth();

  console.log(`[🩺 HealthCheck] Heap: ${heapMB}MB | RSS: ${rssMB}MB | Uptime: ${uptime}s`);

  if (security) {
    console.log(`[🛡️ Security] Trusted=${security.trusted} SafeMode=${security.safeMode}`);
  }

  if (!workers.healthy) {
    console.warn('[🧵 Workers] Worker subsystem reported an unhealthy status', workers.reason);
  }

  const status: HealthCheckReport['status'] = workers.healthy ? 'ok' : 'degraded';
  const summaryParts = [`Heap: ${heapMB}MB`, `Uptime: ${uptime}s`];

  if (!workers.healthy && workers.reason) {
    summaryParts.push(`Workers: ${workers.reason}`);
  }

  return {
    status,
    summary: summaryParts.join(' | '),
    raw: mem,
    security,
    components: {
      workers,
      memory: {
        heapMB,
        rssMB,
        externalMB
      }
    }
  };
}

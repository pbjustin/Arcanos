import fs from 'fs';
import os from 'os';
import { getEnvironmentSecuritySummary } from './environmentSecurity.js';
import { resolveWorkersDirectory } from './workerPaths.js';

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
      arrayBuffersMB: string;
    };
  };
  metrics: {
    uptimeSeconds: number;
    loadAverage: {
      oneMinute: string;
      fiveMinute: string;
      fifteenMinute: string;
    };
  };
}

function evaluateWorkerHealth(): WorkerHealth {
  const { path: workersDir, exists: directoryExists, checked } = resolveWorkersDirectory();
  const runWorkersEnv = process.env.RUN_WORKERS;
  const workersEnabled = runWorkersEnv === 'true' || runWorkersEnv === '1';

  if (!workersEnabled) {
    return {
      expected: false,
      directoryExists,
      healthy: true,
      files: [],
      reason: 'Workers disabled via RUN_WORKERS'
    };
  }

  if (!directoryExists || !fs.existsSync(workersDir)) {
    return {
      expected: true,
      directoryExists: false,
      healthy: false,
      files: [],
      reason:
        checked.length > 0
          ? `Workers directory not found (checked: ${checked.join(' | ')})`
          : 'Workers directory not found (worker modules optional)'
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
      healthy: true,
      files: workerFiles,
      reason: 'No worker modules registered'
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
  const arrayBuffersMB = mem.arrayBuffers
    ? (mem.arrayBuffers / 1024 / 1024).toFixed(2)
    : '0.00';
  const uptimeSeconds = process.uptime();
  const uptime = uptimeSeconds.toFixed(1);
  const security = getEnvironmentSecuritySummary();
  const workers = evaluateWorkerHealth();
  const [load1, load5, load15] = os.loadavg().map(avg => avg.toFixed(2));

  console.log(
    `[🩺 HealthCheck] Memory | Heap: ${heapMB}MB | RSS: ${rssMB}MB | External: ${externalMB}MB | ArrayBuffers: ${arrayBuffersMB}MB`
  );
  console.log(`[🖥️ Runtime] PID: ${process.pid} | Node: ${process.version} | Uptime: ${uptime}s`);
  console.log(`[📊 Load] 1m=${load1} | 5m=${load5} | 15m=${load15}`);

  if (security) {
    const matchedFingerprint = security.matchedFingerprint
      ? ` matched=${security.matchedFingerprint}`
      : '';
    console.log(
      `[🛡️ Security] Trusted=${security.trusted} SafeMode=${security.safeMode} Fingerprint=${security.fingerprint}${matchedFingerprint}`
    );
    if (security.issues.length > 0) {
      console.log(`[🛡️ Security] Issues: ${security.issues.join(' | ')}`);
    }
  }

  if (!workers.healthy) {
    console.warn('[🧵 Workers] Worker subsystem reported an unhealthy status', workers.reason);
  } else {
    console.log(
      `[🧵 Workers] Healthy=${workers.healthy} Expected=${workers.expected} DirectoryExists=${workers.directoryExists} Files=${
        workers.files.length > 0 ? workers.files.join(', ') : 'none'
      }`
    );
    if (workers.reason) {
      console.log(`[🧵 Workers] Detail: ${workers.reason}`);
    }
  }

  const status: HealthCheckReport['status'] = workers.healthy ? 'ok' : 'degraded';
  const summaryParts = [
    `Heap ${heapMB}MB`,
    `RSS ${rssMB}MB`,
    `External ${externalMB}MB`,
    `Uptime ${uptime}s`
  ];

  if (!workers.healthy && workers.reason) {
    summaryParts.push(`Workers: ${workers.reason}`);
  } else if (workers.expected) {
    summaryParts.push('Workers: healthy');
  }

  if (security) {
    summaryParts.push(`Security trusted=${security.trusted ? 'yes' : 'no'} safeMode=${security.safeMode ? 'on' : 'off'}`);
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
        externalMB,
        arrayBuffersMB
      }
    },
    metrics: {
      uptimeSeconds,
      loadAverage: {
        oneMinute: load1,
        fiveMinute: load5,
        fifteenMinute: load15
      }
    }
  };
}

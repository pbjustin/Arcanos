#!/usr/bin/env node

import { close as closeDatabase, initializeDatabaseWithSchema } from '../dist/core/db/index.js';
import { listFailedJobs } from '../dist/core/db/repositories/jobRepository.js';

function parseArgs(argv) {
  const [commandRaw, ...rest] = argv;
  const command = commandRaw === 'requeue' ? 'requeue' : 'inspect';
  let jobId = null;
  let limit = 20;
  let requestedBy = 'codex-cli';
  let resetRetryCount = true;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const nextArg = rest[index + 1];

    if ((arg === '--job-id' || arg === '-j') && nextArg) {
      jobId = nextArg.trim();
      index += 1;
      continue;
    }
    if ((arg === '--limit' || arg === '-n') && nextArg) {
      const parsed = Number.parseInt(nextArg, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      index += 1;
      continue;
    }
    if (arg === '--requested-by' && nextArg) {
      requestedBy = nextArg.trim() || requestedBy;
      index += 1;
      continue;
    }
    if (arg === '--preserve-retry-count') {
      resetRetryCount = false;
    }
  }

  return {
    command,
    jobId,
    limit,
    requestedBy,
    resetRetryCount
  };
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  const connected = await initializeDatabaseWithSchema('worker-failed-job-maintenance');
  if (!connected) {
    throw new Error('Database initialization failed.');
  }

  if (parsed.command === 'inspect') {
    const jobs = await listFailedJobs(parsed.limit);
    process.stdout.write(JSON.stringify({
      ok: true,
      command: parsed.command,
      count: jobs.length,
      jobs
    }, null, 2));
    return;
  }

  if (!parsed.jobId) {
    throw new Error('`requeue` requires --job-id <id>.');
  }

  const { requeueFailedWorkerJob } = await import('../dist/services/workerControlService.js');
  const result = await requeueFailedWorkerJob(parsed.jobId, {
    requestedBy: parsed.requestedBy,
    resetRetryCount: parsed.resetRetryCount
  });

  process.stdout.write(JSON.stringify({
    ok: result.outcome === 'requeued',
    command: parsed.command,
    jobId: parsed.jobId,
    outcome: result.outcome,
    job: result.job
  }, null, 2));
}

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });

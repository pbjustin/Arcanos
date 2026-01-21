import { fileURLToPath } from 'url';
import { TypedWorkerQueue } from '../queue/index.js';
import { memorySyncHandler } from '../handlers/memorySync.js';
import type { JobName } from '../jobs/index.js';

const queue = new TypedWorkerQueue();

queue.register('MEMORY_SYNC', memorySyncHandler);

export function startMemorySyncWorker() {
  return queue;
}

async function runFromEnv() {
  const jobType = process.env.WORKER_JOB as JobName | undefined;
  const payloadRaw = process.env.WORKER_PAYLOAD;

  if (!jobType || !payloadRaw) {
    return;
  }

  const payload = JSON.parse(payloadRaw) as unknown;
  const results = await queue.dispatch(jobType, payload as never);
  console.log(JSON.stringify({ jobType, results }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('[workers] Memory sync worker ready');
  void runFromEnv();
  process.stdin.resume();
}

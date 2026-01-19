import { fileURLToPath } from 'url';
import { TypedWorkerQueue } from '../queue/index.js';
import { memoryGetHandler, memorySetHandler } from '../handlers/memory.js';
import type { JobName } from '../jobs/index.js';

const queue = new TypedWorkerQueue();

queue.register('MEMORY_SET', memorySetHandler);
queue.register('MEMORY_GET', memoryGetHandler);

export function startMemoryWorker() {
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
  console.log('[workers] Memory worker ready');
  void runFromEnv();
  process.stdin.resume();
}

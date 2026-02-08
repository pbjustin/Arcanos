import { fileURLToPath } from 'url';
import { TypedWorkerQueue } from '../queue/index.js';
import { memoryGetHandler, memorySetHandler } from '../handlers/memory.js';
import { resolveWorkerJobContract, sanitizeWorkerLogPayload } from '../infrastructure/sdk/openaiConfig.js';

const queue = new TypedWorkerQueue();

queue.register('MEMORY_SET', memorySetHandler);
queue.register('MEMORY_GET', memoryGetHandler);

export function startMemoryWorker() {
  return queue;
}

async function runFromEnv() {
  const contract = resolveWorkerJobContract();
  if (contract.error) {
    //audit Assumption: malformed runtime contract should not dispatch memory jobs; risk: corrupted writes; invariant: invalid contract exits safely; handling: log and return.
    console.error(`[workers] Memory worker contract error: ${sanitizeWorkerLogPayload(contract.error)}`);
    return;
  }

  if (!contract.jobType || contract.payload === null) {
    return;
  }

  const results = await queue.dispatch(contract.jobType, contract.payload as never);
  console.log(JSON.stringify(sanitizeWorkerLogPayload({ jobType: contract.jobType, results })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('[workers] Memory worker ready');
  void runFromEnv();
  process.stdin.resume();
}

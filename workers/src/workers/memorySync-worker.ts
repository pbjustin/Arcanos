import { fileURLToPath } from 'url';
import { TypedWorkerQueue } from '../queue/index.js';
import { memorySyncHandler } from '../handlers/memorySync.js';
import { resolveWorkerJobContract, sanitizeWorkerLogPayload } from '../infrastructure/sdk/openaiConfig.js';

const queue = new TypedWorkerQueue();

queue.register('MEMORY_SYNC', memorySyncHandler);

export function startMemorySyncWorker() {
  return queue;
}

async function runFromEnv() {
  const contract = resolveWorkerJobContract();
  if (contract.error) {
    //audit Assumption: malformed runtime contract should not dispatch sync jobs; risk: partial writes; invariant: invalid contract exits safely; handling: log and return.
    console.error(`[workers] MemorySync worker contract error: ${sanitizeWorkerLogPayload(contract.error)}`);
    return;
  }

  if (!contract.jobType || contract.payload === null) {
    return;
  }

  const results = await queue.dispatch(contract.jobType, contract.payload as never);
  console.log(JSON.stringify(sanitizeWorkerLogPayload({ jobType: contract.jobType, results })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('[workers] Memory sync worker ready');
  void runFromEnv();
  process.stdin.resume();
}

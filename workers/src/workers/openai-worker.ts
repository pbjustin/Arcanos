import { fileURLToPath } from 'url';
import { TypedWorkerQueue } from '../queue/index.js';
import { openaiCompletionHandler, openaiEmbeddingHandler } from '../handlers/openai.js';
import { resolveWorkerJobContract, sanitizeWorkerLogPayload } from '../infrastructure/sdk/openaiConfig.js';

const queue = new TypedWorkerQueue();

queue.register('OPENAI_COMPLETION', openaiCompletionHandler);
queue.register('OPENAI_EMBEDDING', openaiEmbeddingHandler);

export function startOpenAIWorker() {
  return queue;
}

async function runFromEnv() {
  const contract = resolveWorkerJobContract();
  if (contract.error) {
    //audit Assumption: malformed runtime contract should not dispatch arbitrary work; risk: undefined behavior; invariant: invalid contract exits safely; handling: log and return.
    console.error(`[workers] OpenAI worker contract error: ${sanitizeWorkerLogPayload(contract.error)}`);
    return;
  }

  if (!contract.jobType || contract.payload === null) {
    return;
  }

  const results = await queue.dispatch(contract.jobType, contract.payload as never);
  console.log(JSON.stringify(sanitizeWorkerLogPayload({ jobType: contract.jobType, results })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('[workers] OpenAI worker ready');
  void runFromEnv();
  process.stdin.resume();
}

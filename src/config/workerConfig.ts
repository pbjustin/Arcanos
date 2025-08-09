import { EventEmitter } from 'events';
import { getOpenAIClient } from '../services/openai.js';
import { runARCANOS } from '../logic/arcanos.js';

// Environment configuration
export const workerSettings = {
  runWorkers: process.env.RUN_WORKERS === 'true' || process.env.RUN_WORKERS === '1',
  count: parseInt(process.env.WORKER_COUNT || '4', 10),
  model: process.env.WORKER_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH'
};

// Simple task queue based on EventEmitter
class WorkerTaskQueue extends EventEmitter {
  register(task: (input: string) => Promise<WorkerResult>): void {
    this.on('task', task);
  }

  async dispatch(input: string): Promise<void> {
    const listeners = this.listeners('task');
    for (const listener of listeners) {
      await (listener as (input: string) => Promise<WorkerResult>)(input);
    }
  }
}

export const workerTaskQueue = new WorkerTaskQueue();

// GPT-5 reasoning helper
export async function gpt5Reasoning(prompt: string): Promise<string> {
  const client = getOpenAIClient();
  if (!client) return '[Fallback: GPT-5 unavailable]';

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 1024,
      temperature: 0.7
    });
    return response.choices[0]?.message?.content ?? '[No reasoning provided]';
  } catch (err: any) {
    console.error('[GPT-5 ERROR]', err.message);
    return '[Fallback: GPT-5 unavailable]';
  }
}

// Use the return type of runARCANOS to keep compatibility
type ArcanosResult = Awaited<ReturnType<typeof runARCANOS>>;
export type WorkerResult = Partial<ArcanosResult> & { reasoning?: string; error?: string };

// Worker logic loop
export async function workerTask(input: string): Promise<WorkerResult> {
  const client = getOpenAIClient();
  if (!client) {
    return { error: 'OpenAI client unavailable' } as WorkerResult;
  }

  const logicOutput = await runARCANOS(client, input);

  if (logicOutput.reasoningDelegation?.used && logicOutput.reasoningDelegation.delegatedQuery) {
    const reasoning = await gpt5Reasoning(logicOutput.reasoningDelegation.delegatedQuery);
    return { ...logicOutput, reasoning };
  }

  return logicOutput;
}

// Register workers
export function startWorkers(): void {
  for (let i = 0; i < workerSettings.count; i++) {
    console.log(`[WORKER] Starting worker #${i + 1} using ARCANOS logic + GPT-5 reasoning...`);
    workerTaskQueue.register(workerTask);
  }
}

if (workerSettings.runWorkers) {
  startWorkers();
}


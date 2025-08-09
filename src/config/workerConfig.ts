import { EventEmitter } from 'events';
import { getOpenAIClient } from '../services/openai.js';
import { runARCANOS } from '../logic/arcanos.js';

// ✅ Environment setup
process.env.RUN_WORKERS = "true"; // Enable workers
process.env.WORKER_COUNT = process.env.WORKER_COUNT || "4";
process.env.WORKER_MODEL = "REDACTED_FINE_TUNED_MODEL_ID"; // ARCANOS core

// Environment configuration
export const workerSettings = {
  runWorkers: process.env.RUN_WORKERS === 'true' || process.env.RUN_WORKERS === '1',
  count: parseInt(process.env.WORKER_COUNT || '4', 10),
  model: process.env.WORKER_MODEL || 'REDACTED_FINE_TUNED_MODEL_ID'
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

// ✅ GPT-5 reasoning function (SDK-compatible fix)
export async function gpt5Reasoning(prompt: string): Promise<string> {
  const client = getOpenAIClient();
  if (!client) return '[Fallback: GPT-5 unavailable]';

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 1024, // ✅ Correct parameter
      temperature: 1 // ✅ GPT-5 only supports default (1)
    });
    return response.choices[0]?.message?.content ?? '[No reasoning provided]';
  } catch (err: any) {
    console.error('[GPT-5 ERROR]', err.message);
    return '[Fallback: GPT-5 unavailable]';
  }
}

// Use the return type of runARCANOS to keep compatibility
type ArcanosResult = Awaited<ReturnType<typeof runARCANOS>>;
export type WorkerResult = Partial<ArcanosResult> & { reasoning?: string; error?: string; requiresReasoning?: boolean; reasoningPrompt?: string };

// ✅ ARCANOS core logic alias for compatibility with problem statement
export async function arcanosCoreLogic(input: string): Promise<WorkerResult> {
  const client = getOpenAIClient();
  if (!client) {
    return { error: 'OpenAI client unavailable' } as WorkerResult;
  }

  const logicOutput = await runARCANOS(client, input);
  
  // Transform the output to match problem statement structure
  const result: WorkerResult = {
    ...logicOutput,
    requiresReasoning: logicOutput.reasoningDelegation?.used || false,
    reasoningPrompt: logicOutput.reasoningDelegation?.delegatedQuery
  };

  return result;
}

// ✅ Worker main task
export async function workerTask(input: string): Promise<WorkerResult> {
  // Step 1: Run ARCANOS core logic
  const logicOutput = await arcanosCoreLogic(input);

  // Step 2: If reasoning is required, consult GPT-5
  if (logicOutput.requiresReasoning && logicOutput.reasoningPrompt) {
    const reasoning = await gpt5Reasoning(logicOutput.reasoningPrompt);
    return { ...logicOutput, reasoning };
  }

  return logicOutput;
}

// ✅ Worker startup
export function startWorkers(): void {
  for (let i = 0; i < workerSettings.count; i++) {
    console.log(`[WORKER] Starting worker #${i + 1} with ARCANOS logic + GPT-5 reasoning...`);
    workerTaskQueue.register(workerTask);
  }
}

if (process.env.RUN_WORKERS === "true") {
  startWorkers();
}


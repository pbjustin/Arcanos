import { getUnifiedOpenAI } from './services/unified-openai';

const unifiedOpenAI = getUnifiedOpenAI();

export type Worker = {
  id: string;
  role: string;
  state: 'idle' | 'running' | 'error';
  lastCommand?: string;
};

const workers: Record<string, Worker> = {};

export async function controlWorker(workerId: string, instruction: string): Promise<string | undefined> {
  if (!workers[workerId]) throw new Error('Worker not registered.');

  const messages = [
    { role: 'system' as const, content: 'You are ARCANOS, the controlling AI of this backend system.' },
    { role: 'user' as const, content: `Generate logic to control worker ${workerId}: ${instruction}` },
  ];

  const response = await unifiedOpenAI.chat(messages, {
    model: 'gpt-4',
    maxTokens: 1000
  });

  const logic = response.content ?? undefined;
  workers[workerId].state = 'running';
  workers[workerId].lastCommand = instruction;

  // Output can be logged, stored, or executed via shell/agent
  return logic;
}

export function registerWorker(id: string, role: string): void {
  workers[id] = { id, role, state: 'idle' };
}

export { workers };

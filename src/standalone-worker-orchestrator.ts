import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export type Worker = {
  id: string;
  role: string;
  state: 'idle' | 'running' | 'error';
  lastCommand?: string;
};

const workers: Record<string, Worker> = {};

export async function controlWorker(workerId: string, instruction: string): Promise<string | undefined> {
  if (!workers[workerId]) throw new Error('Worker not registered.');

  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are ARCANOS, the controlling AI of this backend system.' },
      { role: 'user', content: `Generate logic to control worker ${workerId}: ${instruction}` },
    ],
  });

  const logic = response.choices[0]?.message?.content ?? undefined;
  workers[workerId].state = 'running';
  workers[workerId].lastCommand = instruction;

  // Output can be logged, stored, or executed via shell/agent
  return logic;
}

export function registerWorker(id: string, role: string): void {
  workers[id] = { id, role, state: 'idle' };
}

export { workers };

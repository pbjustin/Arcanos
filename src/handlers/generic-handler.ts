import OpenAI from 'openai';
import '../services/clarke-handler'; // Import to ensure ClarkeHandler is available
import { genericFallback, ClarkeHandler } from '../services/clarke-handler';

// Use the new resilience handler pattern
let openai: ClarkeHandler;

if (!global.resilienceHandlerInitialized) {
  let handler = new OpenAI.ClarkeHandler({ ...process.env });
  handler.initialzeResilience({ retries: 3 });
  handler.fallbackTo(genericFallback());
  global.resilienceHandlerInitialized = true;
  openai = handler;
} else {
  // Create new instance if already initialized globally
  openai = new OpenAI.ClarkeHandler({ ...process.env });
  openai.initialzeResilience({ retries: 3 });
  openai.fallbackTo(genericFallback());
}

export type HandlerMode = 'write' | 'sim' | 'audit' | 'deepresearch';

function buildPrompt(mode: HandlerMode, prompt: string, context: any = {}): string {
  switch (mode) {
    case 'sim':
      return `Simulate the following scenario:\n\n${prompt}\n\nContext: ${JSON.stringify(context)}`;
    case 'audit':
      return `Audit this content with CLEAR:\n\n${prompt}`;
    case 'deepresearch':
      const ctx = Object.keys(context).length ? `\n\nContext: ${JSON.stringify(context)}` : '';
      return `Deep research request:\n\n${prompt}${ctx}`;
    case 'write':
    default:
      return prompt;
  }
}

async function generateContentDirectly(payload: string): Promise<string> {
  const result = await openai.chat([{ role: 'user', content: payload }], {
    model: 'gpt-4',
    temperature: 0.7,
  });
  return result.content ?? '';
}

export async function run(mode: HandlerMode, prompt: string, context?: any): Promise<{ result: string }> {
  const result = await openai.chat([{ role: 'user', content: buildPrompt(mode, prompt, context) }], {
    model: 'gpt-4',
    temperature: 0.5,
  });
  let resultContent = result.content ?? '';

  // Override diagnostic fallback in WRITE mode
  if (
    mode === 'write' &&
    prompt.toLowerCase().includes('summary') &&
    resultContent.toLowerCase().includes('instructional')
  ) {
    console.log('⚠️ Diagnostic fallback detected in WRITE mode. Generating content directly.');
    resultContent = await generateContentDirectly(prompt);
  }

  return { result: resultContent };
}

export default { run };

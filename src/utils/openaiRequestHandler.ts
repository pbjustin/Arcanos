import OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'openai/resources';

export type Mode = 'write' | 'sim' | 'audit' | 'codegen';

export interface RequestOptions {
  query: string;
  mode?: Mode;
  context?: Record<string, any>;
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

const openai = new OpenAI({ apiKey });

function buildParams(message: string, temperature: number, model: string): ChatCompletionCreateParams {
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: message }];
  return { model, messages, temperature };
}

async function runWriteHandler(query: string) {
  return openai.chat.completions.create(buildParams(query, 0.7, 'gpt-4'));
}

async function runSimHandler(query: string, context: Record<string, any>) {
  const simPrompt = `Simulate the following scenario:\n\n${query}\n\nContext: ${JSON.stringify(context)}`;
  return openai.chat.completions.create(buildParams(simPrompt, 0.75, 'gpt-4'));
}

async function runAuditHandler(query: string) {
  const auditPrompt = `Audit this logic using CLEAR:\n\n${query}`;
  return openai.chat.completions.create(buildParams(auditPrompt, 0.3, 'gpt-3.5-turbo'));
}

async function runCodegenHandler(query: string) {
  const codePrompt = `Generate clean code:\n\n${query}`;
  return openai.chat.completions.create(buildParams(codePrompt, 0.2, 'gpt-4'));
}

const handlers: Record<Mode, (query: string, context: Record<string, any>) => Promise<any>> = {
  write: async (q) => runWriteHandler(q),
  sim: runSimHandler,
  audit: async (q) => runAuditHandler(q),
  codegen: async (q) => runCodegenHandler(q),
};

export async function handleOpenAIRequest({ query, mode = 'write', context = {} }: RequestOptions) {
  const handler = handlers[mode];
  if (!handler) {
    return {
      error: 'Unrecognized mode. Valid modes: write, sim, audit, codegen.',
    };
  }
  return handler(query, context);
}

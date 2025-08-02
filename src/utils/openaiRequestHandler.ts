import OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'openai/resources';
import { callArcanosModel } from '../config/ai-model';
import { runDeepResearch } from '../modules/deepResearchHandler';
import { webFetchHandler } from '../handlers/webFetchHandler';

export type Mode = 'write' | 'sim' | 'audit' | 'codegen' | 'deepresearch';

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

function buildParams(message: string, temperature: number): ChatCompletionCreateParams {
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: message }];
  return { messages, temperature } as ChatCompletionCreateParams;
}

async function runWriteHandler(query: string) {
  return callArcanosModel(openai, buildParams(query, 0.7));
}

async function runSimHandler(query: string, context: Record<string, any>) {
  const simPrompt = `Simulate the following scenario:\n\n${query}\n\nContext: ${JSON.stringify(context)}`;
  return callArcanosModel(openai, buildParams(simPrompt, 0.75));
}

async function runAuditHandler(query: string) {
  const auditPrompt = `Audit this logic using CLEAR:\n\n${query}`;
  return callArcanosModel(openai, buildParams(auditPrompt, 0.3));
}

async function runCodegenHandler(query: string) {
  const codePrompt = `Generate clean code:\n\n${query}`;
  return callArcanosModel(openai, buildParams(codePrompt, 0.2));
}

async function runDeepResearchHandler(query: string, context: Record<string, any>) {
  return runDeepResearch(query, context);
}

const handlers: Record<Mode, (query: string, context: Record<string, any>) => Promise<any>> = {
  write: async (q) => runWriteHandler(q),
  sim: runSimHandler,
  audit: async (q) => runAuditHandler(q),
  codegen: async (q) => runCodegenHandler(q),
  deepresearch: runDeepResearchHandler,
};

export async function handleOpenAIRequest({ query, mode = 'write', context = {} }: RequestOptions) {
  if (/(latest|news|current)/i.test(query)) {
    const webResult = await webFetchHandler(query, context);
    if (webResult) return webResult;
  }
  const handler = handlers[mode];
  if (!handler) {
    return {
      error: 'Unrecognized mode. Valid modes: write, sim, audit, codegen, deepresearch.',
    };
  }
  return handler(query, context);
}

import { callOpenAI, getDefaultModel } from '../services/openai.js';

export interface TutorPayload {
  type: 'audit' | 'explain' | 'loop';
  data: any;
}

export async function dispatch(payload: TutorPayload): Promise<any> {
  const { type, data } = payload;
  switch (type) {
    case 'audit':
      return runAudit(data);
    case 'explain':
      return provideExplanation(data);
    case 'loop':
      return feedbackLoop(data);
    default:
      return { status: 'error', message: `Unknown type: ${type}` };
  }
}

async function runAudit(data: any): Promise<any> {
  // Placeholder audit logic
  return { status: 'audited', details: data };
}

async function provideExplanation(data: any): Promise<any> {
  const model = getDefaultModel();
  const input = typeof data === 'string' ? data : JSON.stringify(data);
  const prompt = `Explain in clear, structured steps:\n${input}`;
  const { output } = await callOpenAI(model, prompt, 300);
  return { instruction: output, input: data };
}

async function feedbackLoop(data: any): Promise<any> {
  return { looped: true, revision: data?.revision ?? 1 };
}

export default {
  dispatch,
};


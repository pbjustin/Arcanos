import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

export async function run(mode: HandlerMode, prompt: string, context?: any): Promise<{ result: string }> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: buildPrompt(mode, prompt, context) }],
    temperature: 0.5,
  });
  return { result: response.choices[0]?.message?.content ?? '' };
}

export default { run };

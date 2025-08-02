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

async function generateContentDirectly(payload: string): Promise<string> {
  const direct = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: payload }],
    temperature: 0.7,
  });
  return direct.choices[0]?.message?.content ?? '';
}

export async function run(mode: HandlerMode, prompt: string, context?: any): Promise<{ result: string }> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: buildPrompt(mode, prompt, context) }],
    temperature: 0.5,
  });
  let result = response.choices[0]?.message?.content ?? '';

  // Override diagnostic fallback in WRITE mode
  if (
    mode === 'write' &&
    prompt.toLowerCase().includes('summary') &&
    result.toLowerCase().includes('instructional')
  ) {
    console.log('⚠️ Diagnostic fallback detected in WRITE mode. Generating content directly.');
    result = await generateContentDirectly(prompt);
  }

  return { result };
}

export default { run };

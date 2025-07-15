import openai from '../services/openai.service.js';

export default async function askOpenAI(prompt: string): Promise<string> {
  const chat = await openai.chat.completions.create({
    model: 'ft:gpt-3.5-turbo-0125:personal:arcanos-v1-1106:BpYtP0ox',
    messages: [{ role: 'user', content: prompt }],
  });

  return chat.choices?.[0]?.message?.content?.trim() || 'No response';
}
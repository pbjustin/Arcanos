import { OpenAI } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function runCodexPrompt(prompt: string, model = 'gpt-4') {
  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });

    return response.choices[0].message?.content || '❌ No Codex output.';
  } catch (err: any) {
    console.error('Codex error:', err.message);
    return '❌ Codex request failed.';
  }
}

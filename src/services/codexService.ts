import { safeImport } from '../utils/safeImport';

const dotenv = safeImport<typeof import('dotenv')>('dotenv');
const openaiLib = safeImport<typeof import('openai')>('openai');
const OpenAI = openaiLib?.OpenAI || (openaiLib as any);
// Initialize dotenv if available
dotenv?.config();

const openai = OpenAI
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export async function runCodexPrompt(prompt: string, model = 'gpt-4') {
  if (!openai) {
    return '❌ OpenAI SDK unavailable';
  }
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

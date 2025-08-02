import OpenAI from 'openai';
import { fetchWebSearch } from '../utils/webSearch';
import { storeMemory } from '../services/memory';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function webFetchHandler(query: string, context: any = {}) {
  if (!/(latest|current|news)/i.test(query)) return null;

  try {
    const rawSearch = await fetchWebSearch(query);
    const summary = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Summarize the following search results for high-trust use in AI synthesis.' },
        { role: 'user', content: rawSearch },
      ],
      temperature: 0.4,
    });

    const content = summary.choices?.[0]?.message?.content?.trim() || '[no result]';

    await storeMemory(`external/web_${Date.now()}`, {
      type: 'external',
      source: 'webSearch',
      prompt: query,
      content,
      context,
    });

    return {
      source: 'WebFetchHandler',
      injected: true,
      summary: content,
      original: rawSearch,
    };
  } catch (error: any) {
    console.error('Web fetch handler failed:', error.message);
    return null;
  }
}

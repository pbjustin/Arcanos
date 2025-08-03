import OpenAI from 'openai';
import '../services/clarke-handler.js'; // Import to ensure ClarkeHandler is available
import { genericFallback, ClarkeHandler } from '../services/clarke-handler.js';
import { fetchWebSearch } from '../utils/webSearch.js';
import { storeMemory } from '../services/memory.js';

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

export async function webFetchHandler(query: string, context: any = {}) {
  if (!/(latest|current|news)/i.test(query)) return null;

  try {
    const rawSearch = await fetchWebSearch(query);
    const result = await openai.chat([
      { role: 'system', content: 'Summarize the following search results for high-trust use in AI synthesis.' },
      { role: 'user', content: rawSearch },
    ], {
      model: 'gpt-4',
      temperature: 0.4,
    });

    const content = result.content?.trim() || '[no result]';

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

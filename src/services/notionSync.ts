import { Client as NotionClient } from '@notionhq/client';
import { getOpenAIClient, getGPT5Model } from './openai.js';

// Initialize Notion client using API key
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });

export interface UniverseRoster {
  count: number;
  roster: string[];
}

/**
 * Query a Notion database and return formatted roster names
 * @param databaseId - Notion database ID
 */
export async function getUniverseRoster(databaseId: string): Promise<UniverseRoster> {
  if (!process.env.NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY is not configured');
  }

  try {
    const response = await notion.databases.query({ database_id: databaseId });

    const roster = response.results.map(page => getNotionTitle(page));

    return { count: roster.length, roster };
  } catch (error: unknown) {
    //audit Assumption: Notion query failures should surface
    console.error('[NotionSync] Error fetching Universe Roster:', error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Use GPT-5.1 to analyze roster data
 */
export async function analyzeRoster(roster: string[]): Promise<string> {
  const client = getOpenAIClient();
  //audit Assumption: OpenAI client required for analysis
  if (!client) {
    throw new Error('OpenAI client not initialized');
  }

  const prompt = `You are ARCANOS Universe Mode AI.\nGiven this roster: ${JSON.stringify(roster)},\nsummarize the roster count and highlight notable entries.`;

  const completion = await client.chat.completions.create({
    model: getGPT5Model(),
    messages: [{ role: 'user', content: prompt }]
  });

  return completion.choices[0]?.message?.content ?? '';
}

function getNotionTitle(page: unknown): string {
  if (!page || typeof page !== 'object') {
    return 'Unnamed Entry';
  }
  const record = page as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  const name = properties?.Name as Record<string, unknown> | undefined;
  const title = Array.isArray(name?.title) ? name?.title : [];
  const first = title[0] as Record<string, unknown> | undefined;
  return typeof first?.plain_text === 'string' ? first.plain_text : 'Unnamed Entry';
}

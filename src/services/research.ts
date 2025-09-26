import { promises as fs } from 'fs';
import path from 'path';
import { fetchAndClean } from './webFetcher.js';
import {
  createCentralizedCompletion,
  getOpenAIClient,
  getDefaultModel
} from './openai.js';
import { setMemory } from './memory.js';

export interface ResearchSourceSummary {
  url: string;
  summary: string;
}

export interface ResearchResult {
  topic: string;
  insight: string;
  sourcesProcessed: number;
  sources: ResearchSourceSummary[];
  failedUrls: string[];
  generatedAt: string;
  model: string;
}

const MAX_CONTENT_CHARS = parseInt(process.env.RESEARCH_MAX_CONTENT_CHARS ?? '6000', 10);

function sanitizeSegment(segment: string): string {
  return segment
    .replace(/\.\.+/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/[\\]/g, '-')
    .trim() || 'topic';
}

function resolveSourcesDir(topic: string): string {
  const safeTopic = sanitizeSegment(topic);
  return path.join('memory', 'research', safeTopic, 'sources');
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function createMockResult(topic: string, urls: string[]): ResearchResult {
  const generatedAt = new Date().toISOString();
  const sources = urls.map((url, index) => ({
    url,
    summary: `Mock summary for source #${index + 1}: ${url}`
  }));
  const insight = `Mock research brief for "${topic}". Analyzed ${urls.length} sources.`;
  return {
    topic,
    insight,
    sourcesProcessed: urls.length,
    sources,
    failedUrls: [],
    generatedAt,
    model: 'mock'
  };
}

export async function researchTopic(topic: string, urls: string[] = []): Promise<ResearchResult> {
  if (!topic || !topic.trim()) {
    throw new Error('Topic is required for research');
  }

  const generatedAt = new Date().toISOString();
  const client = getOpenAIClient();
  const useMock = !client || process.env.OPENAI_API_KEY === 'test_key_for_mocking';

  if (useMock) {
    const mockResult = createMockResult(topic, urls);
    await persistResearch(topic, mockResult);
    return mockResult;
  }

  const summaries: ResearchSourceSummary[] = [];
  const failedUrls: string[] = [];

  for (const url of urls) {
    try {
      const raw = await fetchAndClean(url);
      const content = raw.slice(0, MAX_CONTENT_CHARS);
      const messages = [
        {
          role: 'system' as const,
          content:
            'You are ARCANOS Research Summarizer. Provide a concise, factual summary of the provided source. Highlight key points relevant to the topic and keep it under 180 words.'
        },
        {
          role: 'user' as const,
          content: `Topic: ${topic}\nSource URL: ${url}\n\nContent (truncated):\n${content}`
        }
      ];
      const response = await createCentralizedCompletion(messages, {
        temperature: 0.2,
        max_tokens: 600
      });
      const summary = (response as any)?.choices?.[0]?.message?.content?.trim();
      if (summary) {
        summaries.push({ url, summary });
      } else {
        failedUrls.push(url);
      }
    } catch (error) {
      console.error(`Failed to process research source ${url}:`, error);
      failedUrls.push(url);
    }
  }

  const synthesisMessages = [
    {
      role: 'system' as const,
      content:
        'You are ARCANOS Research Synthesizer. Combine provided source notes into a cohesive research brief with citations in the form [Source #]. Finish with a sentence that states how many sources were analyzed.'
    },
    {
      role: 'user' as const,
      content: summaries.length
        ? summaries
            .map((source, index) => `Source [${index + 1}] (${source.url}):\n${source.summary}`)
            .join('\n\n')
        : `No external sources were available. Provide a brief overview of ${topic} using general knowledge.`
    }
  ];

  const synthesis = await createCentralizedCompletion(synthesisMessages, {
    temperature: 0.25,
    max_tokens: 900
  });
  const insight = (synthesis as any)?.choices?.[0]?.message?.content?.trim() || '';

  const result: ResearchResult = {
    topic,
    insight: insight || `No insight generated for ${topic}.`,
    sourcesProcessed: summaries.length,
    sources: summaries,
    failedUrls,
    generatedAt,
    model: getDefaultModel()
  };

  await persistResearch(topic, result);

  return result;
}

async function persistResearch(topic: string, result: ResearchResult): Promise<void> {
  const safeTopic = sanitizeSegment(topic);
  const summaryPath = `research/${safeTopic}/summary`;
  await setMemory(summaryPath, {
    topic,
    insight: result.insight,
    sources: result.sourcesProcessed,
    failedUrls: result.failedUrls,
    generatedAt: result.generatedAt,
    model: result.model
  });

  const sourcesDir = resolveSourcesDir(safeTopic);
  await ensureDir(sourcesDir);

  await Promise.all(
    result.sources.map(async (source, index) => {
      const sourcePath = `research/${safeTopic}/sources/${index + 1}`;
      await setMemory(sourcePath, {
        url: source.url,
        summary: source.summary,
        generatedAt: result.generatedAt
      });
    })
  );

  if (result.sources.length === 0) {
    const sourcePath = `research/${safeTopic}/sources/overview`;
    await setMemory(sourcePath, {
      note: 'No external sources processed.',
      generatedAt: result.generatedAt
    });
  }
}

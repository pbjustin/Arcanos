import { promises as fs } from 'fs';
import path from 'path';
import { fetchAndClean } from "@shared/webFetcher.js";
import {
  createCentralizedCompletion,
  getDefaultModel
} from './openai.js';
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';
import { setMemory } from './memory.js';
import { RESEARCH_SUMMARIZER_PROMPT, RESEARCH_SYNTHESIS_PROMPT } from "@platform/runtime/researchPrompts.js";
import { getEnvNumber, getEnv } from "@platform/runtime/env.js";
import type OpenAI from 'openai';
import { resolveErrorMessage } from "@core/lib/errors/index.js";

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

const MAX_CONTENT_CHARS = getEnvNumber('RESEARCH_MAX_CONTENT_CHARS', 6000);

function resolveResearchModel(): string {
  const configuredModel = getEnv('RESEARCH_MODEL_ID')?.trim();
  return configuredModel && configuredModel.length > 0 ? configuredModel : getDefaultModel();
}

function sanitizeSegment(segment: string): string {
  const cleaned = segment
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.\.+/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/[\\/]/g, '-')
    .trim();

  //audit Assumption: empty or dot paths are unsafe; risk: path traversal or empty directories; invariant: safe folder name; handling: fallback.
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'topic';
  }

  return cleaned;
}

function resolveSourcesDir(topic: string): string {
  const safeTopic = sanitizeSegment(topic);
  return path.join('memory', 'research', safeTopic, 'sources');
}

async function runResearchCompletion(
  messages: Parameters<typeof createCentralizedCompletion>[0],
  model: string,
  temperature: number,
  maxTokens: number
): Promise<string> {
  const response = await createCentralizedCompletion(messages, {
    temperature,
    max_tokens: maxTokens,
    model
  });

  return extractCompletionText(response);
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
  //audit Assumption: topic must be present for research
  if (!topic || !topic.trim()) {
    throw new Error('Topic is required for research');
  }

  const generatedAt = new Date().toISOString();
  const { adapter } = getOpenAIClientOrAdapter();
  // Use config for mock detection (adapter boundary pattern)
  const apiKey = getEnv('OPENAI_API_KEY');
  const useMock = !adapter || apiKey === 'test_key_for_mocking';
  const researchModel = resolveResearchModel();

  //audit Assumption: mock mode when client missing or test key
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
          content: RESEARCH_SUMMARIZER_PROMPT
        },
        {
          role: 'user' as const,
          content: `Topic: ${topic}\nSource URL: ${url}\n\nContent (truncated):\n${content}`
        }
      ];
      const summary = await runResearchCompletion(messages, researchModel, 0.2, 600);
      if (summary) {
        summaries.push({ url, summary });
      } else {
        failedUrls.push(url);
      }
    } catch (error: unknown) {
      //audit Assumption: source failures should be tracked, not fatal
      console.error(`Failed to process research source ${url}:`, resolveErrorMessage(error));
      failedUrls.push(url);
    }
  }

  const synthesisMessages = [
    {
      role: 'system' as const,
      content: RESEARCH_SYNTHESIS_PROMPT
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

  const insight = await runResearchCompletion(synthesisMessages, researchModel, 0.25, 900);

  const result: ResearchResult = {
    topic,
    insight: insight || `No insight generated for ${topic}.`,
    sourcesProcessed: summaries.length,
    sources: summaries,
    failedUrls,
    generatedAt,
    model: researchModel
  };

  await persistResearch(topic, result);

  return result;
}

function extractCompletionText(
  response: Awaited<ReturnType<typeof createCentralizedCompletion>>
): string {
  //audit Assumption: non-stream responses contain choices[0].message.content
  if (response && typeof response === 'object' && 'choices' in response) {
    const completion = response as OpenAI.Chat.Completions.ChatCompletion;
    return completion.choices?.[0]?.message?.content?.trim() || '';
  }
  return '';
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

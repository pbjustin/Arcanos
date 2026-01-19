import { randomUUID } from 'crypto';
import { getOpenAIClient, getDefaultModel, hasValidAPIKey } from './openai.js';
import { createEmbedding } from './openai/embeddings.js';
import { fetchAndClean } from './webFetcher.js';
import { cosineSimilarity } from '../utils/vectorUtils.js';
import { saveRagDoc, loadAllRagDocs, initializeDatabase, getStatus } from '../db.js';
import { logger } from '../utils/structuredLogging.js';

interface Doc {
  id: string;
  url: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

let vectorStore: Doc[] | null = null;
const ragLogger = logger.child({ module: 'webRag' });

function upsertDoc(doc: Doc): void {
  if (!vectorStore) {
    vectorStore = [];
  }
  const existingIndex = vectorStore.findIndex((existing) => existing.id === doc.id);
  if (existingIndex >= 0) {
    vectorStore[existingIndex] = doc;
  } else {
    vectorStore.push(doc);
  }
}

function sanitizeMetadataInput(metadata?: Record<string, unknown>): Record<string, unknown> {
  if (!metadata) {
    return {};
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(metadata));
  } catch {
    return {};
  }
}

interface SourceDetail {
  id: string;
  url: string;
  metadata?: Record<string, unknown>;
}

async function ensureStore(): Promise<void> {
  if (vectorStore !== null) {
    return;
  }

  const status = getStatus();
  if (!status.connected) {
    try {
      const connected = await initializeDatabase('web-rag');
      if (!connected) {
        console.warn('[🧠 RAG] Database unavailable - using in-memory vector store');
        vectorStore = [];
        return;
      }
    } catch (error) {
      console.warn('[🧠 RAG] Database initialization failed - using in-memory vector store', error);
      vectorStore = [];
      return;
    }
  }

  try {
    vectorStore = await loadAllRagDocs();
  } catch (error) {
    console.warn('[🧠 RAG] Failed to load documents from database - using in-memory vector store', error);
    vectorStore = [];
  }
}

export async function ingestUrl(url: string): Promise<Doc> {
  await ensureStore();
  const content = await fetchAndClean(url);
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not initialized');
  }
  const doc: Doc = {
    id: url,
    url,
    content,
    embedding: await createEmbedding(content, client),
    metadata: {
      sourceType: 'url',
      fetchedAt: new Date().toISOString(),
    },
  };
  try {
    await saveRagDoc(doc);
  } catch (error) {
    console.warn('[🧠 RAG] Failed to persist document to database - retaining in-memory copy', error);
  }
  upsertDoc(doc);
  return doc;
}

interface IngestContentOptions {
  id?: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export async function ingestContent(options: IngestContentOptions): Promise<Doc> {
  const { id, content, source, metadata } = options;
  await ensureStore();
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not initialized');
  }

  const docId = (id && id.trim()) || randomUUID();
  const sourceLabel = (source && source.trim()) || docId;
  const sanitizedMetadata = sanitizeMetadataInput(metadata);
  if (!('sourceType' in sanitizedMetadata)) {
    sanitizedMetadata.sourceType = 'direct';
  }
  sanitizedMetadata.savedAt = new Date().toISOString();
  if (sourceLabel) {
    sanitizedMetadata.source = sourceLabel;
  }

  const doc: Doc = {
    id: docId,
    url: sourceLabel,
    content,
    embedding: await createEmbedding(content, client),
    metadata: sanitizedMetadata,
  };

  try {
    await saveRagDoc(doc);
  } catch (error) {
    console.warn('[🧠 RAG] Failed to persist document to database - retaining in-memory copy', error);
  }

  upsertDoc(doc);
  return doc;
}

interface ConversationSnippetOptions {
  sessionId: string;
  role: string;
  content: string;
  timestamp?: number;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export async function recordConversationSnippet(options: ConversationSnippetOptions): Promise<boolean> {
  const { sessionId, role, content, timestamp, channel = 'conversations_core', metadata } = options;
  const trimmed = typeof content === 'string' ? content.trim() : '';

  if (!trimmed) {
    return false;
  }

  if (!hasValidAPIKey()) {
    ragLogger.debug('Skipping conversation ingestion - OpenAI key missing', {
      operation: 'recordConversationSnippet',
      sessionId,
      channel,
    });
    return false;
  }

  const snippetMetadata = sanitizeMetadataInput(metadata);
  if (!('sourceType' in snippetMetadata)) {
    snippetMetadata.sourceType = 'conversation';
  }
  snippetMetadata.sessionId = sessionId;
  snippetMetadata.role = role;
  snippetMetadata.channel = channel;
  if (timestamp !== undefined) {
    snippetMetadata.timestamp = new Date(timestamp).toISOString();
    snippetMetadata.timestampMs = timestamp;
  }

  try {
    await ingestContent({
      content: trimmed,
      source: `session:${sessionId}`,
      metadata: snippetMetadata,
    });
    return true;
  } catch (error) {
    ragLogger.warn('Failed to ingest conversation snippet', {
      operation: 'recordConversationSnippet',
      sessionId,
      channel,
    }, undefined, error instanceof Error ? error : undefined);
    return false;
  }
}

export async function answerQuestion(question: string): Promise<{ answer: string; sources: string[]; verification: string; sourceDetails: SourceDetail[] }> {
  await ensureStore();
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not initialized');
  }
  const qEmbedding = await createEmbedding(question, client);
  const docs = vectorStore || [];
  const scored = docs.map((doc) => ({
    doc,
    score: cosineSimilarity(qEmbedding, doc.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topDocs = scored.slice(0, 3).map((s) => s.doc);

  const context = topDocs.map((d) => {
    const metadataText = d.metadata && Object.keys(d.metadata).length
      ? `Metadata: ${JSON.stringify(d.metadata)}\n`
      : '';
    return `${metadataText}${d.content}`;
  }).join('\n---\n');
  const answerRes = await client.chat.completions.create({
    model: getDefaultModel(),
    messages: [
      { role: 'system', content: 'Answer the question using the provided context.' },
      { role: 'user', content: `Question: ${question}\n\nContext:\n${context}` },
    ],
  });
  const answer = answerRes.choices[0]?.message?.content || '';

  const verifyRes = await client.chat.completions.create({
    model: getDefaultModel(),
    messages: [
      { role: 'system', content: 'Verify if the answer is supported by the context. Reply yes or no with a brief reason.' },
      { role: 'user', content: `Answer: ${answer}\n\nContext:\n${context}` },
    ],
  });
  const verification = verifyRes.choices[0]?.message?.content || '';

  return {
    answer,
    sources: topDocs.map((d) => d.url),
    verification,
    sourceDetails: topDocs.map((d) => ({ id: d.id, url: d.url, metadata: d.metadata })),
  };
}

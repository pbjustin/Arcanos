import { getOpenAIClient, getDefaultModel } from './openai.js';
import { fetchAndClean } from './webFetcher.js';
import { cosineSimilarity } from '../utils/vectorUtils.js';
import { saveRagDoc, loadAllRagDocs, initializeDatabase, getStatus } from '../db.js';

interface Doc {
  id: string;
  url: string;
  content: string;
  embedding: number[];
}

let vectorStore: Doc[] | null = null;

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
  const embeddingRes = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const doc: Doc = {
    id: url,
    url,
    content,
    embedding: embeddingRes.data[0].embedding,
  };
  try {
    await saveRagDoc(doc);
  } catch (error) {
    console.warn('[🧠 RAG] Failed to persist document to database - retaining in-memory copy', error);
  }
  if (!vectorStore) {
    vectorStore = [];
  }
  vectorStore.push(doc);
  return doc;
}

export async function answerQuestion(question: string): Promise<{ answer: string; sources: string[]; verification: string }> {
  await ensureStore();
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not initialized');
  }
  const qEmbed = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: question,
  });
  const docs = vectorStore || [];
  const scored = docs.map((doc) => ({
    doc,
    score: cosineSimilarity(qEmbed.data[0].embedding, doc.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topDocs = scored.slice(0, 3).map((s) => s.doc);

  const context = topDocs.map((d) => d.content).join('\n---\n');
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

  return { answer, sources: topDocs.map((d) => d.url), verification };
}

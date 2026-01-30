import { getCachedSessions } from './sessionMemoryService.js';
import { cosineSimilarity } from '../utils/vectorUtils.js';
import { createEmbedding } from './openai/embeddings.js';
import { getOpenAIAdapter } from '../adapters/openai.adapter.js';
import { getEnv } from '../config/env.js';

interface ConversationMessage {
  content?: string;
  role?: string;
  [key: string]: unknown;
}

type ConversationCore = Array<ConversationMessage> | Record<string, unknown> | null;

interface ResolveResult {
  sessionId: string;
  conversations_core: ConversationCore;
}

interface SessionMetadata {
  topic?: string;
  tags?: string[];
  summary?: string;
}

interface CachedSession {
  sessionId: string;
  metadata?: SessionMetadata;
  conversations_core?: ConversationCore;
}

/**
 * Resolve the most relevant session for a natural-language query.
 */
export async function resolveSession(nlQuery: string): Promise<ResolveResult> {
  const sessions = getCachedSessions() as CachedSession[];
  //audit Assumption: sessions must exist to resolve; Handling: throw when empty
  if (sessions.length === 0) {
    throw new Error('No sessions available');
  }

  // 1. Quick filter: topic or tags match
  let candidates = sessions.filter(sess => {
    return (
      (sess.metadata?.topic && nlQuery.toLowerCase().includes(sess.metadata.topic.toLowerCase())) ||
      (sess.metadata?.tags && sess.metadata.tags.some(tag => nlQuery.toLowerCase().includes(tag.toLowerCase())))
    );
  });

  // 2. If none found, use embeddings for semantic match
  // Use adapter (adapter boundary pattern)
  let adapter;
  try {
    adapter = getOpenAIAdapter();
  } catch {
    // No adapter available, skip semantic matching
    adapter = null;
  }
  //audit Assumption: embeddings require API key and adapter; Handling: guard
  const apiKey = getEnv('OPENAI_API_KEY');
  if (candidates.length === 0 && adapter && apiKey) {
    const queryVector = await createEmbedding(nlQuery, adapter);

    let bestMatch: typeof sessions[0] | null = null;
    let bestScore = -Infinity;

    for (const sess of sessions) {
      const metaPieces = [
        sess.metadata?.summary,
        sess.metadata?.topic,
        ...(sess.metadata?.tags || []),
        ...(Array.isArray(sess.conversations_core)
          ? sess.conversations_core.map(message => message.content || '')
          : [])
      ].filter(Boolean);
      const metaVector = await createEmbedding(metaPieces.join(' '), adapter);

      const score = cosineSimilarity(queryVector, metaVector);
      //audit Assumption: higher cosine similarity indicates better match
      if (score > bestScore) {
        bestScore = score;
        bestMatch = sess;
      }
    }

    //audit Assumption: bestMatch exists when scores computed; Handling: return
    if (bestMatch) {
      return {
        sessionId: bestMatch.sessionId,
        conversations_core: bestMatch.conversations_core ?? null,
      };
    }
  }

  // 3. Fallback: last active session
  const chosen = candidates.length > 0 ? candidates[0] : sessions[sessions.length - 1];

  return {
    sessionId: chosen.sessionId,
    conversations_core: chosen.conversations_core ?? null,
  };
}

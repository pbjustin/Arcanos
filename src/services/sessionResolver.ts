import { getOpenAIClient } from './openai.js';
import { getCachedSessions } from './sessionMemoryService.js';
import { cosineSimilarity } from '../utils/vectorUtils.js';
import { createEmbedding } from './openai/embeddings.js';

interface ResolveResult {
  sessionId: string;
  conversations_core: any;
}

export async function resolveSession(nlQuery: string): Promise<ResolveResult> {
  const sessions = getCachedSessions();
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
  const openai = getOpenAIClient();
  if (candidates.length === 0 && openai && process.env.OPENAI_API_KEY) {
    const queryVector = await createEmbedding(nlQuery, openai);

    let bestMatch: any = null;
    let bestScore = -Infinity;

    for (const sess of sessions) {
      const metaPieces = [
        sess.metadata?.summary,
        sess.metadata?.topic,
        ...(sess.metadata?.tags || []),
        ...(Array.isArray(sess.conversations_core)
          ? sess.conversations_core.map((m: any) => m.content || '')
          : [])
      ].filter(Boolean);
      const metaVector = await createEmbedding(metaPieces.join(' '), openai);

      const score = cosineSimilarity(queryVector, metaVector);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = sess;
      }
    }

    if (bestMatch) {
      return {
        sessionId: bestMatch.sessionId,
        conversations_core: bestMatch.conversations_core,
      };
    }
  }

  // 3. Fallback: last active session
  const chosen = candidates.length > 0 ? candidates[0] : sessions[sessions.length - 1];

  return {
    sessionId: chosen.sessionId,
    conversations_core: chosen.conversations_core,
  };
}

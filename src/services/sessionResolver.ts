import { getCachedSessions } from './sessionMemoryService.js';
import { loadMemory, query } from "@core/db/index.js";
import { cosineSimilarity } from "@shared/vectorUtils.js";
import { createEmbedding } from './openai/embeddings.js';
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';
import { getEnv } from "@platform/runtime/env.js";
import {
  extractNaturalLanguageSessionId
} from './naturalLanguageMemory.js';

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

interface PersistedSessionRow {
  key: string;
  value: unknown;
}

/**
 * Resolve the most relevant session for a natural-language query.
 * Inputs/outputs: natural-language query -> resolved session id plus conversation core payload.
 * Edge cases: exact persisted memory sessions are preferred before semantic cache matching.
 */
export async function resolveSession(nlQuery: string): Promise<ResolveResult> {
  const sessions = getCachedSessions() as CachedSession[];
  const explicitSessionId = resolveExplicitSessionId(nlQuery);

  if (explicitSessionId) {
    const exactCachedMatch = findCachedSessionById(sessions, explicitSessionId);
    //audit Assumption: explicit session-id references should return the named session before any semantic heuristics; failure risk: user asks for one saved recap and receives another cached session; expected invariant: exact cache id wins when present; handling strategy: short-circuit on direct cached match.
    if (exactCachedMatch) {
      return {
        sessionId: exactCachedMatch.sessionId,
        conversations_core: exactCachedMatch.conversations_core ?? null,
      };
    }

    const persistedSession = await resolvePersistedSession(explicitSessionId);
    //audit Assumption: persisted memory rows may exist even when the in-process cache is empty after restart or deploy; failure risk: recall silently drifts to unrelated active sessions; expected invariant: persisted exact session recall wins before fuzzy matching; handling strategy: return memory-backed conversation surrogate when available.
    if (persistedSession) {
      return persistedSession;
    }

    //audit Assumption: explicit session-id recalls must not degrade into semantic matching when the exact session is absent; failure risk: `/memory/resolve` returns a neighboring or most-recent session and hides the miss; expected invariant: explicit session misses stay exact and inspectable; handling strategy: return the requested session id with null conversation payload.
    return {
      sessionId: explicitSessionId,
      conversations_core: null,
    };
  }

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
  const { adapter } = getOpenAIClientOrAdapter();
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

function resolveExplicitSessionId(nlQuery: string): string | null {
  return extractNaturalLanguageSessionId(nlQuery);
}

function findCachedSessionById(sessions: CachedSession[], sessionId: string): CachedSession | null {
  const normalizedTarget = sessionId.toLowerCase();

  for (const session of sessions) {
    //audit Assumption: cached session ids are stable opaque identifiers; failure risk: case-only differences break direct recall after clients normalize ids; expected invariant: case-insensitive comparison remains deterministic; handling strategy: normalize both sides before comparison.
    if (session.sessionId.toLowerCase() === normalizedTarget) {
      return session;
    }
  }

  return null;
}

async function resolvePersistedSession(sessionId: string): Promise<ResolveResult | null> {
  const conversationPayload = await safeLoadMemory(`session:${sessionId}:conversations_core`);
  if (Array.isArray(conversationPayload)) {
    return {
      sessionId,
      conversations_core: conversationPayload as ConversationCore,
    };
  }

  const latestPointerPayload = await safeLoadMemory(`nl-latest:${sessionId}`);
  const latestKey = extractPersistedMemoryKey(latestPointerPayload);

  if (latestKey) {
    const latestPayload = await safeLoadMemory(latestKey);
    const latestConversationCore = toPersistedConversationCore(latestPayload, latestKey);
    if (latestConversationCore) {
      return {
        sessionId,
        conversations_core: latestConversationCore,
      };
    }
  }

  const fallbackRow = await loadLatestPersistedMemoryRow(sessionId);
  if (!fallbackRow) {
    return null;
  }

  const fallbackConversationCore = toPersistedConversationCore(fallbackRow.value, fallbackRow.key);
  if (!fallbackConversationCore) {
    return null;
  }

  return {
    sessionId,
    conversations_core: fallbackConversationCore,
  };
}

async function safeLoadMemory(key: string): Promise<unknown | null> {
  try {
    return await loadMemory(key);
  } catch {
    //audit Assumption: persisted memory is optional during degraded DB conditions; failure risk: exact session resolution throws instead of degrading; expected invariant: resolver can continue to other fallbacks; handling strategy: swallow storage exceptions at this boundary and return null.
    return null;
  }
}

function extractPersistedMemoryKey(pointerPayload: unknown): string | null {
  if (typeof pointerPayload === 'string' && pointerPayload.trim()) {
    return pointerPayload.trim();
  }

  if (
    pointerPayload &&
    typeof pointerPayload === 'object' &&
    'key' in pointerPayload &&
    typeof (pointerPayload as { key?: unknown }).key === 'string'
  ) {
    return ((pointerPayload as { key: string }).key).trim();
  }

  return null;
}

function toPersistedConversationCore(payload: unknown, memoryKey: string): ConversationCore {
  if (Array.isArray(payload)) {
    return payload as ConversationCore;
  }

  if (typeof payload === 'string' && payload.trim()) {
    return [{ role: 'assistant', content: payload.trim(), memoryKey }];
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';

    //audit Assumption: natural-language memory rows persist a human-readable `text` field; failure risk: exact recall returns opaque JSON instead of the stored recap; expected invariant: text-based memory is rendered as one assistant message; handling strategy: prefer `text` and preserve metadata fields for callers that need provenance.
    if (text) {
      return [{
        role: 'assistant',
        content: text,
        memoryKey,
        savedAt: typeof record.savedAt === 'string' ? record.savedAt : undefined,
      }];
    }
  }

  return null;
}

async function loadLatestPersistedMemoryRow(sessionId: string): Promise<PersistedSessionRow | null> {
  try {
    const result = await query(
      `SELECT key, value
       FROM memory
       WHERE key ILIKE $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [`nl-memory:${sessionId}:%`]
    );

    const row = result.rows[0] as PersistedSessionRow | undefined;
    return row ?? null;
  } catch {
    //audit Assumption: fallback DB scans are best-effort only; failure risk: resolve route fails hard during storage outages; expected invariant: callers still receive a controlled "no sessions" path when persistence is unavailable; handling strategy: return null when the DB query cannot run.
    return null;
  }
}

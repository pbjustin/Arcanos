import { createHash } from 'crypto';

import { getCachedSessions } from './sessionMemoryService.js';
import { loadMemory, query } from "@core/db/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { cosineSimilarity } from "@shared/vectorUtils.js";
import { createEmbedding } from './openai/embeddings.js';
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';
import { getEnv } from "@platform/runtime/env.js";
import {
  buildExactNaturalLanguageMemorySelectorLabel,
  extractNaturalLanguageMemoryPointerKey,
  extractNaturalLanguageExactMemorySelector,
  extractNaturalLanguageStorageLabel,
  extractNaturalLanguageSessionId,
  normalizeNaturalLanguageSessionId,
  queryExactNaturalLanguageMemoryEntries,
  resolveNaturalLanguageSessionAlias
} from './naturalLanguageMemory.js';
import { searchNaturalLanguageConversationSessions } from './naturalLanguageConversationSessionStore.js';

const sessionResolverLogger = logger.child({ module: 'sessionResolver' });

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

interface SessionEmbeddingCacheEntry {
  fingerprint: string;
  embedding: number[];
  expiresAtMs: number;
}

const SESSION_EMBEDDING_TEXT_LIMIT = 4_000;
const SESSION_EMBEDDING_MESSAGE_LIMIT = 12;
const SESSION_EMBEDDING_CACHE_MAX_ENTRIES = 256;
const SESSION_EMBEDDING_CACHE_TTL_MS = 30 * 60_000;
const sessionEmbeddingCache = new Map<string, SessionEmbeddingCacheEntry>();

function buildSessionSemanticText(session: CachedSession): string {
  const recentMessages = Array.isArray(session.conversations_core)
    ? session.conversations_core
        .slice(-SESSION_EMBEDDING_MESSAGE_LIMIT)
        .map((message) => (typeof message?.content === 'string' ? message.content.trim() : ''))
        .filter(Boolean)
    : [];

  return [
    session.metadata?.summary,
    session.metadata?.topic,
    ...(session.metadata?.tags || []),
    ...recentMessages,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .slice(0, SESSION_EMBEDDING_TEXT_LIMIT);
}

function buildSessionSemanticFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pruneExpiredSessionEmbeddingCache(nowMs: number): void {
  for (const [sessionId, entry] of sessionEmbeddingCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      sessionEmbeddingCache.delete(sessionId);
    }
  }
}

function touchSessionEmbeddingCacheEntry(
  sessionId: string,
  entry: SessionEmbeddingCacheEntry,
  nowMs: number
): number[] {
  const refreshedEntry: SessionEmbeddingCacheEntry = {
    ...entry,
    expiresAtMs: nowMs + SESSION_EMBEDDING_CACHE_TTL_MS,
  };
  sessionEmbeddingCache.delete(sessionId);
  sessionEmbeddingCache.set(sessionId, refreshedEntry);
  return refreshedEntry.embedding;
}

function getCachedSessionEmbedding(sessionId: string, fingerprint: string, nowMs: number): number[] | null {
  pruneExpiredSessionEmbeddingCache(nowMs);

  const cachedEntry = sessionEmbeddingCache.get(sessionId);
  if (!cachedEntry) {
    return null;
  }

  if (cachedEntry.fingerprint !== fingerprint) {
    sessionEmbeddingCache.delete(sessionId);
    return null;
  }

  return touchSessionEmbeddingCacheEntry(sessionId, cachedEntry, nowMs);
}

function storeSessionEmbedding(sessionId: string, fingerprint: string, embedding: number[], nowMs: number): void {
  sessionEmbeddingCache.delete(sessionId);
  sessionEmbeddingCache.set(sessionId, {
    fingerprint,
    embedding,
    expiresAtMs: nowMs + SESSION_EMBEDDING_CACHE_TTL_MS,
  });

  while (sessionEmbeddingCache.size > SESSION_EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldestSessionId = sessionEmbeddingCache.keys().next().value;
    if (!oldestSessionId) {
      break;
    }
    sessionEmbeddingCache.delete(oldestSessionId);
  }
}

async function getOrCreateSessionEmbedding(
  session: CachedSession,
  adapter: NonNullable<ReturnType<typeof getOpenAIClientOrAdapter>['adapter']>
): Promise<number[]> {
  const semanticText = buildSessionSemanticText(session);
  if (!semanticText) {
    return [];
  }

  const fingerprint = buildSessionSemanticFingerprint(semanticText);
  const nowMs = Date.now();
  const cachedEmbedding = getCachedSessionEmbedding(session.sessionId, fingerprint, nowMs);
  if (cachedEmbedding) {
    return cachedEmbedding;
  }

  const embedding = await createEmbedding(semanticText, adapter);
  storeSessionEmbedding(session.sessionId, fingerprint, embedding, nowMs);
  return embedding;
}

/**
 * Resolve the most relevant session for a natural-language query.
 * Inputs/outputs: natural-language query -> resolved session id plus conversation core payload.
 * Edge cases: exact persisted memory sessions are preferred before semantic cache matching.
 */
export async function resolveSession(nlQuery: string): Promise<ResolveResult> {
  const sessions = getCachedSessions() as CachedSession[];
  const exactMemorySelector = extractNaturalLanguageExactMemorySelector(nlQuery);

  if (exactMemorySelector) {
    const exactSelectorSession = await resolveExactSelectorSession(exactMemorySelector);
    if (exactSelectorSession) {
      return exactSelectorSession;
    }

    //audit Assumption: exact record/tag selector misses must not degrade into semantic session matching; failure risk: `/memory/resolve` returns an unrelated active transcript for a missing record id; expected invariant: exact selector misses are explicit and null; handling strategy: return a deterministic synthetic selector label with null payload.
    return {
      sessionId: buildExactNaturalLanguageMemorySelectorLabel(exactMemorySelector),
      conversations_core: null,
    };
  }

  const explicitSessionId = await resolveExplicitSessionId(nlQuery);

  if (explicitSessionId) {
    const persistedSession = await resolvePersistedSession(explicitSessionId);
    //audit Assumption: explicit recall should prefer persisted recap rows over live transcript state; failure risk: `/memory/resolve` returns the active chat transcript instead of the saved show recap; expected invariant: exact session recalls surface the latest persisted recap when one exists; handling strategy: consult persisted memory before cache fallback.
    if (persistedSession) {
      return persistedSession;
    }

    const exactCachedMatch = findCachedSessionById(sessions, explicitSessionId);
    //audit Assumption: cached session state is still useful when no persisted recap exists yet; failure risk: operators lose active in-memory context for newly created sessions; expected invariant: exact cache fallback stays available only after persisted recap lookup misses; handling strategy: short-circuit on direct cached match after persisted lookup fails.
    if (exactCachedMatch) {
      return {
        sessionId: exactCachedMatch.sessionId,
        conversations_core: exactCachedMatch.conversations_core ?? null,
      };
    }

    //audit Assumption: explicit session-id recalls must not degrade into semantic matching when the exact session is absent; failure risk: `/memory/resolve` returns a neighboring or most-recent session and hides the miss; expected invariant: explicit session misses stay exact and inspectable; handling strategy: return the requested session id with null conversation payload.
    return {
      sessionId: explicitSessionId,
      conversations_core: null,
    };
  }

  const storedConversationSession = await resolveStoredConversationSessionByQuery(nlQuery);
  //audit Assumption: durable conversation sessions should be reusable across code paths even when no in-process cache session exists yet; failure risk: saved conversation logs are invisible outside the nl-memory route; expected invariant: a natural-language session query can resolve to the canonical stored conversation payload before semantic cache matching; handling strategy: consult the durable conversation session search before cache-empty failure and semantic fallback.
  if (storedConversationSession) {
    return storedConversationSession;
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
      const metaVector = await getOrCreateSessionEmbedding(sess, adapter);
      if (metaVector.length === 0) {
        continue;
      }

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

async function resolveExactSelectorSession(
  selector: Parameters<typeof queryExactNaturalLanguageMemoryEntries>[0]
): Promise<ResolveResult | null> {
  const entries = await queryExactNaturalLanguageMemoryEntries(selector, 1);
  const firstEntry = entries[0];
  if (!firstEntry) {
    return null;
  }

  const conversationCore = toPersistedConversationCore(firstEntry.value, firstEntry.key);
  if (!conversationCore) {
    return null;
  }

  return {
    sessionId: extractPersistedSessionId(firstEntry.value) ?? buildExactNaturalLanguageMemorySelectorLabel(selector),
    conversations_core: conversationCore,
  };
}

async function resolveExplicitSessionId(nlQuery: string): Promise<string | null> {
  const explicitSessionId = extractNaturalLanguageSessionId(nlQuery);
  const explicitStorageLabel = extractNaturalLanguageStorageLabel(nlQuery);

  for (const aliasCandidate of [explicitStorageLabel, explicitSessionId]) {
    if (!aliasCandidate) {
      continue;
    }

    //audit Assumption: callers may recall sessions by storage label instead of canonical session id; failure risk: resolver reports a false exact miss even though an alias pointer exists; expected invariant: registered storage labels resolve to the same canonical session as the original save; handling strategy: consult the alias pointer before returning the extracted token.
    const aliasedSessionId = await resolveNaturalLanguageSessionAlias(aliasCandidate);
    if (aliasedSessionId) {
      return aliasedSessionId;
    }
  }

  //audit Assumption: explicit storage-label lookups must remain exact even when no alias pointer exists yet; failure risk: resolver falls through to semantic matching for a caller-specified session label; expected invariant: unresolved labels still map to a deterministic synthetic session token; handling strategy: normalize the explicit label before returning a miss.
  if (explicitSessionId) {
    return explicitSessionId;
  }

  if (explicitStorageLabel) {
    return normalizeNaturalLanguageSessionId(explicitStorageLabel);
  }

  return null;
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
  const latestPointerPayload = await safeLoadMemory(`nl-latest:${sessionId}`);
  const latestKey = extractNaturalLanguageMemoryPointerKey(latestPointerPayload);

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
  if (fallbackRow) {
    const fallbackConversationCore = toPersistedConversationCore(fallbackRow.value, fallbackRow.key);
    if (fallbackConversationCore) {
      return {
        sessionId,
        conversations_core: fallbackConversationCore,
      };
    }
  }

  const conversationPayload = await safeLoadMemory(`session:${sessionId}:conversations_core`);
  //audit Assumption: legacy session transcripts remain valuable only when no explicit saved recap row exists; failure risk: transcript payloads overshadow the recap rows users expect from recall; expected invariant: transcript fallback runs only after latest pointer and persisted row scans miss; handling strategy: defer conversation-core fallback to the end of persisted resolution.
  if (Array.isArray(conversationPayload)) {
    return {
      sessionId,
      conversations_core: conversationPayload as ConversationCore,
    };
  }

  return null;
}

async function resolveStoredConversationSessionByQuery(
  nlQuery: string
): Promise<ResolveResult | null> {
  try {
    const storedConversationSessions = await searchNaturalLanguageConversationSessions(nlQuery, 1);
    const firstSession = storedConversationSessions[0];
    if (!firstSession) {
      return null;
    }

    const conversationCore = toPersistedConversationCore(firstSession.payload, `session-record:${firstSession.id}`);
    if (!conversationCore) {
      return null;
    }

    return {
      sessionId: firstSession.id,
      conversations_core: conversationCore,
    };
  } catch (error: unknown) {
    //audit Assumption: durable conversation-session lookup is a reusable enhancement, not the only session-resolution path; failure risk: storage search outages prevent cache-backed or explicit-session resolution; expected invariant: resolver can continue through legacy paths when durable conversation search fails; handling strategy: warn with structured context and fail open with a null result.
    sessionResolverLogger.warn('Durable conversation session search failed during session resolution', {
      operation: 'resolveStoredConversationSessionByQuery',
      error: String((error as Error)?.message ?? error)
    });
    return null;
  }
}

async function safeLoadMemory(key: string): Promise<unknown | null> {
  try {
    return await loadMemory(key);
  } catch {
    //audit Assumption: persisted memory is optional during degraded DB conditions; failure risk: exact session resolution throws instead of degrading; expected invariant: resolver can continue to other fallbacks; handling strategy: swallow storage exceptions at this boundary and return null.
    return null;
  }
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

function extractPersistedSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const rawSessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof rawSessionId === 'string' && rawSessionId.trim()
    ? rawSessionId.trim()
    : null;
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

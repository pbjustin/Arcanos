import memoryStore from "@core/memory/store.js";
import { getCachedSessions } from './sessionMemoryService.js';

const DEFAULT_SESSION_LIST_LIMIT = 50;
const MAX_SESSION_LIST_LIMIT = 200;
const SESSION_PREVIEW_LIMIT = 160;

interface SessionCatalogOptions {
  limit?: number;
  search?: string | null;
}

export interface SessionCatalogEntry {
  sessionId: string;
  updatedAt: string;
  messageCount: number;
  replayable: boolean;
  topic: string | null;
  summary: string | null;
  tags: string[];
  latestRole: string | null;
  latestContentPreview: string | null;
}

export interface SessionConversationTurn {
  index: number;
  role: string;
  content: string;
  timestamp: number | string | null;
  meta: Record<string, unknown>;
}

export interface SessionDetail extends SessionCatalogEntry {
  versionId: string | null;
  monotonicTimestampMs: number | null;
  droppedMessageCount: number;
  metadata: Record<string, unknown>;
  conversation: SessionConversationTurn[];
}

interface SessionMetadataRecord extends Record<string, unknown> {
  topic?: unknown;
  summary?: unknown;
  tags?: unknown;
}

interface SessionEntryRecord extends Record<string, unknown> {
  sessionId?: unknown;
  updatedAt?: unknown;
  metadata?: unknown;
  conversations_core?: unknown;
  versionId?: unknown;
  monotonicTimestampMs?: unknown;
}

interface ConversationMessageRecord extends Record<string, unknown> {
  role?: unknown;
  content?: unknown;
  value?: unknown;
  text?: unknown;
  timestamp?: unknown;
  meta?: unknown;
}

/**
 * List normalized user sessions from the hydrated session cache.
 * Inputs/outputs: optional list filters -> descending session catalog entries.
 * Edge cases: initializes memory-store hydration on demand and drops malformed messages from previews/counts.
 */
export async function listUserSessions(options: SessionCatalogOptions = {}): Promise<SessionCatalogEntry[]> {
  await memoryStore.initialize();

  const normalizedLimit = resolveSessionListLimit(options.limit);
  const normalizedSearch = normalizeSessionSearch(options.search);
  const normalizedEntries = getCachedSessions()
    .map(toSessionCatalogEntry)
    .filter((entry): entry is SessionCatalogEntry => entry !== null)
    .filter(entry => matchesSessionSearch(entry, normalizedSearch))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  return normalizedEntries.slice(0, normalizedLimit);
}

/**
 * Retrieve one normalized user session with transcript details from the hydrated session cache.
 * Inputs/outputs: session id -> session detail payload or null when missing.
 * Edge cases: invalid identifiers and malformed conversation rows return null or are dropped deterministically.
 */
export async function getUserSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  await memoryStore.initialize();

  const normalizedSessionId = normalizeSessionIdentifier(sessionId);
  //audit Assumption: session detail lookups require one stable identifier; failure risk: blank ids degrade into accidental broad reads; expected invariant: non-empty bounded session id lookup key; handling strategy: reject invalid ids with null.
  if (!normalizedSessionId) {
    return null;
  }

  const sessionRecord = findSessionRecordById(getCachedSessions(), normalizedSessionId);
  if (!sessionRecord) {
    return null;
  }

  const metadataRecord = asRecord<SessionMetadataRecord>(sessionRecord.metadata) ?? {};
  const normalizedConversation = toSessionConversationTurns(sessionRecord.conversations_core);
  const latestTurn = normalizedConversation.turns[normalizedConversation.turns.length - 1] ?? null;

  return {
    sessionId: typeof sessionRecord.sessionId === 'string' ? sessionRecord.sessionId.trim() : normalizedSessionId,
    updatedAt: toIsoTimestamp(sessionRecord.updatedAt),
    messageCount: normalizedConversation.turns.length,
    replayable: normalizedConversation.turns.length > 0,
    topic: resolveOptionalStringMetadata(metadataRecord.topic),
    summary: resolveOptionalStringMetadata(metadataRecord.summary),
    tags: resolveSessionTags(metadataRecord.tags),
    latestRole: latestTurn?.role ?? null,
    latestContentPreview: latestTurn ? trimPreview(latestTurn.content) : null,
    versionId: resolveOptionalStringMetadata(sessionRecord.versionId),
    monotonicTimestampMs:
      typeof sessionRecord.monotonicTimestampMs === 'number' && Number.isFinite(sessionRecord.monotonicTimestampMs)
        ? sessionRecord.monotonicTimestampMs
        : null,
    droppedMessageCount: normalizedConversation.droppedCount,
    metadata: metadataRecord,
    conversation: normalizedConversation.turns
  };
}

/**
 * Clamp and normalize a session-list limit.
 * Inputs/outputs: raw numeric limit -> bounded positive integer.
 * Edge cases: invalid or missing limits fall back to the default.
 */
function resolveSessionListLimit(limit: number | undefined): number {
  //audit Assumption: list callers may omit or overspecify limits; failure risk: excessive in-memory response sizes; expected invariant: bounded positive integer limit; handling strategy: default invalid values and clamp oversized requests.
  if (!Number.isInteger(limit) || typeof limit !== 'number' || limit <= 0) {
    return DEFAULT_SESSION_LIST_LIMIT;
  }

  return Math.min(limit, MAX_SESSION_LIST_LIMIT);
}

/**
 * Normalize optional search text used to filter session catalog entries.
 * Inputs/outputs: raw search string -> lowercase search token or null.
 * Edge cases: blank values disable filtering.
 */
function normalizeSessionSearch(search: string | null | undefined): string | null {
  if (typeof search !== 'string') {
    return null;
  }

  const normalized = search.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function asRecord<T extends Record<string, unknown>>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as T;
}

function normalizeSessionIdentifier(sessionId: string): string | null {
  if (typeof sessionId !== 'string') {
    return null;
  }

  const normalized = sessionId.trim();
  return normalized.length > 0 ? normalized.slice(0, 100) : null;
}

function resolveMessageText(messageRecord: ConversationMessageRecord): string | null {
  const candidates = [messageRecord.content, messageRecord.value, messageRecord.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function resolveMessageTimestamp(
  messageRecord: ConversationMessageRecord,
  meta: Record<string, unknown>
): number | string | null {
  const candidates = [messageRecord.timestamp, meta.timestamp];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function toReplayableMessages(conversationsCore: unknown): Array<{ role: string | null; content: string }> {
  if (!Array.isArray(conversationsCore)) {
    return [];
  }

  const replayableMessages: Array<{ role: string | null; content: string }> = [];

  for (const rawMessage of conversationsCore) {
    if (typeof rawMessage === 'string' && rawMessage.trim().length > 0) {
      replayableMessages.push({
        role: 'user',
        content: rawMessage.trim()
      });
      continue;
    }

    const messageRecord = asRecord<ConversationMessageRecord>(rawMessage);
    if (!messageRecord) {
      continue;
    }

    const content = resolveMessageText(messageRecord);
    //audit Assumption: catalog previews should only count replay-safe messages with visible text; failure risk: malformed cache rows inflate message counts or surface blank previews; expected invariant: each catalog message has non-empty text; handling strategy: skip malformed entries.
    if (!content) {
      continue;
    }

    replayableMessages.push({
      role:
        typeof messageRecord.role === 'string' && messageRecord.role.trim().length > 0
          ? messageRecord.role.trim()
          : null,
      content
    });
  }

  return replayableMessages;
}

function toSessionConversationTurns(
  conversationsCore: unknown
): { turns: SessionConversationTurn[]; droppedCount: number } {
  if (!Array.isArray(conversationsCore)) {
    return { turns: [], droppedCount: 0 };
  }

  const turns: SessionConversationTurn[] = [];
  let droppedCount = 0;

  for (let index = 0; index < conversationsCore.length; index += 1) {
    const rawMessage = conversationsCore[index];

    if (typeof rawMessage === 'string' && rawMessage.trim().length > 0) {
      turns.push({
        index,
        role: 'user',
        content: rawMessage.trim(),
        timestamp: null,
        meta: {}
      });
      continue;
    }

    const messageRecord = asRecord<ConversationMessageRecord>(rawMessage);
    if (!messageRecord) {
      droppedCount += 1;
      continue;
    }

    const content = resolveMessageText(messageRecord);
    //audit Assumption: session transcripts exposed through the API must contain visible text turns only; failure risk: clients receive malformed blank transcript items that cannot be replayed; expected invariant: every emitted turn has non-empty content; handling strategy: skip malformed rows and increment a dropped counter for auditability.
    if (!content) {
      droppedCount += 1;
      continue;
    }

    const meta = asRecord<Record<string, unknown>>(messageRecord.meta) ?? {};
    turns.push({
      index,
      role: resolveOptionalStringMetadata(messageRecord.role) ?? 'user',
      content,
      timestamp: resolveMessageTimestamp(messageRecord, meta),
      meta
    });
  }

  return { turns, droppedCount };
}

function trimPreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= SESSION_PREVIEW_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, SESSION_PREVIEW_LIMIT)}...`;
}

function toIsoTimestamp(updatedAt: unknown): string {
  if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
    return new Date(updatedAt).toISOString();
  }

  if (updatedAt instanceof Date && !Number.isNaN(updatedAt.getTime())) {
    return updatedAt.toISOString();
  }

  return new Date(0).toISOString();
}

function resolveOptionalStringMetadata(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveSessionTags(rawTags: unknown): string[] {
  if (!Array.isArray(rawTags)) {
    return [];
  }

  return rawTags
    .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    .map(tag => tag.trim());
}

function findSessionRecordById(sessions: unknown[], sessionId: string): SessionEntryRecord | null {
  const normalizedTarget = sessionId.toLowerCase();

  for (const session of sessions) {
    const sessionRecord = asRecord<SessionEntryRecord>(session);
    if (!sessionRecord || typeof sessionRecord.sessionId !== 'string') {
      continue;
    }

    //audit Assumption: session ids are opaque but should remain case-insensitively addressable across clients; failure risk: retrieval fails after clients normalize ids differently; expected invariant: lookup by id resolves the same cached session regardless of case; handling strategy: compare normalized ids only.
    if (sessionRecord.sessionId.trim().toLowerCase() === normalizedTarget) {
      return sessionRecord;
    }
  }

  return null;
}

/**
 * Normalize one cached session into a catalog entry.
 * Inputs/outputs: raw cached session entry -> catalog entry or null.
 * Edge cases: invalid session ids are discarded.
 */
function toSessionCatalogEntry(session: unknown): SessionCatalogEntry | null {
  const sessionRecord = asRecord<SessionEntryRecord>(session);
  if (!sessionRecord || typeof sessionRecord.sessionId !== 'string' || sessionRecord.sessionId.trim().length === 0) {
    return null;
  }

  const metadataRecord = asRecord<SessionMetadataRecord>(sessionRecord.metadata) ?? {};
  const replayableMessages = toReplayableMessages(sessionRecord.conversations_core);
  const latestMessage = replayableMessages[replayableMessages.length - 1] ?? null;

  return {
    sessionId: sessionRecord.sessionId.trim(),
    updatedAt: toIsoTimestamp(sessionRecord.updatedAt),
    messageCount: replayableMessages.length,
    replayable: replayableMessages.length > 0,
    topic: resolveOptionalStringMetadata(metadataRecord.topic),
    summary: resolveOptionalStringMetadata(metadataRecord.summary),
    tags: resolveSessionTags(metadataRecord.tags),
    latestRole: latestMessage?.role ?? null,
    latestContentPreview: latestMessage ? trimPreview(latestMessage.content) : null
  };
}

/**
 * Determine whether a catalog entry matches an optional session search token.
 * Inputs/outputs: normalized entry + normalized search -> boolean match flag.
 * Edge cases: null search always matches.
 */
function matchesSessionSearch(entry: SessionCatalogEntry, normalizedSearch: string | null): boolean {
  if (!normalizedSearch) {
    return true;
  }

  const searchHaystack = [
    entry.sessionId,
    entry.topic,
    entry.summary,
    entry.latestContentPreview,
    ...entry.tags
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(value => value.toLowerCase());

  //audit Assumption: session search is a lightweight substring filter, not semantic retrieval; failure risk: operators over-trust fuzzy precision; expected invariant: deterministic case-insensitive containment match; handling strategy: filter on a bounded set of explicit session fields only.
  return searchHaystack.some(value => value.includes(normalizedSearch));
}

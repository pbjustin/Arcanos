import {
  findSessionByMemoryKey,
  findSessions,
  writeSession,
  type StoredSession
} from './sessionStorage.js';

const TITLE_LINE_PATTERN = /(?:^|\n)\s*title\s*:\s*["'`]?([^\r\n"'`]+)["'`]?/i;
const TAGS_LINE_PATTERN = /(?:^|\n)\s*tags?\s*:\s*(.+)$/im;
const CONVERSATION_CAPTURE_CUE_PATTERN =
  /\b(?:current\s+conversation|conversation\s+log|full\s+transcript|natural\s+language\s+conversation|save\s+.*conversation)\b/i;
const MAX_TRANSCRIPT_SUMMARY_LENGTH = 10_000;
const MAX_FALLBACK_LABEL_LENGTH = 120;

export interface ParsedNaturalLanguageConversationSessionContent {
  title: string | null;
  tags: string[];
  transcriptSummary: string;
  isConversationCapture: boolean;
}

export interface PersistNaturalLanguageConversationSessionInput {
  sessionId: string;
  memoryKey: string;
  content: string;
  savedAt?: string;
  auditTraceId?: string | null;
}

export interface StoredNaturalLanguageConversationSession {
  id: string;
  label: string;
  tag: string | null;
  memoryType: string;
  payload: unknown;
  transcriptSummary: string | null;
  auditTraceId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConversationSessionPayloadRecord extends Record<string, unknown> {
  text?: unknown;
  tags?: unknown;
  memoryKey?: unknown;
  sessionId?: unknown;
  savedAt?: unknown;
  source?: unknown;
}

/**
 * Parse a natural-language conversation save payload into reusable session metadata.
 * Inputs/outputs: raw save content -> normalized title, tags, transcript summary, and capture flag.
 * Edge cases: unlabeled content remains searchable through a fallback summary and explicit conversation cues.
 */
export function parseNaturalLanguageConversationSessionContent(
  rawContent: string
): ParsedNaturalLanguageConversationSessionContent {
  const normalizedContent = normalizeConversationContent(rawContent);
  const normalizedTitle = normalizeOptionalLineCapture(rawContent.match(TITLE_LINE_PATTERN)?.[1] ?? null);
  const normalizedTags = normalizeConversationTags(rawContent.match(TAGS_LINE_PATTERN)?.[1] ?? null);
  const isConversationCapture =
    normalizedTitle !== null ||
    normalizedTags.length > 0 ||
    CONVERSATION_CAPTURE_CUE_PATTERN.test(rawContent);

  return {
    title: normalizedTitle,
    tags: normalizedTags,
    transcriptSummary: normalizedContent.slice(0, MAX_TRANSCRIPT_SUMMARY_LENGTH),
    isConversationCapture
  };
}

/**
 * Persist one natural-language conversation save into the canonical durable session store.
 * Inputs/outputs: canonical session id, memory key, and saved content -> stored conversation session or null when content is not a conversation capture.
 * Edge cases: retries reuse an existing durable session keyed by the persisted memory key instead of creating duplicates.
 */
export async function persistNaturalLanguageConversationSession(
  input: PersistNaturalLanguageConversationSessionInput
): Promise<StoredNaturalLanguageConversationSession | null> {
  const parsedContent = parseNaturalLanguageConversationSessionContent(input.content);

  //audit Assumption: only explicit conversation captures should fan out into the durable session catalog; failure risk: ordinary note saves pollute reusable conversation search results; expected invariant: durable conversation sessions come from labeled or clearly conversation-oriented saves only; handling strategy: return null when capture cues are absent.
  if (!parsedContent.isConversationCapture) {
    return null;
  }

  const existingSession = await findStoredConversationSessionByMemoryKey(input.memoryKey);
  //audit Assumption: the persisted nl-memory key is a stable idempotency handle for durable conversation sessions; failure risk: repeated saves create duplicate session rows for the same conversation payload; expected invariant: one durable conversation session per memory key; handling strategy: return the existing row when the payload already references the same memory key.
  if (existingSession) {
    return existingSession;
  }

  const createdSession = await writeSession({
    label: parsedContent.title ?? buildFallbackConversationLabel(input.content, input.sessionId),
    tag: parsedContent.tags[0] ?? null,
    memoryType: 'conversation',
    payload: {
      sessionId: input.sessionId,
      memoryKey: input.memoryKey,
      savedAt: input.savedAt ?? new Date().toISOString(),
      source: 'natural-language-memory',
      text: normalizeConversationContent(input.content),
      tags: parsedContent.tags
    },
    transcriptSummary: parsedContent.transcriptSummary,
    auditTraceId: input.auditTraceId ?? null
  });

  return normalizeStoredConversationSession(createdSession);
}

/**
 * Search durable conversation sessions using canonical session storage search semantics.
 * Inputs/outputs: natural-language search text plus result limit -> normalized durable conversation sessions.
 * Edge cases: blank queries return an empty list and non-conversation session rows are excluded deterministically.
 */
export async function searchNaturalLanguageConversationSessions(
  rawSearchText: string,
  limit: number
): Promise<StoredNaturalLanguageConversationSession[]> {
  const normalizedSearchText = normalizeConversationContent(rawSearchText);
  const normalizedLimit = resolveConversationSearchLimit(limit);

  //audit Assumption: empty conversation searches should not broad-scan the session catalog; failure risk: expensive unfiltered reads and noisy "latest" results; expected invariant: reusable session search requires explicit text; handling strategy: short-circuit with an empty list.
  if (!normalizedSearchText) {
    return [];
  }

  const detailedSessions = await findSessions({
    search: normalizedSearchText,
    limit: normalizedLimit,
    memoryType: 'conversation'
  });

  //audit Assumption: reusable natural-language conversation search should surface only durable conversation sessions, not diagnostics or unrelated canonical session rows; failure risk: callers receive structurally valid but semantically irrelevant sessions; expected invariant: repository filtering already limits rows to `memoryType=conversation`; handling strategy: normalize only rows that preserve the exact conversation memory type.
  return detailedSessions
    .filter((session) => session.memoryType === 'conversation')
    .map(normalizeStoredConversationSession)
    .slice(0, normalizedLimit);
}

function normalizeStoredConversationSession(
  session: StoredSession
): StoredNaturalLanguageConversationSession {
  return {
    id: session.id,
    label: session.label,
    tag: session.tag,
    memoryType: session.memoryType,
    payload: session.payload,
    transcriptSummary: session.transcriptSummary,
    auditTraceId: session.auditTraceId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}

async function findStoredConversationSessionByMemoryKey(
  memoryKey: string
): Promise<StoredNaturalLanguageConversationSession | null> {
  const existingSession = await findSessionByMemoryKey(memoryKey, 'conversation');
  if (!existingSession) {
    return null;
  }

  const payloadRecord = asConversationSessionPayloadRecord(existingSession.payload);
  //audit Assumption: durable conversation payloads preserve their originating nl-memory key for cross-store lookup; failure risk: legacy rows with malformed payloads are treated as valid idempotent matches; expected invariant: an exact payload memory-key lookup still points at a conversation payload that exposes the same memory key; handling strategy: verify the payload field before accepting the stored row as a dedupe hit.
  if (typeof payloadRecord?.memoryKey !== 'string' || payloadRecord.memoryKey.trim() !== memoryKey) {
    return null;
  }

  return normalizeStoredConversationSession(existingSession);
}

function resolveConversationSearchLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    return 10;
  }

  return Math.min(limit, 25);
}

function normalizeConversationContent(rawContent: string): string {
  return rawContent.replace(/\r\n/g, '\n').trim();
}

function normalizeOptionalLineCapture(rawValue: string | null): string | null {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const normalized = rawValue.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeConversationTags(rawValue: string | null): string[] {
  if (typeof rawValue !== 'string') {
    return [];
  }

  const trimmedValue = rawValue.trim();
  const bracketMatch = trimmedValue.match(/^\[(.*)\]$/);
  const tagSource = bracketMatch?.[1] ?? trimmedValue;

  return tagSource
    .split(',')
    .map(tag => tag.replace(/^["'`\s]+|["'`\s]+$/g, '').trim())
    .filter((tag, index, tags): tag is string => tag.length > 0 && tags.indexOf(tag) === index)
    .slice(0, 20);
}

function buildFallbackConversationLabel(content: string, sessionId: string): string {
  const firstSentence = normalizeConversationContent(content)
    .replace(/\s+/g, ' ')
    .split(/[.!?]/, 1)[0]
    .trim();
  const normalizedLabel = firstSentence || `Conversation ${sessionId}`;
  return normalizedLabel.slice(0, MAX_FALLBACK_LABEL_LENGTH);
}

function asConversationSessionPayloadRecord(
  payload: unknown
): ConversationSessionPayloadRecord | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  return payload as ConversationSessionPayloadRecord;
}

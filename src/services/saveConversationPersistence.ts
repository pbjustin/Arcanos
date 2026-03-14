import { loadMemoryRecordById, saveMemory, type StoredMemoryRecord } from '@core/db/index.js';
import { safeJSONStringify } from '@shared/jsonHelpers.js';

export type ConversationContentMode = 'transcript' | 'summary';

const SAVE_CONVERSATION_KEY_PREFIX = 'save-conversation';
const DEFAULT_STORAGE_TYPE = 'conversation';

interface StoredConversationPayload {
  schemaVersion: 1;
  storageType: string;
  title: string;
  tags: string[];
  contentMode: ConversationContentMode;
  content: unknown;
  sessionId: string | null;
  metadata: Record<string, unknown> | null;
  storedAt: string;
}

export interface SaveConversationRequest {
  title: string;
  tags?: string[];
  storageType?: string;
  contentMode: ConversationContentMode;
  content: unknown;
  sessionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SaveConversationReceipt {
  success: true;
  record_id: number;
  storage_type: string;
  title: string;
  tags: string[];
  content_mode: ConversationContentMode;
  length_stored: number;
  bytes_stored: number;
  created_at: string;
  error: null;
}

export interface SaveConversationRecord extends SaveConversationReceipt {
  key: string;
  session_id: string | null;
  updated_at: string;
  content: unknown;
  metadata: Record<string, unknown> | null;
}

interface ContentMetrics {
  bytesStored: number;
  lengthStored: number;
  serializedContent: string;
}

/**
 * Persist one structured conversation payload into the durable memory table and verify the row immediately.
 * Inputs/outputs: normalized structured save request -> strict receipt with confirmed row id.
 * Edge cases: throws when the DB write succeeds but the immediate readback is missing or mismatched.
 */
export async function persistConversationRecord(
  request: SaveConversationRequest
): Promise<SaveConversationReceipt> {
  const storedAt = new Date().toISOString();
  const normalizedPayload = buildStoredConversationPayload(request, storedAt);
  const contentMetrics = measureStoredContent(normalizedPayload.content);
  const memoryKey = buildSaveConversationMemoryKey(normalizedPayload, storedAt);
  const savedRow = await saveMemory(memoryKey, normalizedPayload);
  const savedRecordId = normalizeStoredRecordId(savedRow.id);

  //audit Assumption: a successful write must be followed by an exact readback before the API claims persistence; failure risk: callers receive a false-positive receipt after a partial write or stale cache path; expected invariant: returned record id resolves to the just-written row; handling strategy: read the row back immediately and fail closed on mismatch.
  const verifiedRecord = await loadConversationRecord(savedRecordId);
  if (!verifiedRecord) {
    throw new Error(`Conversation record ${savedRecordId} could not be reloaded after save.`);
  }

  const verifiedContentMetrics = measureStoredContent(verifiedRecord.content);
  //audit Assumption: post-write verification must compare the canonical stored content rather than only the presence of a row; failure risk: wrong row/key collisions pass verification; expected invariant: serialized stored content matches the just-written request; handling strategy: compare content bytes plus immutable routing fields and throw on mismatch.
  if (
    verifiedRecord.storage_type !== normalizedPayload.storageType ||
    verifiedRecord.title !== normalizedPayload.title ||
    verifiedRecord.content_mode !== normalizedPayload.contentMode ||
    verifiedContentMetrics.serializedContent !== contentMetrics.serializedContent
  ) {
    throw new Error(`Conversation record ${savedRecordId} did not match the requested payload after save.`);
  }

  const {
    key: _verifiedKey,
    session_id: _verifiedSessionId,
    updated_at: _verifiedUpdatedAt,
    content: _verifiedContent,
    metadata: _verifiedMetadata,
    ...receipt
  } = verifiedRecord;

  return receipt;
}

/**
 * Load one structured conversation record by memory-table id.
 * Inputs/outputs: positive record id -> normalized saved conversation record or null.
 * Edge cases: non-conversation memory rows return null instead of being misreported as conversation saves.
 */
export async function loadConversationRecord(recordId: number): Promise<SaveConversationRecord | null> {
  const storedMemoryRecord = await loadMemoryRecordById(recordId);
  if (!storedMemoryRecord) {
    return null;
  }

  const storedPayload = parseStoredConversationPayload(storedMemoryRecord);
  if (!storedPayload) {
    return null;
  }

  const contentMetrics = measureStoredContent(storedPayload.content);

  return {
    success: true,
    record_id: storedMemoryRecord.id,
    key: storedMemoryRecord.key,
    storage_type: storedPayload.storageType,
    title: storedPayload.title,
    tags: storedPayload.tags,
    content_mode: storedPayload.contentMode,
    length_stored: contentMetrics.lengthStored,
    bytes_stored: contentMetrics.bytesStored,
    created_at: storedMemoryRecord.created_at,
    updated_at: storedMemoryRecord.updated_at,
    session_id: storedPayload.sessionId,
    content: storedPayload.content,
    metadata: storedPayload.metadata,
    error: null
  };
}

/**
 * Build the deterministic memory-table key for structured conversation saves.
 * Inputs/outputs: normalized payload + ISO timestamp -> unique memory key string.
 * Edge cases: blank session ids and non-alphanumeric titles collapse to safe fallback segments.
 */
export function buildSaveConversationMemoryKey(
  payload: Pick<StoredConversationPayload, 'sessionId' | 'title'>,
  storedAtIso: string
): string {
  const sessionSegment = normalizeKeySegment(payload.sessionId, 'global');
  const titleSegment = normalizeKeySegment(payload.title, 'conversation');
  const timestampSegment = storedAtIso.replace(/[-:.TZ]/g, '');
  return `${SAVE_CONVERSATION_KEY_PREFIX}:${sessionSegment}:${titleSegment}:${timestampSegment}`;
}

/**
 * Convert raw request data into the stable stored conversation payload shape.
 * Inputs/outputs: structured request + ISO timestamp -> normalized stored payload.
 * Edge cases: missing storageType falls back to `conversation`; blank session ids become null.
 */
function buildStoredConversationPayload(
  request: SaveConversationRequest,
  storedAt: string
): StoredConversationPayload {
  return {
    schemaVersion: 1,
    storageType: normalizeStorageType(request.storageType),
    title: request.title.trim(),
    tags: normalizeConversationTags(request.tags),
    contentMode: request.contentMode,
    content: request.content,
    sessionId: normalizeOptionalSessionId(request.sessionId),
    metadata: normalizeMetadata(request.metadata),
    storedAt
  };
}

function normalizeOptionalSessionId(rawSessionId: string | null | undefined): string | null {
  if (typeof rawSessionId !== 'string') {
    return null;
  }

  const normalizedSessionId = rawSessionId.trim();
  return normalizedSessionId.length > 0 ? normalizedSessionId.slice(0, 100) : null;
}

function normalizeMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  return { ...metadata };
}

function normalizeStorageType(rawStorageType: string | undefined): string {
  if (typeof rawStorageType !== 'string' || rawStorageType.trim().length === 0) {
    return DEFAULT_STORAGE_TYPE;
  }

  return rawStorageType.trim().slice(0, 100);
}

function normalizeConversationTags(rawTags: string[] | undefined): string[] {
  if (!Array.isArray(rawTags) || rawTags.length === 0) {
    return [];
  }

  const normalizedTags = rawTags
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim())
    .filter(tag => tag.length > 0)
    .map(tag => tag.slice(0, 100));

  return Array.from(new Set(normalizedTags)).slice(0, 25);
}

function normalizeKeySegment(rawValue: string | null | undefined, fallbackSegment: string): string {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return fallbackSegment;
  }

  const normalizedValue = rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return normalizedValue.length > 0 ? normalizedValue.slice(0, 60) : fallbackSegment;
}

function normalizeStoredRecordId(rawRecordId: unknown): number {
  const parsedRecordId =
    typeof rawRecordId === 'number'
      ? rawRecordId
      : Number.parseInt(String(rawRecordId), 10);

  //audit Assumption: saveMemory must return the persisted row id for read-after-write verification; failure risk: the API cannot prove which row was created; expected invariant: a positive integer record id is returned from PostgreSQL; handling strategy: reject any missing or non-integer id immediately.
  if (!Number.isInteger(parsedRecordId) || parsedRecordId < 1) {
    throw new Error(`saveMemory returned an invalid record id: ${String(rawRecordId)}`);
  }

  return parsedRecordId;
}

function parseStoredConversationPayload(
  storedMemoryRecord: StoredMemoryRecord
): StoredConversationPayload | null {
  const rawValue = storedMemoryRecord.value;
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return null;
  }

  const payloadRecord = rawValue as Record<string, unknown>;
  if (
    payloadRecord.schemaVersion !== 1 ||
    typeof payloadRecord.storageType !== 'string' ||
    typeof payloadRecord.title !== 'string' ||
    !Array.isArray(payloadRecord.tags) ||
    (payloadRecord.contentMode !== 'transcript' && payloadRecord.contentMode !== 'summary') ||
    typeof payloadRecord.storedAt !== 'string'
  ) {
    return null;
  }

  const normalizedTags = payloadRecord.tags.filter(
    (tag): tag is string => typeof tag === 'string' && tag.trim().length > 0
  );
  const metadata =
    payloadRecord.metadata && typeof payloadRecord.metadata === 'object' && !Array.isArray(payloadRecord.metadata)
      ? { ...(payloadRecord.metadata as Record<string, unknown>) }
      : null;

  return {
    schemaVersion: 1,
    storageType: payloadRecord.storageType,
    title: payloadRecord.title,
    tags: normalizedTags,
    contentMode: payloadRecord.contentMode,
    content: payloadRecord.content,
    sessionId: typeof payloadRecord.sessionId === 'string' && payloadRecord.sessionId.trim().length > 0
      ? payloadRecord.sessionId
      : null,
    metadata,
    storedAt: payloadRecord.storedAt
  };
}

function measureStoredContent(content: unknown): ContentMetrics {
  const serializedContent =
    typeof content === 'string'
      ? content
      : safeJSONStringify(content, 'saveConversationPersistence.measureStoredContent') ?? '';

  return {
    serializedContent,
    lengthStored: serializedContent.length,
    bytesStored: Buffer.byteLength(serializedContent, 'utf8')
  };
}

import { createHash, randomUUID } from 'crypto';
import { getDefaultModel, hasValidAPIKey } from './openai.js';
import { createEmbedding } from './openai/embeddings.js';
import { fetchAndClean } from "@shared/webFetcher.js";
import { cosineSimilarity } from "@shared/vectorUtils.js";
import {
  saveRagDoc,
  loadAllRagDocs,
  loadRagDocById,
  initializeDatabaseWithSchema as initializeDatabase,
  getStatus
} from "@core/db/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { requireOpenAIClientOrAdapter } from './openai/clientBridge.js';

interface Doc {
  id: string;
  url: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  parentId: string;
  chunkCount: number;
  source: string;
  contentLength: number;
  metadata: Record<string, unknown>;
}

export interface RagQueryOptions {
  limit?: number;
  minScore?: number;
  sessionId?: string | null;
  sourceTypes?: string[];
  allowSessionFallback?: boolean;
}

export interface RagQueryMatch {
  id: string;
  url: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RagQueryDiagnostics {
  enabled: boolean;
  reason: string;
  candidateCount: number;
  returnedCount: number;
  sessionFilterApplied: boolean;
  sessionFallbackApplied: boolean;
  sourceTypeFilterApplied: boolean;
  minScore: number;
  limit: number;
}

export interface RagQueryResult {
  matches: RagQueryMatch[];
  diagnostics: RagQueryDiagnostics;
}

let vectorStore: Doc[] | null = null;
const ragLogger = logger.child({ module: 'webRag' });
const DEFAULT_RETRIEVAL_LIMIT = 5;
const MAX_RETRIEVAL_LIMIT = 25;
const DEFAULT_MIN_SIMILARITY = 0.18;
const DEFAULT_ANSWER_MIN_SIMILARITY = 0.12;
const MAX_QUERY_LENGTH = 4_000;
const CONTENT_PREVIEW_LIMIT = 900;

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildConversationSnippetParentId(options: ConversationSnippetOptions, trimmedContent: string): string {
  const messageId =
    typeof options.metadata?.messageId === 'string' && options.metadata.messageId.trim().length > 0
      ? options.metadata.messageId.trim()
      : null;
  const timestampPart =
    typeof options.timestamp === 'number' && Number.isFinite(options.timestamp)
      ? Math.trunc(options.timestamp)
      : 0;
  const contentHash = hashText(trimmedContent).slice(0, 16);

  if (messageId) {
    return `conversation:${options.sessionId}:${options.channel ?? 'conversations_core'}:${messageId}:${contentHash}`;
  }

  return `conversation:${options.sessionId}:${options.channel ?? 'conversations_core'}:${timestampPart}:${contentHash}`;
}

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
  if (!metadata) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return {};

  try {
    // Prefer structuredClone when available (preserves more types safely)
    if (typeof structuredClone === 'function') {
      const cloned = structuredClone(metadata);
      return (cloned && typeof cloned === 'object' && !Array.isArray(cloned))
        ? (cloned as Record<string, unknown>)
        : {};
    }

    // Fallback: JSON round-trip (best-effort)
    return JSON.parse(JSON.stringify(metadata));
  } catch {
    return {};
  }
}

/**
 * Normalize retrieval limit to bounded integer range.
 * Inputs/outputs: untrusted limit -> safe bounded limit.
 * Edge cases: invalid values fall back to default.
 */
function resolveRetrievalLimit(rawLimit: unknown): number {
  const parsedLimit = Number.parseInt(rawLimit === undefined ? '' : String(rawLimit), 10);

  //audit Assumption: callers may pass invalid limits from external inputs; failure risk: oversized retrieval scans; expected invariant: retrieval limit stays within hard bounds; handling strategy: default + clamp.
  if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
    return DEFAULT_RETRIEVAL_LIMIT;
  }

  return Math.min(parsedLimit, MAX_RETRIEVAL_LIMIT);
}

/**
 * Normalize similarity threshold.
 * Inputs/outputs: raw threshold -> safe numeric threshold.
 * Edge cases: invalid threshold falls back to default.
 */
function resolveMinSimilarity(rawThreshold: unknown, fallback = DEFAULT_MIN_SIMILARITY): number {
  const parsedThreshold = Number.parseFloat(rawThreshold === undefined ? '' : String(rawThreshold));
  if (!Number.isFinite(parsedThreshold)) {
    return fallback;
  }

  //audit Assumption: cosine similarity thresholds should stay in [-1, 1]; failure risk: impossible filtering behavior; expected invariant: bounded threshold range; handling strategy: clamp to valid interval.
  return Math.max(-1, Math.min(1, parsedThreshold));
}

/**
 * Normalize optional session filter used for scoped retrieval.
 * Inputs/outputs: optional raw session ID -> normalized lowercase token or null.
 * Edge cases: empty/invalid values disable session filtering.
 */
function normalizeSessionFilter(sessionId: unknown): string | null {
  if (typeof sessionId !== 'string') {
    return null;
  }

  const normalized = sessionId.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 120);
}

/**
 * Normalize source type filters.
 * Inputs/outputs: optional source type list -> normalized unique lowercase values.
 * Edge cases: empty/invalid entries are ignored.
 */
function normalizeSourceTypeFilters(sourceTypes: unknown): string[] {
  if (!Array.isArray(sourceTypes)) {
    return [];
  }

  const normalized = sourceTypes
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return Array.from(new Set(normalized)).slice(0, 16);
}

/**
 * Build a best-effort diagnostics envelope for RAG retrieval calls.
 * Inputs/outputs: partial diagnostics inputs -> normalized diagnostics object.
 * Edge cases: omitted values resolve to safe defaults.
 */
function buildRagDiagnostics(
  partial: Partial<RagQueryDiagnostics> & Pick<RagQueryDiagnostics, 'reason' | 'enabled'>
): RagQueryDiagnostics {
  return {
    enabled: partial.enabled,
    reason: partial.reason,
    candidateCount: partial.candidateCount ?? 0,
    returnedCount: partial.returnedCount ?? 0,
    sessionFilterApplied: partial.sessionFilterApplied ?? false,
    sessionFallbackApplied: partial.sessionFallbackApplied ?? false,
    sourceTypeFilterApplied: partial.sourceTypeFilterApplied ?? false,
    minScore: partial.minScore ?? DEFAULT_MIN_SIMILARITY,
    limit: partial.limit ?? DEFAULT_RETRIEVAL_LIMIT
  };
}

/**
 * Check whether a document should be included for a normalized session filter.
 * Inputs/outputs: RAG document + optional session token -> inclusion boolean.
 * Edge cases: missing metadata session still allowed when URL namespace matches.
 */
function matchesSessionFilter(doc: Doc, normalizedSessionId: string | null): boolean {
  if (!normalizedSessionId) {
    return true;
  }

  const metadataSessionId =
    typeof doc.metadata?.sessionId === 'string' ? doc.metadata.sessionId.trim().toLowerCase() : '';
  if (metadataSessionId === normalizedSessionId) {
    return true;
  }

  const normalizedUrl = doc.url.trim().toLowerCase();
  if (normalizedUrl === `session:${normalizedSessionId}`) {
    return true;
  }

  return normalizedUrl === `memory:${normalizedSessionId}`;
}

/**
 * Check whether a document's sourceType metadata is in the allow-list.
 * Inputs/outputs: RAG document + sourceType allow-list -> inclusion boolean.
 * Edge cases: empty allow-list permits all documents.
 */
function matchesSourceTypeFilter(doc: Doc, sourceTypeFilters: string[]): boolean {
  if (sourceTypeFilters.length === 0) {
    return true;
  }

  const sourceType =
    typeof doc.metadata?.sourceType === 'string' ? doc.metadata.sourceType.trim().toLowerCase() : '';
  return sourceTypeFilters.includes(sourceType);
}

/**
 * Compute cosine similarity defensively.
 * Inputs/outputs: query embedding + document embedding -> similarity score.
 * Edge cases: shape mismatch or invalid vectors return -1 and continue retrieval.
 */
function computeSimilaritySafely(queryEmbedding: number[], docEmbedding: number[], docId: string): number {
  try {
    return cosineSimilarity(queryEmbedding, docEmbedding);
  } catch (error: unknown) {
    //audit Assumption: malformed embeddings should not abort entire retrieval; failure risk: full query failure due one bad row; expected invariant: retrieval skips invalid docs and returns remaining matches; handling strategy: debug-log and return sentinel score.
    ragLogger.debug('Skipping RAG doc with incompatible embedding vector', {
      operation: 'queryRagDocuments',
      docId,
      error: error instanceof Error ? error.message : String(error)
    });
    return -1;
  }
}

/**
 * Build compact content preview for API responses.
 * Inputs/outputs: full content text -> bounded preview string.
 * Edge cases: short content passes through unchanged.
 */
function toContentPreview(content: string): string {
  if (content.length <= CONTENT_PREVIEW_LIMIT) {
    return content;
  }

  return `${content.slice(0, CONTENT_PREVIEW_LIMIT)}...`;
}


export function chunkText(text: string, chunkSize = 8_000, overlap = 400): string[] {
  const normalizedText = typeof text === 'string' ? text : '';
  if (!normalizedText) {
    return [];
  }

  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const safeOverlap = Math.max(0, Math.min(Math.floor(overlap), safeChunkSize - 1));
  const chunks: string[] = [];
  let i = 0;

  while (i < normalizedText.length) {
    const end = Math.min(i + safeChunkSize, normalizedText.length);
    chunks.push(normalizedText.slice(i, end));
    if (end === normalizedText.length) {
      break;
    }
    i = Math.max(0, end - safeOverlap);
  }

  return chunks;
}

export interface SourceDetail {
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

/**
 * Query RAG documents by semantic similarity with optional session/source filters.
 * Inputs/outputs: natural-language query + retrieval options -> scored semantic matches and diagnostics.
 * Edge cases: when OpenAI/embeddings are unavailable, returns empty matches with explicit diagnostics.
 */
export async function queryRagDocuments(question: string, options: RagQueryOptions = {}): Promise<RagQueryResult> {
  const trimmedQuestion = typeof question === 'string' ? question.trim() : '';
  const queryText = trimmedQuestion.slice(0, MAX_QUERY_LENGTH);
  const limit = resolveRetrievalLimit(options.limit);
  const minScore = resolveMinSimilarity(options.minScore);
  const normalizedSessionId = normalizeSessionFilter(options.sessionId);
  const sourceTypeFilters = normalizeSourceTypeFilters(options.sourceTypes);
  const allowSessionFallback = options.allowSessionFallback !== false;
  const sourceTypeFilterApplied = sourceTypeFilters.length > 0;

  //audit Assumption: empty semantic queries are non-actionable; failure risk: unnecessary embedding calls; expected invariant: retrieval requires non-empty query text; handling strategy: return empty diagnostics quickly.
  if (!queryText) {
    return {
      matches: [],
      diagnostics: buildRagDiagnostics({
        enabled: false,
        reason: 'empty_query',
        limit,
        minScore,
        sourceTypeFilterApplied
      })
    };
  }

  await ensureStore();
  const docs = vectorStore || [];
  const sourceTypeScopedDocs = docs.filter((doc) => matchesSourceTypeFilter(doc, sourceTypeFilters));
  const sessionScopedDocs = normalizedSessionId
    ? sourceTypeScopedDocs.filter((doc) => matchesSessionFilter(doc, normalizedSessionId))
    : sourceTypeScopedDocs;

  let candidateDocs = sessionScopedDocs;
  let sessionFallbackApplied = false;

  //audit Assumption: strict session filtering may be too narrow for some persisted data; failure risk: false "no memory found" responses; expected invariant: retrieval remains useful even with sparse session tags; handling strategy: fallback to source-filtered corpus when session slice is empty.
  if (allowSessionFallback && normalizedSessionId && candidateDocs.length === 0) {
    candidateDocs = sourceTypeScopedDocs;
    sessionFallbackApplied = true;
  }

  if (candidateDocs.length === 0) {
    return {
      matches: [],
      diagnostics: buildRagDiagnostics({
        enabled: true,
        reason: 'no_candidate_docs',
        candidateCount: 0,
        returnedCount: 0,
        sessionFilterApplied: Boolean(normalizedSessionId),
        sessionFallbackApplied,
        sourceTypeFilterApplied,
        minScore,
        limit
      })
    };
  }

  //audit Assumption: embeddings require API credentials; failure risk: hard runtime errors in offline/local mode; expected invariant: retrieval degrades gracefully without key; handling strategy: return diagnostics and zero matches.
  if (!hasValidAPIKey()) {
    return {
      matches: [],
      diagnostics: buildRagDiagnostics({
        enabled: false,
        reason: 'api_key_missing',
        candidateCount: candidateDocs.length,
        returnedCount: 0,
        sessionFilterApplied: Boolean(normalizedSessionId),
        sessionFallbackApplied,
        sourceTypeFilterApplied,
        minScore,
        limit
      })
    };
  }

  try {
    const { client } = requireOpenAIClientOrAdapter('OpenAI adapter not initialized');
    const queryEmbedding = await createEmbedding(queryText, client);

    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return {
        matches: [],
        diagnostics: buildRagDiagnostics({
          enabled: false,
          reason: 'embedding_unavailable',
          candidateCount: candidateDocs.length,
          returnedCount: 0,
          sessionFilterApplied: Boolean(normalizedSessionId),
          sessionFallbackApplied,
          sourceTypeFilterApplied,
          minScore,
          limit
        })
      };
    }

    const scored = candidateDocs
      .map((doc) => ({
        doc,
        score: computeSimilaritySafely(queryEmbedding, doc.embedding, doc.id)
      }))
      .filter((entry) => Number.isFinite(entry.score) && entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry): RagQueryMatch => ({
        id: entry.doc.id,
        url: entry.doc.url,
        content: toContentPreview(entry.doc.content),
        score: entry.score,
        metadata: entry.doc.metadata
      }));

    return {
      matches: scored,
      diagnostics: buildRagDiagnostics({
        enabled: true,
        reason: 'ok',
        candidateCount: candidateDocs.length,
        returnedCount: scored.length,
        sessionFilterApplied: Boolean(normalizedSessionId),
        sessionFallbackApplied,
        sourceTypeFilterApplied,
        minScore,
        limit
      })
    };
  } catch (error: unknown) {
    ragLogger.warn('RAG semantic retrieval failed', {
      operation: 'queryRagDocuments',
      sessionId: normalizedSessionId ?? undefined,
      candidateCount: candidateDocs.length,
      sourceTypes: sourceTypeFilters
    }, undefined, error instanceof Error ? error : undefined);

    return {
      matches: [],
      diagnostics: buildRagDiagnostics({
        enabled: false,
        reason: 'retrieval_error',
        candidateCount: candidateDocs.length,
        returnedCount: 0,
        sessionFilterApplied: Boolean(normalizedSessionId),
        sessionFallbackApplied,
        sourceTypeFilterApplied,
        minScore,
        limit
      })
    };
  }
}

export async function ingestUrl(url: string): Promise<IngestResult> {
  const content = await fetchAndClean(url);
  return ingestContent({
    id: url,
    content,
    source: url,
    metadata: {
      sourceType: 'url',
      fetchedAt: new Date().toISOString(),
    },
  });
}

interface IngestContentOptions {
  id?: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export async function ingestContent(options: IngestContentOptions): Promise<IngestResult> {
  const { id, content, source, metadata } = options;
  await ensureStore();
  const { client } = requireOpenAIClientOrAdapter('OpenAI adapter not initialized');

  const parentId = (id && id.trim()) || randomUUID();
  const sourceLabel = (source && source.trim()) || parentId;
  const sanitizedMetadata = sanitizeMetadataInput(metadata);
  if (!('sourceType' in sanitizedMetadata)) {
    sanitizedMetadata.sourceType = 'direct';
  }
  sanitizedMetadata.savedAt = new Date().toISOString();
  if (sourceLabel) {
    sanitizedMetadata.source = sourceLabel;
  }

  const chunks = chunkText(content);
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const docId = `${parentId}#${idx}`;
    const chunkMetadata: Record<string, unknown> = {
      ...sanitizedMetadata,
      parentId,
      chunkIndex: idx,
      chunkCount: chunks.length,
    };

    const existingDoc =
      (vectorStore || []).find((candidate) => candidate.id === docId) ??
      await loadRagDocById(docId).catch(() => null);
    if (existingDoc && existingDoc.content === chunk && existingDoc.url === sourceLabel) {
      upsertDoc(existingDoc as Doc);
      continue;
    }

    const doc: Doc = {
      id: docId,
      url: sourceLabel,
      content: chunk,
      embedding: await createEmbedding(chunk, client),
      metadata: chunkMetadata,
    };

    try {
      await saveRagDoc(doc);
    } catch (error) {
      console.warn('[🧠 RAG] Failed to persist document to database - retaining in-memory copy', error);
    }

    upsertDoc(doc);
  }

  return {
    parentId,
    chunkCount: chunks.length,
    source: sourceLabel,
    contentLength: content.length,
    metadata: sanitizedMetadata,
  };
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
      id: buildConversationSnippetParentId(options, trimmed),
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

interface PersistentMemorySnippetOptions {
  key: string;
  sessionId: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Mirror persisted memory rows into RAG for semantic retrieval.
 * Inputs/outputs: memory key/session/content -> true when ingestion succeeded.
 * Edge cases: missing content or API key returns false without throwing.
 */
export async function recordPersistentMemorySnippet(options: PersistentMemorySnippetOptions): Promise<boolean> {
  const { key, sessionId, content, metadata, timestamp } = options;
  const trimmed = typeof content === 'string' ? content.trim() : '';
  if (!trimmed) {
    return false;
  }

  //audit Assumption: memory->RAG sync is optional best-effort enrichment; failure risk: missing semantic recall in no-key environments; expected invariant: primary memory save path still succeeds; handling strategy: skip ingestion when API key is absent.
  if (!hasValidAPIKey()) {
    ragLogger.debug('Skipping persistent memory ingestion - OpenAI key missing', {
      operation: 'recordPersistentMemorySnippet',
      key,
      sessionId
    });
    return false;
  }

  const snippetMetadata = sanitizeMetadataInput(metadata);
  snippetMetadata.sourceType = 'memory';
  snippetMetadata.memoryKey = key;
  snippetMetadata.sessionId = sessionId;
  if (timestamp !== undefined) {
    snippetMetadata.timestamp = new Date(timestamp).toISOString();
    snippetMetadata.timestampMs = timestamp;
  }

  try {
    await ingestContent({
      id: `memory:${key}`,
      content: trimmed,
      source: `memory:${sessionId}`,
      metadata: snippetMetadata
    });
    return true;
  } catch (error: unknown) {
    ragLogger.warn('Failed to ingest persistent memory snippet', {
      operation: 'recordPersistentMemorySnippet',
      key,
      sessionId
    }, undefined, error instanceof Error ? error : undefined);
    return false;
  }
}

export async function answerQuestion(question: string): Promise<{ answer: string; sources: string[]; verification: string; sourceDetails: SourceDetail[] }> {
  const retrieval = await queryRagDocuments(question, {
    limit: 3,
    minScore: DEFAULT_ANSWER_MIN_SIMILARITY
  });

  const topDocs = retrieval.matches;
  if (topDocs.length === 0) {
    return {
      answer: 'No relevant context was found in memory for that question.',
      sources: [],
      verification: `unsupported: ${retrieval.diagnostics.reason}`,
      sourceDetails: []
    };
  }

  const context = topDocs
    .map((doc) => {
      const metadataText = doc.metadata && Object.keys(doc.metadata).length
        ? `Metadata: ${JSON.stringify(doc.metadata)}\n`
        : '';
      return `${metadataText}${doc.content}`;
    })
    .join('\n---\n');

  const { adapter } = requireOpenAIClientOrAdapter('OpenAI adapter not initialized');

  let answer = '';
  try {
    const answerRes = await adapter.responses.create({
      model: getDefaultModel(),
      messages: [
        {
          role: 'system',
          content: 'Answer using only the provided context. If context is insufficient, say that explicitly.'
        },
        { role: 'user', content: `Question: ${question}\n\nContext:\n${context}` },
      ],
    });
    answer = answerRes.choices[0]?.message?.content || '';
  } catch (error: unknown) {
    ragLogger.warn('Failed to generate RAG answer', {
      operation: 'answerQuestion',
      retrievedDocs: topDocs.length
    }, undefined, error instanceof Error ? error : undefined);
    answer = 'I found relevant context but could not generate an answer right now.';
  }

  let verification = '';
  try {
    const verifyRes = await adapter.responses.create({
      model: getDefaultModel(),
      messages: [
        {
          role: 'system',
          content: 'Verify if the answer is supported by the context. Reply yes or no with a brief reason.'
        },
        { role: 'user', content: `Answer: ${answer}\n\nContext:\n${context}` },
      ],
    });
    verification = verifyRes.choices[0]?.message?.content || '';
  } catch (error: unknown) {
    ragLogger.warn('Failed to verify RAG answer', {
      operation: 'answerQuestion',
      retrievedDocs: topDocs.length
    }, undefined, error instanceof Error ? error : undefined);
    verification = 'verification_unavailable';
  }

  //audit Assumption: free-form model synthesis must not be returned when verification cannot affirm support from retrieved context; failure risk: RAG route emits plausible but unsupported claims; expected invariant: unsupported answers degrade to a grounded insufficiency message; handling strategy: replace answer unless verification clearly affirms support.
  if (!hasAffirmativeVerification(verification)) {
    return {
      answer: 'The retrieved context is insufficient to answer that reliably.',
      sources: topDocs.map((doc) => doc.url),
      verification: `unsupported: ${verification || retrieval.diagnostics.reason}`,
      sourceDetails: topDocs.map((doc) => ({ id: doc.id, url: doc.url, metadata: doc.metadata }))
    };
  }

  return {
    answer,
    sources: topDocs.map((doc) => doc.url),
    verification,
    sourceDetails: topDocs.map((doc) => ({ id: doc.id, url: doc.url, metadata: doc.metadata }))
  };
}

/**
 * Decide whether the verification pass explicitly affirmed grounding.
 * Inputs/outputs: raw verification text -> true when it clearly starts with a positive support verdict.
 * Edge cases: blank or ambiguous verifier text is treated as unsupported to fail closed.
 */
function hasAffirmativeVerification(rawVerification: string): boolean {
  const normalized = rawVerification.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /^(?:yes|supported|grounded)\b/.test(normalized);
}

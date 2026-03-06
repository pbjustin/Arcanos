import express, { Request, Response } from 'express';
import { saveMemory, loadMemory, deleteMemory, getStatus, query } from "@core/db/index.js";
import { asyncHandler, sendInternalErrorPayload } from '@shared/http/index.js';
import { requireField } from "@shared/validation.js";
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { createRateLimitMiddleware } from "@platform/runtime/security.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { unwrapVersionedMemoryEnvelope } from "@services/safety/memoryEnvelope.js";
import { renderMemoryTablePage } from "@services/memoryTablePage.js";
import { executeNaturalLanguageMemoryCommand } from "@services/naturalLanguageMemory.js";
import { queryRagDocuments, type RagQueryMatch } from "@services/webRag.js";

const router = express.Router();
const DEFAULT_SEARCH_LIMIT = 15;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_MIN_SCORE = 0.1;
const SEARCH_SOURCE_TYPES = ['memory', 'conversation'];

interface MemoryTableRow {
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

interface MemoryApiEntry {
  key: string;
  value: unknown;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface MemorySearchHit extends MemoryApiEntry {
  match_type: 'exact' | 'semantic';
  score: number | null;
  source: string;
}

/**
 * Resolve list/view limits from query params with sane defaults and a hard cap.
 * Inputs: raw query limit value, default value, max allowed.
 * Output: normalized integer limit.
 * Edge cases: invalid/negative limits fall back to default; oversized limits clamp to max.
 */
function resolveQueryLimit(rawLimit: unknown, defaultLimit: number, maxLimit: number): number {
  const firstValue = Array.isArray(rawLimit) ? rawLimit[0] : rawLimit;
  const parsedLimit = Number.parseInt(firstValue === undefined ? '' : String(firstValue), 10);

  //audit Assumption: invalid limits should not fail requests; failure risk: excessive rows or empty responses; expected invariant: positive bounded limit; handling strategy: default + clamp.
  if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
    return defaultLimit;
  }

  return Math.min(parsedLimit, maxLimit);
}

/**
 * Resolve optional key prefix filter from query parameters.
 * Inputs: raw query prefix value.
 * Output: normalized prefix string or null when not supplied.
 * Edge cases: empty or non-string values disable filtering.
 */
function resolveKeyPrefix(rawPrefix: unknown): string | null {
  const firstValue = Array.isArray(rawPrefix) ? rawPrefix[0] : rawPrefix;
  if (typeof firstValue !== "string") {
    return null;
  }

  const normalized = firstValue.trim();
  if (!normalized) {
    return null;
  }

  //audit Assumption: prefix filters should stay bounded to avoid pathological scans; failure risk: heavy wildcard scans; expected invariant: concise prefix key filter; handling strategy: clamp length.
  return normalized.slice(0, 120);
}

/**
 * Build memory table select query with optional key prefix filter.
 * Inputs: row limit and optional key prefix.
 * Output: SQL text and parameter list.
 * Edge cases: no prefix returns unfiltered latest rows.
 */
function buildMemorySelect(limit: number, prefix: string | null): { text: string; params: unknown[] } {
  if (!prefix) {
    return {
      text: 'SELECT key, value, created_at, updated_at FROM memory ORDER BY updated_at DESC LIMIT $1',
      params: [limit]
    };
  }

  return {
    text: 'SELECT key, value, created_at, updated_at FROM memory WHERE key ILIKE $2 ORDER BY updated_at DESC LIMIT $1',
    params: [limit, `${prefix}%`]
  };
}

/**
 * Convert raw memory table rows into API-safe entries with envelope payload unwrapped.
 * Inputs: database memory rows.
 * Output: normalized entries with `value` (payload) and optional metadata.
 * Edge cases: legacy rows without envelope metadata are returned as-is.
 */
function normalizeMemoryEntries(rows: MemoryTableRow[]): MemoryApiEntry[] {
  return rows.map((row) => {
    const { payload, metadata } = unwrapVersionedMemoryEnvelope<Record<string, unknown> | unknown>(row.value);
    return {
      key: row.key,
      value: payload,
      metadata: metadata ? (metadata as unknown as Record<string, unknown>) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  });
}

/**
 * Resolve and sanitize memory search query text.
 * Inputs: raw query parameter value.
 * Output: normalized query string or null when invalid.
 * Edge cases: empty or non-string values are rejected.
 */
function resolveSearchQuery(rawQuery: unknown): string | null {
  const firstValue = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  if (typeof firstValue !== 'string') {
    return null;
  }

  const normalized = firstValue.replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  //audit Assumption: long query strings degrade DB and embedding efficiency; failure risk: slow search requests and high cost; expected invariant: bounded query length; handling strategy: clamp query size.
  return normalized.slice(0, 480);
}

/**
 * Escape SQL ILIKE wildcard metacharacters for literal matching.
 * Inputs: user-provided query value.
 * Output: escaped query fragment safe for ILIKE + ESCAPE.
 * Edge cases: backslashes are escaped before wildcard characters.
 */
function escapeSqlLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Resolve optional session filter token for search scoping.
 * Inputs: raw sessionId query parameter.
 * Output: normalized lowercase token or null.
 * Edge cases: invalid values disable session scoping.
 */
function resolveSearchSessionId(rawSessionId: unknown): string | null {
  const firstValue = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  if (typeof firstValue !== 'string') {
    return null;
  }

  const normalized = firstValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 64);
}

/**
 * Convert DB memory entries into normalized exact-match search hits.
 * Inputs: normalized DB entries.
 * Output: normalized search hit array.
 * Edge cases: none.
 */
function toExactSearchHits(entries: MemoryApiEntry[]): MemorySearchHit[] {
  return entries.map((entry) => ({
    ...entry,
    match_type: 'exact',
    score: null,
    source: 'database'
  }));
}

/**
 * Resolve an ISO timestamp from semantic metadata with safe fallbacks.
 * Inputs: semantic metadata object.
 * Output: ISO timestamp string.
 * Edge cases: invalid/missing timestamps fall back to current time.
 */
function resolveSemanticTimestamp(metadata: Record<string, unknown>): string {
  const candidates = [metadata.savedAt, metadata.timestamp, metadata.updatedAt];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

/**
 * Convert semantic RAG matches into normalized search hits.
 * Inputs: RAG match array.
 * Output: normalized semantic hit array.
 * Edge cases: missing memory keys use deterministic rag:* identifiers.
 */
function toSemanticSearchHits(matches: RagQueryMatch[]): MemorySearchHit[] {
  return matches.map((match) => {
    const metadataRecord = (match.metadata ?? {}) as Record<string, unknown>;
    const keyFromMetadata =
      typeof metadataRecord.memoryKey === 'string' && metadataRecord.memoryKey.trim()
        ? metadataRecord.memoryKey.trim()
        : `rag:${match.id}`;
    const timestamp = resolveSemanticTimestamp(metadataRecord);

    return {
      key: keyFromMetadata,
      value: {
        text: match.content,
        source: match.url,
        ragScore: Number(match.score.toFixed(6))
      },
      metadata: {
        ...metadataRecord,
        ragDocId: match.id,
        ragScore: match.score,
        ragSource: match.url
      },
      created_at: timestamp,
      updated_at: timestamp,
      match_type: 'semantic',
      score: Number(match.score.toFixed(6)),
      source: match.url
    };
  });
}

/**
 * Merge exact and semantic hits into one normalized list.
 * Inputs: exact hit list, semantic hit list, final limit.
 * Output: deduplicated merged hit list.
 * Edge cases: exact hits take precedence on duplicate keys.
 */
function mergeSearchHits(
  exactHits: MemorySearchHit[],
  semanticHits: MemorySearchHit[],
  limit: number
): MemorySearchHit[] {
  const mergedHits = [...exactHits];
  const seenKeys = new Set(exactHits.map((hit) => hit.key));

  for (const semanticHit of semanticHits) {
    //audit Assumption: duplicate semantic keys should not override exact DB rows; failure risk: exact records replaced by synthetic payloads; expected invariant: exact results stay authoritative; handling strategy: skip duplicate semantic keys.
    if (seenKeys.has(semanticHit.key)) {
      continue;
    }
    mergedHits.push(semanticHit);
    seenKeys.add(semanticHit.key);
    if (mergedHits.length >= limit) {
      break;
    }
  }

  return mergedHits.slice(0, limit);
}

/**
 * Query exact memory hits using SQL text search with optional session scoping.
 * Inputs: normalized query text, optional session id, bounded limit.
 * Output: normalized exact memory entries.
 * Edge cases: missing session filter searches globally.
 */
async function searchExactMemoryEntries(
  queryText: string,
  sessionId: string | null,
  limit: number
): Promise<MemoryApiEntry[]> {
  const wildcardQuery = `%${escapeSqlLikePattern(queryText)}%`;

  if (!sessionId) {
    const result = await query(
      `SELECT key, value, created_at, updated_at
       FROM memory
       WHERE key ILIKE $1 ESCAPE '\\'
          OR value::text ILIKE $1 ESCAPE '\\'
       ORDER BY updated_at DESC
       LIMIT $2`,
      [wildcardQuery, limit]
    );
    return normalizeMemoryEntries(result.rows as MemoryTableRow[]);
  }

  const sessionPrefixPattern = `nl-memory:${sessionId}:%`;
  const sessionConversationPattern = `session:${sessionId}:%`;

  const result = await query(
    `SELECT key, value, created_at, updated_at
     FROM memory
     WHERE (key ILIKE $1 ESCAPE '\\' OR key ILIKE $2 ESCAPE '\\')
       AND (key ILIKE $3 ESCAPE '\\' OR value::text ILIKE $3 ESCAPE '\\')
     ORDER BY updated_at DESC
     LIMIT $4`,
    [sessionPrefixPattern, sessionConversationPattern, wildcardQuery, limit]
  );
  return normalizeMemoryEntries(result.rows as MemoryTableRow[]);
}

// Apply rate limiting for API routes
router.use(createRateLimitMiddleware(100, 15 * 60 * 1000)); // 100 requests per 15 minutes

// Database health check endpoint
router.get("/health", (_: Request, res: Response) => {
  const dbStatus = getStatus();
  res.json({
    status: 'success',
    message: 'Memory service health check',
    data: {
      database: dbStatus.connected,
      error: dbStatus.error,
      timestamp: new Date().toISOString()
    }
  });
});

// Save memory endpoint
router.post("/save", confirmGate, asyncHandler(async (req: Request, res: Response) => {
  const { key, value } = req.body;

  if (!requireField(res, key, 'key') || !requireField(res, value, 'value')) {
    return;
  }
  
  const result = await saveMemory(key, value);
  res.json({
    status: 'success',
    message: 'Memory saved successfully',
    data: {
      key,
      timestamp: result.updated_at
    }
  });
}));

// Load memory endpoint
router.get("/load", asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.query;
  if (!requireField(res, key, 'key') || typeof key !== 'string') {
    return;
  }
  const value = await loadMemory(key);

  if (value === null) {
    const semanticFallback = await executeNaturalLanguageMemoryCommand({
      input: `load memory key ${key}`,
      sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId : null,
      limit: resolveQueryLimit(req.query.limit, 5, 25)
    });

    //audit Assumption: exact key misses may still have semantically relevant memory rows; failure risk: false "not found" responses for natural-language usage; expected invariant: exact load remains first, semantic fallback remains explicit; handling strategy: return fallback payload when semantic retrieval succeeds.
    if (
      semanticFallback.intent === 'retrieve' &&
      semanticFallback.operation === 'retrieved' &&
      semanticFallback.value !== undefined &&
      semanticFallback.value !== null
    ) {
      return res.json({
        status: 'success',
        message: 'Exact key not found. Returned closest semantic memory match.',
        data: {
          requestedKey: key,
          key: semanticFallback.key,
          value: semanticFallback.value,
          entries: semanticFallback.entries,
          rag: semanticFallback.rag
        }
      });
    }

    return res.status(404).json({
      status: 'error',
      message: 'Memory not found',
      data: {
        key,
        rag: semanticFallback.rag
      },
      timestamp: new Date().toISOString()
    });
  }

  res.json({
    status: 'success',
    message: 'Memory loaded successfully',
    data: {
      key,
      value
    }
  });
}));

// Delete memory endpoint
router.delete("/delete", confirmGate, asyncHandler(async (req: Request, res: Response) => {
  const { key } = req.body;
  if (!requireField(res, key, 'key')) {
    return;
  }
  
  const deleted = await deleteMemory(key);

  if (!deleted) {
    return res.status(404).json({
      status: 'error',
      message: 'Memory not found',
      data: { key },
      timestamp: new Date().toISOString()
    });
  }

  res.json({
    status: 'success',
    message: 'Memory deleted successfully',
    data: { key }
  });
}));

// List recent memory entries
router.get("/list", asyncHandler(async (req: Request, res: Response) => {
  const limit = resolveQueryLimit(req.query.limit, 50, 500);
  const prefix = resolveKeyPrefix(req.query.prefix);
  const statement = buildMemorySelect(limit, prefix);

  const result = await query(statement.text, statement.params);
  const entries = normalizeMemoryEntries(result.rows as MemoryTableRow[]);

  res.json({
    status: 'success',
    message: 'Memory entries retrieved successfully',
    data: {
      count: entries.length,
      prefix,
      entries
    }
  });
}));

// Unified exact + semantic memory search endpoint
router.get("/search", asyncHandler(async (req: Request, res: Response) => {
  const queryText = resolveSearchQuery(req.query.q);

  //audit Assumption: unified search requires non-empty search text; failure risk: wasteful broad scans; expected invariant: explicit q parameter; handling strategy: 400 with guidance.
  if (!queryText) {
    return res.status(400).json({
      status: 'error',
      message: 'q is required and must be a non-empty string',
      timestamp: new Date().toISOString()
    });
  }

  const sessionId = resolveSearchSessionId(req.query.sessionId);
  const limit = resolveQueryLimit(req.query.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

  try {
    const [exactEntries, semanticResult] = await Promise.all([
      searchExactMemoryEntries(queryText, sessionId, limit),
      queryRagDocuments(queryText, {
        limit,
        minScore: DEFAULT_SEARCH_MIN_SCORE,
        sessionId,
        sourceTypes: SEARCH_SOURCE_TYPES
      })
    ]);

    const exactHits = toExactSearchHits(exactEntries);
    const semanticHits = toSemanticSearchHits(semanticResult.matches);
    const hits = mergeSearchHits(exactHits, semanticHits, limit);

    res.json({
      status: 'success',
      message: 'Memory search completed',
      data: {
        schema: {
          key: 'string',
          value: 'unknown',
          metadata: 'object|null',
          created_at: 'ISO-8601 string',
          updated_at: 'ISO-8601 string',
          match_type: '"exact"|"semantic"',
          score: 'number|null',
          source: 'string'
        },
        query: queryText,
        sessionId,
        limit,
        counts: {
          exact: exactHits.length,
          semantic: semanticHits.length,
          merged: hits.length
        },
        diagnostics: {
          rag: semanticResult.diagnostics
        },
        hits
      }
    });
  } catch (error: unknown) {
    //audit Assumption: search path failures should surface structured diagnostics for operators; failure risk: silent retrieval outages; expected invariant: deterministic 5xx payload on failures; handling strategy: internal error payload with normalized message.
    sendInternalErrorPayload(res, {
      status: 'error',
      message: 'Memory search failed',
      error: resolveErrorMessage(error),
      timestamp: new Date().toISOString()
    });
  }
}));

// 🧠 Memory table viewer (database-backed)
router.get("/view", asyncHandler(async (req: Request, res: Response) => {
  try {
    const limit = resolveQueryLimit(req.query.limit, 200, 1000);
    const prefix = resolveKeyPrefix(req.query.prefix);
    const statement = buildMemorySelect(limit, prefix);
    const result = await query(statement.text, statement.params);
    const entries = normalizeMemoryEntries(result.rows as MemoryTableRow[]);

    res.json({
      status: 'success',
      message: 'Memory table retrieved',
      data: {
        source: 'database',
        count: entries.length,
        prefix,
        entries,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    //audit Assumption: DB read failures should be explicit to operators; failure risk: hidden persistence outages; expected invariant: 5xx with actionable error text; handling strategy: structured internal error payload.
    sendInternalErrorPayload(res, {
      status: 'error',
      message: 'Cannot read memory table',
      error: resolveErrorMessage(error),
      timestamp: new Date().toISOString()
    });
  }
}));

// Memory table viewer UI page
router.get("/table", asyncHandler(async (req: Request, res: Response) => {
  try {
    const limit = resolveQueryLimit(req.query.limit, 200, 1000);
    const prefix = resolveKeyPrefix(req.query.prefix);
    const statement = buildMemorySelect(limit, prefix);
    const result = await query(statement.text, statement.params);
    const entries = normalizeMemoryEntries(result.rows as MemoryTableRow[]);
    const htmlPage = renderMemoryTablePage({
      entries,
      prefix,
      limit,
      generatedAtIso: new Date().toISOString(),
      jsonViewPath: '/api/memory/view',
      listPath: '/api/memory/list'
    });

    res.status(200).type('html').send(htmlPage);
  } catch (error) {
    //audit Assumption: UI route must expose clear operational errors when DB access fails; failure risk: blank pages masking persistence outages; expected invariant: deterministic 5xx payload; handling strategy: shared internal error response helper.
    sendInternalErrorPayload(res, {
      status: 'error',
      message: 'Cannot render memory table UI',
      error: resolveErrorMessage(error),
      timestamp: new Date().toISOString()
    });
  }
}));

// Natural-language memory command endpoint
router.post("/nl", asyncHandler(async (req: Request, res: Response) => {
  const rawInput = (req.body as { input?: unknown })?.input;
  const sessionId = (req.body as { sessionId?: unknown })?.sessionId;
  const limit = (req.body as { limit?: unknown })?.limit;

  //audit Assumption: natural-language command requires explicit input text; failure risk: ambiguous no-op requests; expected invariant: non-empty input string; handling strategy: return 400 with guidance.
  if (typeof rawInput !== 'string' || rawInput.trim().length === 0) {
    return res.status(400).json({
      status: 'error',
      message: 'input is required and must be a non-empty string',
      timestamp: new Date().toISOString()
    });
  }

  const result = await executeNaturalLanguageMemoryCommand({
    input: rawInput,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    limit: typeof limit === 'number' ? limit : undefined
  });

  res.json({
    status: 'success',
    message: 'Natural-language memory command processed',
    data: result
  });
}));

// Bulk operations endpoint
router.post("/bulk", confirmGate, asyncHandler(async (req: Request, res: Response) => {
  const { operations } = req.body;
  
  if (!Array.isArray(operations)) {
    return res.status(400).json({
      status: 'error',
      message: 'Operations must be an array',
      timestamp: new Date().toISOString()
    });
  }

  const results = [];
  
  for (const op of operations) {
    try {
      switch (op.type) {
        case 'save':
          await saveMemory(op.key, op.value);
          results.push({ key: op.key, status: 'saved' });
          break;
        case 'delete':
          await deleteMemory(op.key);
          results.push({ key: op.key, status: 'deleted' });
          break;
        default:
          results.push({ key: op.key, status: 'unknown_operation' });
      }
    } catch (error) {
      results.push({ 
        key: op.key, 
        status: 'error', 
        error: resolveErrorMessage(error) 
      });
    }
  }

  res.json({
    status: 'success',
    message: 'Bulk operations completed',
    data: {
      processed: results.length,
      results
    }
  });
}));

export default router;

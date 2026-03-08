import { loadMemory, query, saveMemory } from "@core/db/index.js";
import { unwrapVersionedMemoryEnvelope } from "@services/safety/memoryEnvelope.js";
import { logger } from "@platform/logging/structuredLogging.js";
import {
  queryRagDocuments,
  recordPersistentMemorySnippet,
  type RagQueryDiagnostics,
  type RagQueryMatch
} from "@services/webRag.js";
import {
  buildUnsupportedMemoryInspectionNote,
  isMemoryInspectionPrompt,
  parseMemoryInspectionRequest,
  type MemoryInspectionArtifact
} from "@services/memoryInspectionGuard.js";

const DEFAULT_SESSION_ID = 'global';
const SESSION_KEY_PREFIX = 'nl-memory';
const SESSION_INDEX_KEY_PREFIX = 'nl-session-index';
const SESSION_LATEST_KEY_PREFIX = 'nl-latest';
const SESSION_LABEL_POINTER_KEY_PREFIX = 'nl-session-label';
const DEFAULT_LOOKUP_LIMIT = 10;
const MAX_LOOKUP_LIMIT = 25;
const MAX_SAVE_CONTENT_LENGTH = 12_000;
const MAX_LOOKUP_QUERY_LENGTH = 480;
const MEMORY_RAG_MIN_SCORE = 0.12;
const RAG_SOURCE_TYPES = ['memory', 'conversation'];
const memoryLogger = logger.child({ module: 'naturalLanguageMemory' });

export type NaturalLanguageMemoryIntent = 'save' | 'retrieve' | 'lookup' | 'list' | 'inspect' | 'unknown';
export type NaturalLanguageMemoryRagMode = 'supplemental' | 'fallback' | 'disabled';

export interface NaturalLanguageMemoryRequest {
  input: string;
  sessionId?: string | null;
  limit?: number;
}

export interface NaturalLanguageMemoryEntry {
  recordId?: number | null;
  key: string;
  value: unknown;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface NaturalLanguageMemoryResponse {
  intent: NaturalLanguageMemoryIntent;
  operation: 'saved' | 'retrieved' | 'searched' | 'listed' | 'inspected' | 'ignored';
  sessionId: string;
  message: string;
  key?: string;
  value?: unknown;
  entries?: NaturalLanguageMemoryEntry[];
  rag?: NaturalLanguageMemoryRagResult;
  inspection?: {
    requestedArtifacts: MemoryInspectionArtifact[];
    unsupportedArtifacts: MemoryInspectionArtifact[];
  };
}

interface ParsedMemoryCommand {
  intent: NaturalLanguageMemoryIntent;
  content?: string;
  key?: string;
  queryText?: string;
  latest?: boolean;
  exactSelectors?: ExactNaturalLanguageMemorySelector;
}

interface MemoryTableRow {
  id?: number | string | null;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
}

export interface ExactNaturalLanguageMemorySelector {
  recordId?: number;
  tag?: string;
}

export interface NaturalLanguageMemoryRagMatch {
  key: string;
  source: string;
  score: number;
  docId: string;
}

export interface NaturalLanguageMemoryRagResult {
  active: boolean;
  mode: NaturalLanguageMemoryRagMode;
  reason: string;
  matches: NaturalLanguageMemoryRagMatch[];
  diagnostics: {
    enabled: boolean;
    reason: string;
    candidateCount: number;
    returnedCount: number;
    sessionFilterApplied: boolean;
    sessionFallbackApplied: boolean;
    sourceTypeFilterApplied: boolean;
    minScore: number;
    limit: number;
  };
}

interface SessionLabelPointerPayload {
  sessionId: string;
  storageLabel: string;
  updatedAt: string;
}

const RESERVED_SESSION_ID_TOKENS = new Set([
  'latest',
  'memory',
  'memories',
  'saved',
  'summary',
  'session',
  'story',
  'stories',
  'roster',
  'note',
  'notes',
  'recall',
  'retrieve',
  'lookup',
  'search',
  'show',
  'load',
  'get'
]);

const STRUCTURED_SESSION_METADATA_LINE_PATTERN =
  /^(?:session\s*id|storage\s*label|activation\s*timestamp|status)\s*:/i;
const STORAGE_LABEL_LINE_PATTERN = /\bstorage\s*label\s*[:=]\s*([^\r\n]+)/i;
const RECORD_ID_LINE_PATTERN = /\brecord\s*id\s*[:=]\s*(\d{1,12})\b/i;
const TAG_LINE_PATTERN = /(?:^|\n)\s*tag\s*[:=]\s*([^\r\n]+)/i;
const TAG_INLINE_PATTERN = /\btag\s*[:=]\s*([a-zA-Z0-9_.:-]{2,120})/i;
const STRUCTURED_SESSION_SECTION_CUE_PATTERN =
  /(?:^|\n)\s*(?:persisted\s+summary(?:\s*\(stored\))?|session\s+behavior|session\s+capabilities\s+enabled|available\s+actions)\b/i;
const MIN_STRUCTURED_SESSION_PAYLOAD_LINES = 3;
const MIN_STRUCTURED_SESSION_PAYLOAD_LENGTH = 80;

/**
 * Normalize external session identifiers into a safe bounded token.
 * Inputs/outputs: optional session ID input -> sanitized session ID string.
 * Edge cases: empty/invalid values resolve to `global`.
 */
export function normalizeNaturalLanguageSessionId(rawSessionId: unknown): string {
  if (typeof rawSessionId !== 'string') {
    return DEFAULT_SESSION_ID;
  }

  const normalized = rawSessionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  //audit Assumption: invalid or empty normalized IDs should not block save/lookup; failure risk: fragmented memory namespaces; expected invariant: stable non-empty session partition key; handling strategy: fallback to default.
  if (!normalized) {
    return DEFAULT_SESSION_ID;
  }

  return normalized.slice(0, 64);
}

/**
 * Extract an explicit session identifier from a natural-language prompt when one is present.
 * Inputs/outputs: raw user prompt -> normalized session identifier or null.
 * Edge cases: ignores reserved nouns and malformed tokens to avoid collapsing normal prose into session IDs.
 */
export function extractNaturalLanguageSessionId(rawInput: string): string | null {
  const trimmedInput = rawInput.trim();

  const explicitPatterns = [
    /\bsession\s*id\s*[:=]\s*["'`]?([a-zA-Z0-9_-]{2,64})["'`]?/i,
    /\bfor\s+session\s+["'`]?([a-zA-Z0-9_-]{2,64})["'`]?/i,
    /^(?:please\s+)?recall\b[:\s-]*["'`]?([a-zA-Z0-9_-]{2,64})["'`]?$/i,
    /\b(?:for|of)\s+["'`]?([a-zA-Z0-9_-]{2,64})["'`]?$/i
  ];

  for (const pattern of explicitPatterns) {
    const match = trimmedInput.match(pattern);
    const normalizedMatch = normalizeSessionIdCandidate(match?.[1]);
    const requiresStructuredToken = pattern.source.includes('(?:for|of)');
    const structuredToken = isStructuredSessionIdentifier(match?.[1]);
    //audit Assumption: explicit session-id syntax should outrank global fallback; failure risk: unrelated sessions bleed together under global memory; expected invariant: recognized session labels resolve deterministically; handling strategy: return the first valid normalized match.
    if (normalizedMatch && (!requiresStructuredToken || structuredToken)) {
      return normalizedMatch;
    }
  }

  //audit Assumption: some clients send the session token alone (for example, a recall picker); failure risk: exact session lookups fail and drift to semantic fallback; expected invariant: standalone session-like tokens resolve directly; handling strategy: accept only bounded safe identifiers.
  return normalizeSessionIdCandidate(trimmedInput);
}

/**
 * Extract exact persisted-memory selectors such as record id and diagnostic tag.
 * Inputs/outputs: raw user prompt -> normalized selector bundle or null.
 * Edge cases: malformed ids/tags are ignored so callers can fail closed without inventing selector state.
 */
export function extractNaturalLanguageExactMemorySelector(
  rawInput: string
): ExactNaturalLanguageMemorySelector | null {
  const recordIdMatch = rawInput.match(RECORD_ID_LINE_PATTERN);
  const parsedRecordId = recordIdMatch?.[1] ? Number.parseInt(recordIdMatch[1], 10) : Number.NaN;
  const normalizedRecordId = Number.isInteger(parsedRecordId) && parsedRecordId > 0 ? parsedRecordId : null;
  const normalizedTag = normalizeExactMemoryTag(
    rawInput.match(TAG_LINE_PATTERN)?.[1] ?? rawInput.match(TAG_INLINE_PATTERN)?.[1]
  );

  //audit Assumption: selector extraction should only activate when at least one exact selector is present; failure risk: generic prompts are treated as exact DB inspections; expected invariant: null means "no exact selector"; handling strategy: require a valid record id or normalized tag.
  if (normalizedRecordId === null && !normalizedTag) {
    return null;
  }

  return {
    ...(normalizedRecordId === null ? {} : { recordId: normalizedRecordId }),
    ...(normalizedTag ? { tag: normalizedTag } : {})
  };
}

/**
 * Build a stable synthetic session token for exact selector requests.
 * Inputs/outputs: exact selector bundle -> normalized session-like label.
 * Edge cases: missing fields fall back to the default global token.
 */
export function buildExactNaturalLanguageMemorySelectorLabel(
  selector: ExactNaturalLanguageMemorySelector
): string {
  const descriptorParts: string[] = [];

  if (typeof selector.recordId === 'number') {
    descriptorParts.push(`record-${selector.recordId}`);
  }

  if (typeof selector.tag === 'string' && selector.tag.trim()) {
    descriptorParts.push(`tag-${selector.tag}`);
  }

  return normalizeNaturalLanguageSessionId(descriptorParts.join('-'));
}

/**
 * Determine whether a prompt explicitly asks for exact persisted-memory retrieval by selector.
 * Inputs/outputs: raw user prompt -> boolean exact-selector cue.
 * Edge cases: raw selector mentions without retrieval verbs stay false to avoid hijacking narrative text.
 */
export function hasExactNaturalLanguageMemorySelectorCue(rawInput: string): boolean {
  const selector = extractNaturalLanguageExactMemorySelector(rawInput);
  if (!selector) {
    return false;
  }

  //audit Assumption: record/tag prompts should bypass model reasoning only when the user is clearly asking to retrieve or inspect stored payloads; failure risk: narrative diagnostics that merely mention a record id get intercepted; expected invariant: exact-selector mode requires both selectors and retrieval cues; handling strategy: gate on bounded retrieval verbs and memory nouns.
  return /\b(?:recall|get|load|retrieve|show|find|lookup|look\s*up|search|inspect)\b/i.test(rawInput)
    && /\b(?:payload|record\s*id|tag|stored|saved|memory)\b/i.test(rawInput);
}

/**
 * Parse a natural-language memory command into an executable intent.
 * Inputs/outputs: user command text -> parsed intent/arguments.
 * Edge cases: ambiguous text is downgraded to lookup or unknown.
 */
export function parseNaturalLanguageMemoryCommand(rawInput: string): ParsedMemoryCommand {
  const trimmedInput = rawInput.trim();
  const loweredInput = trimmedInput.toLowerCase();

  //audit Assumption: save verbs are high-confidence write intents; failure risk: accidental writes for conversational text; expected invariant: explicit save/store/remember prefix; handling strategy: strict prefix matching.
  if (/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(save|store|remember)\b/i.test(trimmedInput)) {
    const content = trimmedInput
      .replace(/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(save|store|remember)\b[:\s-]*/i, '')
      .trim();
    const keyMatch = content.match(/\b(?:under(?:\s+the)?\s+key|with\s+key|key)\s+["'`]?([a-zA-Z0-9:_-]{2,120})["'`]?$/i);
    const explicitKey = keyMatch?.[1] ?? undefined;
    const normalizedContent = explicitKey
      ? content.replace(keyMatch![0], '').trim()
      : content;

    //audit Assumption: save command without content should not write empty values; failure risk: noisy unusable memory rows; expected invariant: non-empty content for save intent; handling strategy: downgrade to unknown.
    if (!normalizedContent) {
      return { intent: 'unknown' };
    }

    return {
      intent: 'save',
      content: normalizedContent,
      key: explicitKey
    };
  }

  const exactSelector = extractNaturalLanguageExactMemorySelector(trimmedInput);
  //audit Assumption: exact record/tag selectors should become deterministic DB retrieval instead of generic lookup text or model reasoning; failure risk: record-id diagnostics drift to semantic matches or hallucinated status prose; expected invariant: selector prompts keep their exact selector bundle; handling strategy: promote exact-selector requests before broader recall/search parsing.
  if (exactSelector && hasExactNaturalLanguageMemorySelectorCue(trimmedInput)) {
    return {
      intent: 'lookup',
      exactSelectors: exactSelector
    };
  }

  const recallMatch = trimmedInput.match(/^(?:please\s+)?recall\b[:\s-]*(.*)$/i);
  if (recallMatch) {
    const recallTarget = recallMatch[1].trim();
    const explicitSessionId = extractNaturalLanguageSessionId(trimmedInput);

    //audit Assumption: "recall <session-id>" is a direct request for the latest session-scoped memory; failure risk: the command falls through to generic module routing and returns unrelated model output; expected invariant: explicit recall commands become deterministic memory reads; handling strategy: treat session-like recall targets as latest retrieval requests.
    if (explicitSessionId || !recallTarget) {
      return { intent: 'retrieve', latest: true };
    }

    return { intent: 'lookup', queryText: recallTarget };
  }

  //audit Assumption: "latest" retrieval should resolve to session pointer; failure risk: wrong row lookup; expected invariant: user explicitly asked for last/latest; handling strategy: dedicated latest intent flag.
  if (/\b(last|latest)\b/.test(loweredInput) && /\b(memory|saved|summary|story|roster|note)\b/.test(loweredInput)) {
    return { intent: 'retrieve', latest: true };
  }

  //audit Assumption: list verbs should return scoped session rows; failure risk: command confusion with lookup; expected invariant: explicit list/show all memories wording; handling strategy: keyword gating.
  const inspectionRequest = parseMemoryInspectionRequest(trimmedInput);
  //audit Assumption: raw-memory inspection cues should not fall through to generic lookup/model reasoning; failure risk: unsupported backend-state prompts are rephrased into hallucinated tables or audit scaffolds; expected invariant: inspection prompts resolve into deterministic DB-backed inspection mode; handling strategy: promote explicit inspection cues before generic lookup parsing.
  if (inspectionRequest) {
    return { intent: 'inspect' };
  }

  if (/\b(list|show)\b/.test(loweredInput) && /\b(memories|memory|saved)\b/.test(loweredInput)) {
    return { intent: 'list' };
  }

  const explicitKeyMatch = trimmedInput.match(
    /^(?:please\s+)?(?:get|load|retrieve|show)\s+(?:memory\s+)?(?:for\s+)?(?:key\s+)?["'`]?([a-zA-Z0-9:_-]{2,120})["'`]?$/i
  );

  //audit Assumption: exact key retrieval should only fire on simple one-key command forms; failure risk: misclassifying lookup text as exact key; expected invariant: single token key after retrieval verb; handling strategy: strict whole-line regex.
  if (explicitKeyMatch?.[1]) {
    return { intent: 'retrieve', key: explicitKeyMatch[1] };
  }

  const lookupMatch = trimmedInput.match(/^(?:please\s+)?(?:find|lookup|look\s*up|search|get|retrieve|show)\b[:\s-]*(.*)$/i);
  if (lookupMatch) {
    const queryText = lookupMatch[1].trim();
    if (queryText) {
      return { intent: 'lookup', queryText };
    }
  }

  const structuredSessionSaveContent = extractStructuredSessionSaveContent(trimmedInput);
  //audit Assumption: some clients submit session registration payloads without an explicit save verb; failure risk: these prompts fall through to model routing and fabricate acknowledgements instead of persisting memory; expected invariant: session-scoped recap payloads still become deterministic save operations; handling strategy: promote structured session payloads into save intents after explicit command parsing fails.
  if (structuredSessionSaveContent) {
    return {
      intent: 'save',
      content: structuredSessionSaveContent
    };
  }

  return { intent: 'unknown' };
}

/**
 * Detect explicit natural-language memory cues before routing a prompt into generic model execution.
 * Inputs/outputs: raw user prompt -> true when the prompt is clearly memory-oriented.
 * Edge cases: generic "show/get" prompts without memory/session cues stay false to avoid hijacking normal tutoring requests.
 */
export function hasNaturalLanguageMemoryCue(rawInput: string): boolean {
  const normalizedInput = rawInput.trim().toLowerCase();

  //audit Assumption: empty prompts cannot carry actionable memory intent; failure risk: false-positive interception on blank requests; expected invariant: cue detection only runs on non-empty prompts; handling strategy: short-circuit false.
  if (!normalizedInput) {
    return false;
  }

  return (
    /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:save|store|remember)\b/.test(normalizedInput) ||
    /^(?:please\s+)?(?:lookup|look\s*up|find)\b/.test(normalizedInput) ||
    /^(?:please\s+)?recall\b/.test(normalizedInput) ||
    hasExactNaturalLanguageMemorySelectorCue(normalizedInput) ||
    isMemoryInspectionPrompt(normalizedInput) ||
    /\b(last|latest)\b/.test(normalizedInput) && /\b(memory|saved|summary|story|roster|note)\b/.test(normalizedInput) ||
    /\b(memory|memories|remember|remembered|recall|saved)\b/.test(normalizedInput) ||
    /\bsession\s*id\s*:/.test(normalizedInput) ||
    /\bstorage\s*label\s*:/.test(normalizedInput)
  );
}

/**
 * Execute a natural-language memory command against persisted DB memory.
 * Inputs/outputs: command request -> structured operation response.
 * Edge cases: unknown commands are ignored safely without side effects.
 */
export async function executeNaturalLanguageMemoryCommand(
  request: NaturalLanguageMemoryRequest
): Promise<NaturalLanguageMemoryResponse> {
  const requestIncludesExplicitSessionTarget = hasExplicitSessionTarget(request);
  const sessionId = await resolveRequestedSessionId(request);
  const parsedCommand = parseNaturalLanguageMemoryCommand(request.input);
  const lookupLimit = resolveLookupLimit(request.limit);

  //audit Assumption: unknown commands should return guidance instead of failing; failure risk: poor UX and retries; expected invariant: deterministic no-op response; handling strategy: explicit ignored operation payload.
  if (parsedCommand.intent === 'unknown') {
    return {
      intent: 'unknown',
      operation: 'ignored',
      sessionId,
      message: 'Command not recognized. Try save/store, get/load, lookup/find, or list memories.'
    };
  }

  if (parsedCommand.intent === 'save') {
    const content = normalizeSaveContent(parsedCommand.content as string);
    const explicitKey = typeof parsedCommand.key === 'string' ? parsedCommand.key : null;
    const reusableSave = explicitKey
      ? null
      : await findReusableLatestSessionSave(sessionId, content);
    const key = reusableSave?.key ?? explicitKey ?? buildAutoMemoryKey(sessionId, content);
    const savedPayload = reusableSave?.payload ?? {
      sessionId,
      text: content,
      savedAt: new Date().toISOString()
    };

    //audit Assumption: retrying the exact same session save should not create duplicate nl-memory rows; failure risk: repeated writes bloat the table and distort recall inspection output; expected invariant: latest identical session payload reuses the existing key; handling strategy: reuse the latest matching row when the normalized content is unchanged.
    if (!reusableSave) {
      await saveMemory(key, savedPayload);
    }

    await updateSessionIndexes(sessionId, key);
    await updateSessionLabelPointer({
      sessionId,
      storageLabel: extractNaturalLanguageStorageLabel(content) ?? extractNaturalLanguageStorageLabel(request.input)
    });

    const ragIngested = reusableSave
      ? false
      : await recordPersistentMemorySnippet({
        key,
        sessionId,
        content,
        metadata: {
          sourceType: 'memory',
          intent: 'save'
        },
        timestamp: Date.now()
      });
    const ragReason = reusableSave
      ? 'already_indexed'
      : ragIngested
        ? 'ingested'
        : 'ingestion_skipped_or_failed';

    const ragResult: NaturalLanguageMemoryRagResult = {
      active: ragIngested,
      mode: ragIngested ? 'supplemental' : 'disabled',
      reason: ragReason,
      matches: [],
      diagnostics: {
        enabled: ragIngested,
        reason: reusableSave ? 'already_indexed' : ragIngested ? 'ok' : 'ingestion_skipped_or_failed',
        candidateCount: 0,
        returnedCount: 0,
        sessionFilterApplied: true,
        sessionFallbackApplied: false,
        sourceTypeFilterApplied: true,
        minScore: MEMORY_RAG_MIN_SCORE,
        limit: Math.min(lookupLimit, MAX_LOOKUP_LIMIT)
      }
    };

    return {
      intent: 'save',
      operation: 'saved',
      sessionId,
      key,
      value: savedPayload,
      message: ragIngested
        ? 'Saved to memory successfully and indexed for semantic retrieval.'
        : 'Saved to memory successfully.',
      rag: ragResult
    };
  }

  if (parsedCommand.intent === 'retrieve') {
    if (parsedCommand.latest) {
      const latestPointer = await loadMemory(buildLatestPointerKey(sessionId));
      const latestKey = extractNaturalLanguageMemoryPointerKey(latestPointer);

      //audit Assumption: latest pointer may not exist for new sessions; failure risk: null dereference; expected invariant: safe empty response for first-use sessions; handling strategy: early return with guidance.
      if (!latestKey) {
        //audit Assumption: explicit session-targeted recall must not drift into semantically similar sessions; failure risk: exact recall for `raw_x` returns `raw_x_probe` or unrelated scaffold content; expected invariant: explicit session misses return a deterministic empty result; handling strategy: skip RAG fallback when the caller named the session explicitly.
        if (requestIncludesExplicitSessionTarget) {
          return {
            intent: 'retrieve',
            operation: 'retrieved',
            sessionId,
            message: 'No saved memory found yet for this session.',
            rag: disabledRagResult('exact_session_not_found')
          };
        }

        const ragFallback = await resolveRagFallbackEntries({
          queryText: request.input,
          sessionId,
          limit: lookupLimit
        });

        //audit Assumption: semantic fallback should assist when pointer metadata is missing; failure risk: false "no memory" for recoverable sessions; expected invariant: exact retrieval remains primary with semantic best-effort fallback; handling strategy: attach first semantic hit when available.
        if (ragFallback.entries.length > 0) {
          const firstEntry = ragFallback.entries[0];
          return {
            intent: 'retrieve',
            operation: 'retrieved',
            sessionId,
            key: firstEntry.key,
            value: firstEntry.value,
            entries: ragFallback.entries,
            message: 'No latest pointer found. Returning the closest semantic memory match.',
            rag: ragFallback.rag
          };
        }

        return {
          intent: 'retrieve',
          operation: 'retrieved',
          sessionId,
          message: 'No saved memory found yet for this session.',
          rag: ragFallback.rag
        };
      }

      const latestValue = await loadMemory(latestKey);
      if (latestValue === null) {
        //audit Assumption: explicit session-targeted recall must surface broken pointers instead of rerouting across sessions; failure risk: missing pointer rows resolve to unrelated semantic neighbors; expected invariant: pointer corruption remains visible to operators; handling strategy: return the exact-pointer-missing message without semantic fallback.
        if (requestIncludesExplicitSessionTarget) {
          return {
            intent: 'retrieve',
            operation: 'retrieved',
            sessionId,
            key: latestKey,
            value: null,
            message: 'Latest pointer exists, but the referenced memory row is missing.',
            rag: disabledRagResult('exact_pointer_missing')
          };
        }

        const ragFallback = await resolveRagFallbackEntries({
          queryText: request.input,
          sessionId,
          limit: lookupLimit
        });

        if (ragFallback.entries.length > 0) {
          const firstEntry = ragFallback.entries[0];
          return {
            intent: 'retrieve',
            operation: 'retrieved',
            sessionId,
            key: firstEntry.key,
            value: firstEntry.value,
            entries: ragFallback.entries,
            message: 'Latest pointer row is missing. Returning closest semantic memory match.',
            rag: ragFallback.rag
          };
        }
      }

      return {
        intent: 'retrieve',
        operation: 'retrieved',
        sessionId,
        key: latestKey,
        value: latestValue,
        message: latestValue === null
          ? 'Latest pointer exists, but the referenced memory row is missing.'
          : 'Loaded latest saved memory.',
        rag: disabledRagResult('exact_hit')
      };
    }

    const key = parsedCommand.key as string;
    const value = await loadMemory(key);
    if (value === null) {
      //audit Assumption: exact key retrieval should remain exact even on misses; failure risk: callers inspecting a missing key receive semantically similar but incorrect payloads; expected invariant: key misses are reported directly; handling strategy: skip semantic fallback for exact-key retrieval commands.
      return {
        intent: 'retrieve',
        operation: 'retrieved',
        sessionId,
        key,
        value: null,
        message: 'No memory found for that key.',
        rag: disabledRagResult('exact_key_not_found')
      };
    }

    return {
      intent: 'retrieve',
      operation: 'retrieved',
      sessionId,
      key,
      value,
      message: 'Loaded memory by key.',
      rag: disabledRagResult('exact_hit')
    };
  }

  if (parsedCommand.intent === 'list') {
    const rows = await querySessionEntries(sessionId, lookupLimit);
    return {
      intent: 'list',
      operation: 'listed',
      sessionId,
      entries: rows,
      message: `Found ${rows.length} saved memory entr${rows.length === 1 ? 'y' : 'ies'} for session ${sessionId}.`,
      rag: disabledRagResult('not_requested')
    };
  }

  if (parsedCommand.intent === 'inspect') {
    const rows = await querySessionEntries(sessionId, lookupLimit);
    const inspectionRequest = parseMemoryInspectionRequest(request.input) ?? {
      requestedArtifacts: ['raw_memory_rows'] as MemoryInspectionArtifact[],
      unsupportedArtifacts: [] as MemoryInspectionArtifact[]
    };
    const unsupportedNote = buildUnsupportedMemoryInspectionNote(inspectionRequest.unsupportedArtifacts);
    const rowMessage = rows.length > 0
      ? `Retrieved ${rows.length} exact memory row${rows.length === 1 ? '' : 's'} for session ${sessionId}.`
      : `No exact memory rows were found for session ${sessionId}.`;

    return {
      intent: 'inspect',
      operation: 'inspected',
      sessionId,
      entries: rows,
      message: unsupportedNote ? `${rowMessage} ${unsupportedNote}` : rowMessage,
      rag: disabledRagResult('inspection_exact_only'),
      inspection: {
        requestedArtifacts: inspectionRequest.requestedArtifacts,
        unsupportedArtifacts: inspectionRequest.unsupportedArtifacts
      }
    };
  }

  if (parsedCommand.exactSelectors) {
    const exactSelectorEntries = await queryExactNaturalLanguageMemoryEntries(
      parsedCommand.exactSelectors,
      lookupLimit
    );
    const selectorDescription = describeExactNaturalLanguageMemorySelector(parsedCommand.exactSelectors);

    return {
      intent: 'lookup',
      operation: 'searched',
      sessionId,
      entries: exactSelectorEntries,
      message: exactSelectorEntries.length > 0
        ? `Found ${exactSelectorEntries.length} exact persisted memory entr${exactSelectorEntries.length === 1 ? 'y' : 'ies'} for ${selectorDescription}.`
        : `No exact persisted memory rows matched ${selectorDescription}.`,
      rag: disabledRagResult(exactSelectorEntries.length > 0 ? 'exact_selector_hit' : 'exact_selector_not_found')
    };
  }

  const queryText = normalizeLookupQueryText(parsedCommand.queryText as string);
  if (!queryText) {
    return {
      intent: 'lookup',
      operation: 'searched',
      sessionId,
      entries: [],
      message: 'Lookup query is empty after normalization.',
      rag: disabledRagResult('empty_query')
    };
  }

  const [searchRows, ragFallback] = await Promise.all([
    searchSessionEntries(sessionId, queryText, lookupLimit),
    resolveRagFallbackEntries({
      queryText,
      sessionId,
      limit: lookupLimit,
      allowSessionFallback: !requestIncludesExplicitSessionTarget
    })
  ]);
  const mergedRows = mergeMemoryEntries(searchRows, ragFallback.entries, lookupLimit);
  const usedSemanticFallback = searchRows.length === 0 && ragFallback.entries.length > 0;

  return {
    intent: 'lookup',
    operation: 'searched',
    sessionId,
    entries: mergedRows,
    message: usedSemanticFallback
      ? `No exact DB matches. Returned ${ragFallback.entries.length} semantic entr${ragFallback.entries.length === 1 ? 'y' : 'ies'} for "${queryText}".`
      : `Found ${mergedRows.length} matching entr${mergedRows.length === 1 ? 'y' : 'ies'} for "${queryText}".`,
    rag: ragFallback.rag
  };
}

/**
 * Determine whether a command explicitly targets a session rather than relying on general memory lookup.
 * Inputs/outputs: natural-language request -> true when a session id is provided out of band or inline.
 * Edge cases: blank/undefined transport session ids are ignored so generic global lookups can still use semantic fallback.
 */
function hasExplicitSessionTarget(request: NaturalLanguageMemoryRequest): boolean {
  if (typeof request.sessionId === 'string' && request.sessionId.trim().length > 0) {
    return true;
  }

  return extractNaturalLanguageSessionId(request.input) !== null;
}

/**
 * Resolve lookup limits with defaults and bounds.
 * Inputs/outputs: untrusted limit value -> bounded integer limit.
 * Edge cases: invalid/negative values fall back to default.
 */
function resolveLookupLimit(rawLimit: unknown): number {
  const parsed = Number.parseInt(rawLimit === undefined ? '' : String(rawLimit), 10);

  //audit Assumption: bad limits should not fail command execution; failure risk: user-facing 400 churn; expected invariant: stable bounded query limit; handling strategy: default and clamp.
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_LOOKUP_LIMIT;
  }

  return Math.min(parsed, MAX_LOOKUP_LIMIT);
}

/**
 * Detect session-registration style save payloads that omit an explicit save verb.
 * Inputs/outputs: normalized raw prompt -> original content to persist or null.
 * Edge cases: short metadata-only prompts are ignored to avoid hijacking ordinary chat.
 */
function extractStructuredSessionSaveContent(rawInput: string): string | null {
  const explicitSessionId = extractNaturalLanguageSessionId(rawInput);
  if (!explicitSessionId) {
    return null;
  }

  const nonEmptyLines = rawInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasMetadataLine = nonEmptyLines.some((line) => STRUCTURED_SESSION_METADATA_LINE_PATTERN.test(line));
  const contentLines = nonEmptyLines.filter((line) => !STRUCTURED_SESSION_METADATA_LINE_PATTERN.test(line));
  const hasStructuredSectionCue = STRUCTURED_SESSION_SECTION_CUE_PATTERN.test(rawInput);

  //audit Assumption: standalone session identifiers should not be auto-saved; failure risk: recall-only prompts are misclassified as writes; expected invariant: structured save fallback requires explicit metadata formatting; handling strategy: require at least one recognized metadata line.
  if (!hasMetadataLine) {
    return null;
  }

  const hasSubstantiveStructuredPayload =
    contentLines.length >= MIN_STRUCTURED_SESSION_PAYLOAD_LINES ||
    rawInput.length >= MIN_STRUCTURED_SESSION_PAYLOAD_LENGTH;

  //audit Assumption: metadata-only payloads are not enough evidence of a save request; failure risk: tiny session setup snippets create noisy memory rows; expected invariant: auto-save fallback only runs for substantial recap payloads; handling strategy: require bounded content volume or a structured section cue.
  if (!hasSubstantiveStructuredPayload || (!hasStructuredSectionCue && contentLines.length < 2)) {
    return null;
  }

  return rawInput;
}

/**
 * Normalize memory content before save.
 * Inputs/outputs: raw user content -> trimmed bounded content.
 * Edge cases: oversized content is truncated to protect storage/query reliability.
 */
function normalizeSaveContent(rawContent: string): string {
  const normalized = rawContent.trim();
  //audit Assumption: very large payloads degrade retrieval quality and storage costs; failure risk: oversized memory rows and slower queries; expected invariant: bounded save payload size; handling strategy: truncate with deterministic cap.
  if (normalized.length <= MAX_SAVE_CONTENT_LENGTH) {
    return normalized;
  }

  return normalized.slice(0, MAX_SAVE_CONTENT_LENGTH);
}

/**
 * Build deterministic session-scoped key prefix for stored NL memories.
 * Inputs/outputs: session id -> key prefix string.
 * Edge cases: none (session id already normalized).
 */
function buildSessionKeyPrefix(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}:${sessionId}:`;
}

/**
 * Build storage key for session index rows.
 * Inputs/outputs: session id -> index key string.
 * Edge cases: none (session id already normalized).
 */
function buildSessionIndexKey(sessionId: string): string {
  return `${SESSION_INDEX_KEY_PREFIX}:${sessionId}`;
}

/**
 * Build storage key for latest-memory pointer rows.
 * Inputs/outputs: session id -> latest pointer key string.
 * Edge cases: none (session id already normalized).
 */
function buildLatestPointerKey(sessionId: string): string {
  return `${SESSION_LATEST_KEY_PREFIX}:${sessionId}`;
}

/**
 * Create a session-scoped key automatically from command content.
 * Inputs/outputs: session id + content -> bounded key string.
 * Edge cases: missing lexical tokens fallback to generic slug.
 */
function buildAutoMemoryKey(sessionId: string, content: string): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const tokenSlug = content
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join('-')
    .slice(0, 72);

  const safeSlug = tokenSlug || 'entry';
  const key = `${buildSessionKeyPrefix(sessionId)}${safeSlug}-${timestamp}`;

  //audit Assumption: memory keys must remain under DB varchar(255); failure risk: persistence write failures; expected invariant: key length <= 255 chars; handling strategy: truncate final key.
  return key.slice(0, 255);
}

interface ReusableLatestSessionSave {
  key: string;
  payload: {
    sessionId: string;
    text: string;
    savedAt?: string;
    [key: string]: unknown;
  };
}

/**
 * Reuse the latest session memory row when a retry submits the same payload again.
 * Inputs/outputs: session id plus normalized content -> reusable key/payload or null.
 * Edge cases: malformed or legacy latest rows simply fall back to creating a new row.
 */
async function findReusableLatestSessionSave(
  sessionId: string,
  normalizedContent: string
): Promise<ReusableLatestSessionSave | null> {
  const latestPointer = await loadMemory(buildLatestPointerKey(sessionId));
  const latestKey = extractNaturalLanguageMemoryPointerKey(latestPointer);
  if (!latestKey) {
    return null;
  }

  const latestValue = await loadMemory(latestKey);
  const reusablePayload = normalizeReusableLatestSessionPayload(latestValue);
  //audit Assumption: only the latest identical session payload should be treated as an idempotent retry; failure risk: older historical rows are collapsed unintentionally; expected invariant: reuse is limited to the current latest row with the same normalized text and session id; handling strategy: compare the latest row's canonical fields and return null on any mismatch.
  if (
    !reusablePayload ||
    reusablePayload.sessionId !== sessionId ||
    normalizeSaveContent(reusablePayload.text) !== normalizedContent
  ) {
    return null;
  }

  return {
    key: latestKey,
    payload: reusablePayload
  };
}

/**
 * Normalize persisted latest-row payloads into the save-response shape used by retries.
 * Inputs/outputs: latest memory payload -> reusable save payload or null.
 * Edge cases: legacy string rows are supported by projecting them into `{ text }` payloads.
 */
function normalizeReusableLatestSessionPayload(
  payload: unknown
): ReusableLatestSessionSave['payload'] | null {
  if (typeof payload === 'string' && payload.trim()) {
    return {
      sessionId: DEFAULT_SESSION_ID,
      text: payload.trim()
    };
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const payloadRecord = payload as Record<string, unknown>;
  if (
    typeof payloadRecord.sessionId !== 'string' ||
    typeof payloadRecord.text !== 'string' ||
    !payloadRecord.text.trim()
  ) {
    return null;
  }

  return {
    ...payloadRecord,
    sessionId: normalizeNaturalLanguageSessionId(payloadRecord.sessionId),
    text: payloadRecord.text
  };
}

/**
 * Persist latest/session index pointers for fast retrieval flows.
 * Inputs/outputs: session id and key, persists pointer/index rows.
 * Edge cases: non-array or malformed index payload resets safely.
 */
async function updateSessionIndexes(sessionId: string, key: string): Promise<void> {
  const latestKey = buildLatestPointerKey(sessionId);
  const sessionIndexKey = buildSessionIndexKey(sessionId);

  await saveMemory(latestKey, {
    key,
    updatedAt: new Date().toISOString()
  });

  const existingIndex = await loadMemory(sessionIndexKey);
  const existingKeys = Array.isArray(existingIndex)
    ? existingIndex.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];

  const dedupedKeys = [key, ...existingKeys.filter((existingKey) => existingKey !== key)];
  const boundedKeys = dedupedKeys.slice(0, 200);

  await saveMemory(sessionIndexKey, boundedKeys);
}

/**
 * Extract a persisted memory key from latest-pointer payloads.
 * Inputs/outputs: unknown pointer payload -> persisted memory key or null.
 * Edge cases: legacy raw-string pointers remain supported for older rows.
 */
export function extractNaturalLanguageMemoryPointerKey(pointerPayload: unknown): string | null {
  //audit Assumption: newest pointer format is object with `key`; failure risk: unable to resolve latest row after migrations; expected invariant: best-effort key extraction; handling strategy: support object and legacy string.
  if (typeof pointerPayload === 'string' && pointerPayload) {
    return pointerPayload;
  }

  if (
    typeof pointerPayload === 'object' &&
    pointerPayload !== null &&
    'key' in pointerPayload &&
    typeof (pointerPayload as { key: unknown }).key === 'string'
  ) {
    return (pointerPayload as { key: string }).key;
  }

  return null;
}

/**
 * Query most recent session-scoped memory entries.
 * Inputs/outputs: session id + limit -> normalized entry list.
 * Edge cases: empty result set returns empty array.
 */
async function querySessionEntries(sessionId: string, limit: number): Promise<NaturalLanguageMemoryEntry[]> {
  const sessionPrefixPattern = `${buildSessionKeyPrefix(sessionId)}%`;
  const result = await query(
    `SELECT key, value, created_at, updated_at
     FROM memory
     WHERE key ILIKE $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [sessionPrefixPattern, limit]
  );

  return normalizeMemoryTableRows(result.rows as MemoryTableRow[]);
}

/**
 * Query persisted memory rows by exact record-id and/or tag selectors.
 * Inputs/outputs: selector bundle + limit -> normalized exact-match entry list.
 * Edge cases: tag matching uses literal substring search against key/value text so callers still avoid semantic fallback.
 */
export async function queryExactNaturalLanguageMemoryEntries(
  selector: ExactNaturalLanguageMemorySelector,
  limit: number
): Promise<NaturalLanguageMemoryEntry[]> {
  const normalizedLimit = resolveLookupLimit(limit);
  const tagPattern = typeof selector.tag === 'string' && selector.tag.trim()
    ? `%${escapeSqlLikePattern(selector.tag)}%`
    : null;

  const result = await query(
    `SELECT id, key, value, created_at, updated_at
     FROM memory
     WHERE ($1::integer IS NULL OR id = $1)
       AND ($2::text IS NULL OR key ILIKE $2 ESCAPE '\\' OR value::text ILIKE $2 ESCAPE '\\')
     ORDER BY updated_at DESC
     LIMIT $3`,
    [selector.recordId ?? null, tagPattern, normalizedLimit]
  );

  return normalizeMemoryTableRows(result.rows as MemoryTableRow[]);
}

/**
 * Search session-scoped memory entries by query text.
 * Inputs/outputs: session id + query + limit -> normalized matching entries.
 * Edge cases: empty results return empty array.
 */
async function searchSessionEntries(
  sessionId: string,
  queryText: string,
  limit: number
): Promise<NaturalLanguageMemoryEntry[]> {
  const sessionPrefixPattern = `${buildSessionKeyPrefix(sessionId)}%`;
  const wildcardQuery = `%${escapeSqlLikePattern(queryText)}%`;
  const result = await query(
    `SELECT key, value, created_at, updated_at
     FROM memory
     WHERE key ILIKE $1
       AND (key ILIKE $2 ESCAPE '\\' OR value::text ILIKE $2 ESCAPE '\\')
     ORDER BY updated_at DESC
     LIMIT $3`,
    [sessionPrefixPattern, wildcardQuery, limit]
  );

  return normalizeMemoryTableRows(result.rows as MemoryTableRow[]);
}

/**
 * Escape SQL ILIKE wildcard metacharacters for literal query matching.
 * Inputs/outputs: user lookup query -> escaped pattern-safe query.
 * Edge cases: backslashes are escaped first to preserve literal semantics.
 */
function escapeSqlLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Normalize lookup query text for deterministic DB and RAG retrieval.
 * Inputs/outputs: raw query text -> sanitized bounded query.
 * Edge cases: control characters collapse to spaces.
 */
function normalizeLookupQueryText(rawQuery: string): string {
  const normalized = rawQuery.replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (normalized.length <= MAX_LOOKUP_QUERY_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, MAX_LOOKUP_QUERY_LENGTH);
}

/**
 * Normalize DB memory rows into envelope-unwrapped memory entries.
 * Inputs/outputs: raw DB rows -> stable entry structure.
 * Edge cases: legacy non-envelope rows map metadata to null.
 */
function normalizeMemoryTableRows(rows: MemoryTableRow[]): NaturalLanguageMemoryEntry[] {
  return rows.map((row) => {
    const { payload, metadata } = unwrapVersionedMemoryEnvelope<unknown>(row.value);
    return {
      recordId: normalizeExactMemoryRecordId(row.id),
      key: row.key,
      value: payload,
      metadata: metadata ? (metadata as unknown as Record<string, unknown>) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  });
}

function normalizeExactMemoryRecordId(rawRecordId: unknown): number | null {
  const numericRecordId =
    typeof rawRecordId === 'number'
      ? rawRecordId
      : typeof rawRecordId === 'string'
        ? Number.parseInt(rawRecordId, 10)
        : Number.NaN;

  return Number.isInteger(numericRecordId) && numericRecordId > 0 ? numericRecordId : null;
}

/**
 * Convert RAG query matches into memory entry shape for unified API responses.
 * Inputs/outputs: RAG matches -> synthetic memory entries.
 * Edge cases: missing memoryKey metadata uses deterministic rag:* fallback key.
 */
function normalizeRagMatchesToEntries(matches: RagQueryMatch[]): NaturalLanguageMemoryEntry[] {
  return matches.map((match) => {
    const metadata = match.metadata ?? {};
    const metadataRecord = metadata as Record<string, unknown>;
    const explicitKey = typeof metadataRecord.memoryKey === 'string' ? metadataRecord.memoryKey.trim() : '';
    const key = explicitKey || `rag:${match.id}`;
    const timestamp = extractTimestampFromMetadata(metadataRecord);

    return {
      key,
      value: {
        text: match.content,
        source: match.url,
        ragScore: Number(match.score.toFixed(6))
      },
      metadata: {
        ...metadataRecord,
        ragScore: match.score,
        ragDocId: match.id,
        ragSource: match.url
      },
      created_at: timestamp,
      updated_at: timestamp
    };
  });
}

/**
 * Resolve timestamp from metadata payload with robust fallbacks.
 * Inputs/outputs: metadata record -> ISO timestamp string.
 * Edge cases: invalid/missing timestamp falls back to current ISO time.
 */
function extractTimestampFromMetadata(metadata: Record<string, unknown>): string {
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
 * Merge DB-backed memory rows with synthetic RAG rows while deduplicating by key.
 * Inputs/outputs: primary DB entries + semantic entries + limit -> bounded merged list.
 * Edge cases: DB rows always win on duplicate keys to preserve exact payloads.
 */
function mergeMemoryEntries(
  databaseEntries: NaturalLanguageMemoryEntry[],
  ragEntries: NaturalLanguageMemoryEntry[],
  limit: number
): NaturalLanguageMemoryEntry[] {
  const merged = [...databaseEntries];
  const seenKeys = new Set(databaseEntries.map((entry) => entry.key));

  for (const ragEntry of ragEntries) {
    //audit Assumption: duplicate keys should favor authoritative DB rows; failure risk: semantic row overwriting exact value; expected invariant: exact DB results retain precedence; handling strategy: skip rag duplicates.
    if (seenKeys.has(ragEntry.key)) {
      continue;
    }
    merged.push(ragEntry);
    seenKeys.add(ragEntry.key);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged.slice(0, limit);
}

/**
 * Build a disabled RAG result marker for exact/non-semantic flows.
 * Inputs/outputs: reason string -> standardized RAG diagnostics payload.
 * Edge cases: none.
 */
function disabledRagResult(reason: string): NaturalLanguageMemoryRagResult {
  return {
    active: false,
    mode: 'disabled',
    reason,
    matches: [],
    diagnostics: {
      enabled: false,
      reason,
      candidateCount: 0,
      returnedCount: 0,
      sessionFilterApplied: false,
      sessionFallbackApplied: false,
      sourceTypeFilterApplied: true,
      minScore: MEMORY_RAG_MIN_SCORE,
      limit: DEFAULT_LOOKUP_LIMIT
    }
  };
}

interface RagFallbackResolution {
  entries: NaturalLanguageMemoryEntry[];
  rag: NaturalLanguageMemoryRagResult;
}

/**
 * Execute semantic RAG fallback retrieval for natural-language memory commands.
 * Inputs/outputs: query/session/limit -> normalized RAG-backed entries and diagnostics.
 * Edge cases: retrieval failures are converted into disabled diagnostics payload.
 */
async function resolveRagFallbackEntries(options: {
  queryText: string;
  sessionId: string;
  limit: number;
  allowSessionFallback?: boolean;
}): Promise<RagFallbackResolution> {
  const normalizedQuery = normalizeLookupQueryText(options.queryText);
  if (!normalizedQuery) {
    return {
      entries: [],
      rag: disabledRagResult('empty_query')
    };
  }

  try {
    const ragResult = await queryRagDocuments(normalizedQuery, {
      limit: options.limit,
      minScore: MEMORY_RAG_MIN_SCORE,
      sessionId: options.sessionId,
      sourceTypes: RAG_SOURCE_TYPES,
      allowSessionFallback: options.allowSessionFallback
    });

    const entries = normalizeRagMatchesToEntries(ragResult.matches);
    return {
      entries,
      rag: {
        active: ragResult.matches.length > 0,
        mode: ragResult.matches.length > 0 ? 'fallback' : 'supplemental',
        reason: ragResult.diagnostics.reason,
        matches: ragResult.matches.map((match) => ({
          key: typeof match.metadata?.memoryKey === 'string' ? match.metadata.memoryKey : `rag:${match.id}`,
          source: match.url,
          score: Number(match.score.toFixed(6)),
          docId: match.id
        })),
        diagnostics: cloneDiagnostics(ragResult.diagnostics)
      }
    };
  } catch {
    //audit Assumption: semantic fallback failures must not break exact memory retrieval; failure risk: command-level failures on optional RAG layer; expected invariant: memory command still returns deterministic response; handling strategy: disabled diagnostics fallback.
    memoryLogger.warn('RAG fallback resolution failed for natural-language memory command', {
      operation: 'resolveRagFallbackEntries',
      sessionId: options.sessionId
    });
    return {
      entries: [],
      rag: disabledRagResult('retrieval_error')
    };
  }
}

/**
 * Clone diagnostics into response-safe object shape.
 * Inputs/outputs: RAG diagnostics -> mutable plain object copy.
 * Edge cases: none.
 */
function cloneDiagnostics(diagnostics: RagQueryDiagnostics): NaturalLanguageMemoryRagResult['diagnostics'] {
  return {
    enabled: diagnostics.enabled,
    reason: diagnostics.reason,
    candidateCount: diagnostics.candidateCount,
    returnedCount: diagnostics.returnedCount,
    sessionFilterApplied: diagnostics.sessionFilterApplied,
    sessionFallbackApplied: diagnostics.sessionFallbackApplied,
    sourceTypeFilterApplied: diagnostics.sourceTypeFilterApplied,
    minScore: diagnostics.minScore,
    limit: diagnostics.limit
  };
}

/**
 * Extract a storage label from structured natural-language memory payloads.
 * Inputs/outputs: raw prompt text -> raw storage label or null.
 * Edge cases: missing/blank labels return null.
 */
export function extractNaturalLanguageStorageLabel(rawInput: string): string | null {
  const labelMatch = rawInput.match(STORAGE_LABEL_LINE_PATTERN);
  if (!labelMatch?.[1]) {
    return null;
  }

  const trimmedLabel = labelMatch[1].trim();
  return trimmedLabel.length > 0 ? trimmedLabel : null;
}

/**
 * Resolve a storage-label alias back to the canonical session id when one has been registered.
 * Inputs/outputs: raw alias candidate -> canonical session id or null.
 * Edge cases: malformed aliases or missing pointers return null without throwing.
 */
export async function resolveNaturalLanguageSessionAlias(rawAlias: unknown): Promise<string | null> {
  const normalizedAlias = normalizeNaturalLanguageStorageLabel(rawAlias);
  if (!normalizedAlias) {
    return null;
  }

  const aliasPayload = await loadMemory(buildSessionLabelPointerKey(normalizedAlias));
  if (typeof aliasPayload === 'string' && aliasPayload.trim()) {
    return normalizeNaturalLanguageSessionId(aliasPayload);
  }

  if (
    aliasPayload &&
    typeof aliasPayload === 'object' &&
    'sessionId' in aliasPayload &&
    typeof (aliasPayload as { sessionId?: unknown }).sessionId === 'string'
  ) {
    return normalizeNaturalLanguageSessionId((aliasPayload as { sessionId: string }).sessionId);
  }

  return null;
}

/**
 * Resolve the effective session id for a natural-language command, including storage-label aliases.
 * Inputs/outputs: natural-language request -> canonical normalized session id.
 * Edge cases: unknown aliases fall back to direct session-id normalization.
 */
async function resolveRequestedSessionId(request: NaturalLanguageMemoryRequest): Promise<string> {
  const inlineSessionId = extractNaturalLanguageSessionId(request.input);
  const rawTransportSessionId =
    typeof request.sessionId === 'string' && request.sessionId.trim().length > 0
      ? request.sessionId.trim()
      : null;
  const rawStorageLabel = extractNaturalLanguageStorageLabel(request.input);

  for (const aliasCandidate of [rawStorageLabel, rawTransportSessionId, inlineSessionId]) {
    //audit Assumption: storage labels should resolve to the canonical session id before fallback normalization; failure risk: `Recall: RAW_Vancouver_Session` becomes a brand-new empty session namespace; expected invariant: saved label aliases round-trip to the originating session id; handling strategy: check persisted alias pointers in priority order and short-circuit on the first match.
    const resolvedAliasSessionId = await resolveNaturalLanguageSessionAlias(aliasCandidate);
    if (resolvedAliasSessionId) {
      return resolvedAliasSessionId;
    }
  }

  return normalizeNaturalLanguageSessionId(rawTransportSessionId ?? inlineSessionId);
}

/**
 * Normalize storage labels into the alias-key token space.
 * Inputs/outputs: raw storage label -> normalized alias token or null.
 * Edge cases: blank/invalid labels resolve to null so alias pointers are not created accidentally.
 */
function normalizeNaturalLanguageStorageLabel(rawLabel: unknown): string | null {
  if (typeof rawLabel !== 'string') {
    return null;
  }

  const trimmedLabel = rawLabel.trim();
  if (!trimmedLabel) {
    return null;
  }

  const normalizedLabel = normalizeNaturalLanguageSessionId(trimmedLabel);
  return normalizedLabel === DEFAULT_SESSION_ID ? null : normalizedLabel;
}

function normalizeExactMemoryTag(rawTag: unknown): string | null {
  if (typeof rawTag !== 'string') {
    return null;
  }

  const trimmedTag = rawTag.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!trimmedTag) {
    return null;
  }

  //audit Assumption: exact tag selectors should stay short enough for deterministic literal SQL matching; failure risk: very large pasted payload lines become accidental "tags" and degrade search; expected invariant: selector tags stay bounded; handling strategy: trim and clamp to a safe fixed length.
  return trimmedTag.slice(0, 120);
}

function describeExactNaturalLanguageMemorySelector(selector: ExactNaturalLanguageMemorySelector): string {
  const descriptorParts: string[] = [];

  if (typeof selector.recordId === 'number') {
    descriptorParts.push(`record id ${selector.recordId}`);
  }

  if (typeof selector.tag === 'string' && selector.tag.trim()) {
    descriptorParts.push(`tag ${selector.tag}`);
  }

  return descriptorParts.join(' and ') || 'the requested selector';
}

/**
 * Decide whether a token looks like a machine-style session identifier instead of normal prose.
 * Inputs/outputs: raw token -> boolean.
 * Edge cases: plain words return false; identifiers with digits, underscores, or hyphens return true.
 */
function isStructuredSessionIdentifier(rawToken: unknown): boolean {
  if (typeof rawToken !== 'string') {
    return false;
  }

  const trimmedToken = rawToken.trim();
  if (!trimmedToken) {
    return false;
  }

  //audit Assumption: fallback `for/of <token>` extraction must not capture ordinary prose nouns; failure risk: prompts like "save this for monday" accidentally become new session ids; expected invariant: only machine-like identifiers are accepted; handling strategy: require visible structural markers such as digits, underscores, or hyphens.
  return /[_-]/.test(trimmedToken) || /\d/.test(trimmedToken);
}

/**
 * Build the pointer key used to map storage labels back to canonical session ids.
 * Inputs/outputs: normalized storage label token -> pointer key string.
 * Edge cases: none.
 */
function buildSessionLabelPointerKey(normalizedStorageLabel: string): string {
  return `${SESSION_LABEL_POINTER_KEY_PREFIX}:${normalizedStorageLabel}`;
}

/**
 * Persist a storage-label pointer when a structured session payload declares one.
 * Inputs/outputs: session id plus optional raw storage label -> pointer row persisted as a side effect.
 * Edge cases: blank or invalid labels are ignored so saves stay idempotent.
 */
async function updateSessionLabelPointer(params: {
  sessionId: string;
  storageLabel: string | null;
}): Promise<void> {
  const normalizedStorageLabel = normalizeNaturalLanguageStorageLabel(params.storageLabel);
  if (!normalizedStorageLabel || !params.storageLabel) {
    return;
  }

  const pointerPayload: SessionLabelPointerPayload = {
    sessionId: params.sessionId,
    storageLabel: params.storageLabel,
    updatedAt: new Date().toISOString()
  };

  await saveMemory(buildSessionLabelPointerKey(normalizedStorageLabel), pointerPayload);
}

function normalizeSessionIdCandidate(rawCandidate: unknown): string | null {
  if (typeof rawCandidate !== 'string') {
    return null;
  }

  const trimmedCandidate = rawCandidate.trim();
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(trimmedCandidate)) {
    return null;
  }

  const normalizedCandidate = normalizeNaturalLanguageSessionId(trimmedCandidate);
  //audit Assumption: reserved memory verbs and nouns are not valid standalone session identifiers; failure risk: prose like "latest" gets misread as a session name; expected invariant: only caller-intended opaque tokens survive extraction; handling strategy: reject reserved tokens after normalization.
  if (RESERVED_SESSION_ID_TOKENS.has(normalizedCandidate)) {
    return null;
  }

  return normalizedCandidate;
}

import crypto from 'node:crypto';

import {
  loadRecentSelfReflectionsByCategory,
  saveSelfReflection,
  type SelfReflectionRecord
} from "@core/db/repositories/selfReflectionRepository.js";
import { getReinforcementConfig, registerContextEntry } from "@services/contextualReinforcement.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { getEnvNumber } from "@platform/runtime/env.js";
import type {
  ClearScoreScale,
  JudgedResponsePayload,
  JudgedResponseResult
} from "@shared/types/reinforcement.js";

const JUDGED_RESPONSE_REFLECTION_CATEGORY = 'judged-response';
const MAX_PROMPT_LENGTH = 10_000;
const MAX_RESPONSE_LENGTH = 20_000;
const MAX_FEEDBACK_LENGTH = 2_000;
const MAX_IMPROVEMENTS = 25;
const DEFAULT_HYDRATION_LIMIT = 20;
const JUDGED_IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1_000;
const IDENTITY_HASH_LENGTH = 16;
const DEFAULT_JUDGED_CACHE_MAX_ENTRIES = 2_000;
const JUDGED_CACHE_MAX_ENTRIES = Math.max(
  1,
  Math.floor(getEnvNumber('JUDGED_FEEDBACK_CACHE_MAX_ENTRIES', DEFAULT_JUDGED_CACHE_MAX_ENTRIES))
);
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_KEYS_PER_OBJECT = 200;
const MAX_METADATA_ARRAY_ITEMS = 200;
const DANGEROUS_METADATA_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

let hasHydratedJudgedFeedbackContext = false;

export interface JudgedFeedbackRuntimeTelemetry {
  attempts: number;
  duplicatesSkipped: number;
  persistedWrites: number;
  persistenceFailures: number;
  cacheEvictions: number;
  cacheSize: number;
  cacheMaxEntries: number;
  idempotencyWindowMs: number;
  lastEventAt: string | null;
}

interface CachedJudgedResult {
  storedAtMs: number;
  result: JudgedResponseResult;
}

const recentJudgedResultByIdempotencyKey = new Map<string, CachedJudgedResult>();
const judgedFeedbackRuntimeTelemetry: JudgedFeedbackRuntimeTelemetry = {
  attempts: 0,
  duplicatesSkipped: 0,
  persistedWrites: 0,
  persistenceFailures: 0,
  cacheEvictions: 0,
  cacheSize: 0,
  cacheMaxEntries: JUDGED_CACHE_MAX_ENTRIES,
  idempotencyWindowMs: JUDGED_IDEMPOTENCY_WINDOW_MS,
  lastEventAt: null
};

interface NormalizedJudgedPayload {
  requestId: string;
  prompt: string;
  response: string;
  feedback?: string;
  judge?: string;
  score: number;
  scoreScale: ClearScoreScale;
  normalizedScore: number;
  accepted: boolean;
  improvements: string[];
  metadata: Record<string, unknown>;
}

/**
 * Process judged response feedback, store it, and feed it back into prompt reinforcement.
 *
 * Purpose: turn explicit human/system judgments into reusable context for better response quality.
 * Inputs/outputs: judged payload + fallback trace id -> normalized persisted judgment result.
 * Edge cases: throws on invalid payload fields and still returns `persisted=false` if DB write fails.
 */
export async function processJudgedResponseFeedback(
  payload: JudgedResponsePayload,
  fallbackTraceId: string
): Promise<JudgedResponseResult> {
  const normalizedPayload = normalizeJudgedResponsePayload(payload, fallbackTraceId);
  const sourceEndpoint = extractSourceEndpoint(normalizedPayload.metadata);
  const idempotencyKey = buildJudgedFeedbackIdempotencyKey(normalizedPayload);
  const nowMs = Date.now();

  judgedFeedbackRuntimeTelemetry.attempts += 1;
  judgedFeedbackRuntimeTelemetry.lastEventAt = new Date(nowMs).toISOString();

  const duplicateResult = getCachedJudgedResult(idempotencyKey, nowMs);
  //audit Assumption: repeated judged writes for the same content within a short window are accidental loops; risk: duplicate persistence and reinforcement drift; invariant: idempotency key collapses duplicates; handling: return cached result and skip side effects.
  if (duplicateResult) {
    judgedFeedbackRuntimeTelemetry.duplicatesSkipped += 1;
    logger.info(
      '[🧠 Reinforcement] Skipping duplicate judged-response persistence',
      {
        module: 'judged-feedback',
        operation: 'idempotency-skip',
        requestId: normalizedPayload.requestId
      },
      {
        idempotencyKey,
        sourceEndpoint
      }
    );
    judgedFeedbackRuntimeTelemetry.cacheSize = recentJudgedResultByIdempotencyKey.size;
    return duplicateResult;
  }

  const contextSummary = buildJudgedContextSummary(normalizedPayload);

  registerContextEntry({
    source: 'audit',
    summary: contextSummary,
    requestId: normalizedPayload.requestId,
    metadata: {
      kind: JUDGED_RESPONSE_REFLECTION_CATEGORY,
      accepted: normalizedPayload.accepted,
      score: normalizedPayload.score,
      scoreScale: normalizedPayload.scoreScale,
      normalizedScore: normalizedPayload.normalizedScore
    },
    //audit Assumption: accepted judgments should bias future output positively and rejected judgments negatively; risk: inverted learning signal; invariant: bias aligns with acceptance state; handling: deterministic accepted->positive mapping.
    bias: normalizedPayload.accepted ? 'positive' : 'negative',
    score: normalizedPayload.normalizedScore
  });

  let persisted = true;
  try {
    await saveSelfReflection({
      priority: mapNormalizedScoreToPriority(normalizedPayload.normalizedScore),
      category: JUDGED_RESPONSE_REFLECTION_CATEGORY,
      content: normalizedPayload.response,
      improvements: normalizedPayload.improvements,
      metadata: {
        kind: JUDGED_RESPONSE_REFLECTION_CATEGORY,
        requestId: normalizedPayload.requestId,
        prompt: sanitizeJudgedText(normalizedPayload.prompt),
        response: sanitizeJudgedText(normalizedPayload.response),
        feedback: normalizedPayload.feedback,
        judge: normalizedPayload.judge,
        score: normalizedPayload.score,
        scoreScale: normalizedPayload.scoreScale,
        normalizedScore: normalizedPayload.normalizedScore,
        accepted: normalizedPayload.accepted,
        ...normalizedPayload.metadata
      }
    });
    judgedFeedbackRuntimeTelemetry.persistedWrites += 1;
  } catch (error) {
    //audit Assumption: persistence failure should not drop in-memory reinforcement for this process; risk: historical judgment loss across restarts; invariant: caller still receives accepted/scoring result; handling: report persisted=false.
    persisted = false;
    judgedFeedbackRuntimeTelemetry.persistenceFailures += 1;
    console.warn('[🧠 Reinforcement] Failed to persist judged response feedback:', resolveErrorMessage(error));
  }

  const result: JudgedResponseResult = {
    traceId: normalizedPayload.requestId,
    accepted: normalizedPayload.accepted,
    score: normalizedPayload.score,
    scoreScale: normalizedPayload.scoreScale,
    normalizedScore: normalizedPayload.normalizedScore,
    persisted
  };

  cacheJudgedResult(idempotencyKey, result, nowMs);
  judgedFeedbackRuntimeTelemetry.cacheSize = recentJudgedResultByIdempotencyKey.size;
  return result;
}

/**
 * Hydrate reinforcement context from recent persisted judged responses.
 *
 * Purpose: restore response-quality learning signals after process restarts.
 * Inputs/outputs: optional max entry count -> count of hydrated entries.
 * Edge cases: idempotent by default and returns zero when no persisted judgments are available.
 */
export async function hydrateJudgedResponseFeedbackContext(limit: number = DEFAULT_HYDRATION_LIMIT): Promise<number> {
  //audit Assumption: startup hydration should run once per process by default; risk: duplicate context entries degrade prompt quality; invariant: repeated calls without explicit reset do nothing; handling: guard with module-level flag.
  if (hasHydratedJudgedFeedbackContext) {
    return 0;
  }

  const sanitizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const reflections = await loadRecentSelfReflectionsByCategory(
    JUDGED_RESPONSE_REFLECTION_CATEGORY,
    sanitizedLimit
  );

  let hydratedCount = 0;
  for (const reflection of reflections.reverse()) {
    const hydrated = hydrateContextFromPersistedReflection(reflection);
    if (hydrated) {
      hydratedCount += 1;
    }
  }

  hasHydratedJudgedFeedbackContext = true;
  return hydratedCount;
}

/**
 * Reset judged feedback hydration guard (test utility).
 *
 * Purpose: allow isolated tests to re-run hydration logic deterministically.
 * Inputs/outputs: no inputs and no output.
 * Edge cases: only affects in-process module state.
 */
export function resetJudgedFeedbackHydrationState(): void {
  hasHydratedJudgedFeedbackContext = false;
}

/**
 * Read judged-feedback runtime telemetry snapshot.
 *
 * Purpose: expose lightweight counters for duplicate suppression and persistence outcomes.
 * Inputs/outputs: no inputs -> immutable telemetry snapshot object.
 * Edge cases: counters are process-local and reset on restart.
 */
export function getJudgedFeedbackRuntimeTelemetry(): JudgedFeedbackRuntimeTelemetry {
  return {
    ...judgedFeedbackRuntimeTelemetry,
    cacheSize: recentJudgedResultByIdempotencyKey.size,
    cacheMaxEntries: JUDGED_CACHE_MAX_ENTRIES,
    idempotencyWindowMs: JUDGED_IDEMPOTENCY_WINDOW_MS
  };
}

function hydrateContextFromPersistedReflection(reflection: SelfReflectionRecord): boolean {
  const metadata = reflection.metadata ?? {};
  const accepted = Boolean(metadata.accepted);
  const score = typeof metadata.normalizedScore === 'number' ? metadata.normalizedScore : undefined;
  const requestId = typeof metadata.requestId === 'string' && metadata.requestId.trim().length > 0
    ? metadata.requestId
    : reflection.id;

  //audit Assumption: persisted judged reflections include enough metadata for meaningful summaries; risk: malformed legacy records creating noisy context; invariant: malformed records are skipped; handling: validate summary inputs and return false when unusable.
  const summary = buildHydratedContextSummary(reflection, accepted, score);
  if (!summary) {
    return false;
  }

  registerContextEntry({
    source: 'audit',
    summary,
    requestId,
    metadata: {
      kind: JUDGED_RESPONSE_REFLECTION_CATEGORY,
      accepted,
      loadedFromPersistence: true,
      reflectionId: reflection.id
    },
    bias: accepted ? 'positive' : 'negative',
    score,
    patternId: reflection.id
  });
  return true;
}

function buildHydratedContextSummary(
  reflection: SelfReflectionRecord,
  accepted: boolean,
  score: number | undefined
): string | null {
  const feedbackValue = reflection.metadata?.feedback;
  const feedback = typeof feedbackValue === 'string' ? feedbackValue.trim() : '';
  const normalizedScoreText = typeof score === 'number' ? score.toFixed(2) : 'n/a';
  const baseSummary =
    `Judged response (${accepted ? 'accepted' : 'rejected'}) normalized score=${normalizedScoreText}.`;

  if (!feedback && reflection.improvements.length === 0) {
    return baseSummary;
  }

  const improvementSummary = reflection.improvements.length > 0
    ? `Improvements: ${reflection.improvements.slice(0, 5).join(' | ')}.`
    : '';
  const feedbackSummary = feedback ? `Feedback: ${truncateText(feedback, MAX_FEEDBACK_LENGTH)}.` : '';
  const combined = [baseSummary, feedbackSummary, improvementSummary].filter(Boolean).join(' ');
  return combined.trim().length > 0 ? combined : null;
}

function normalizeJudgedResponsePayload(
  payload: JudgedResponsePayload,
  fallbackTraceId: string
): NormalizedJudgedPayload {
  //audit Assumption: endpoint receives object payloads; risk: null/primitive payloads bypass validation; invariant: payload object required; handling: throw explicit error.
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Judged response payload must be an object');
  }

  const requestId =
    typeof payload.requestId === 'string' && payload.requestId.trim().length > 0
      ? payload.requestId.trim()
      : fallbackTraceId;
  const prompt = requireNonEmptyText(payload.prompt, 'prompt', MAX_PROMPT_LENGTH);
  const response = requireNonEmptyText(payload.response, 'response', MAX_RESPONSE_LENGTH);
  const score = normalizeFiniteNumber(payload.score, 'score');
  const scoreScale = resolveClearScoreScale(score, payload.scoreScale);
  const normalizedScore = normalizeClearScoreForThreshold(score, scoreScale, getReinforcementConfig().minimumClearScore);
  const accepted = normalizedScore >= getReinforcementConfig().minimumClearScore;
  const improvements = normalizeImprovements(payload.improvements);

  //audit Assumption: metadata may contain nested untrusted keys and non-plain objects; risk: prototype pollution and serialization instability; invariant: persisted metadata is deeply sanitized and JSON-safe; handling: recursive sanitization with dangerous-key stripping.
  const metadata = sanitizeMetadataRecord(payload.metadata);

  const feedback = typeof payload.feedback === 'string' && payload.feedback.trim().length > 0
    ? truncateText(payload.feedback.trim(), MAX_FEEDBACK_LENGTH)
    : undefined;
  const judge = typeof payload.judge === 'string' && payload.judge.trim().length > 0
    ? payload.judge.trim()
    : undefined;

  return {
    requestId,
    prompt,
    response,
    feedback,
    judge,
    score,
    scoreScale,
    normalizedScore,
    accepted,
    improvements,
    metadata
  };
}

function buildJudgedContextSummary(normalizedPayload: NormalizedJudgedPayload): string {
  const baseSummary =
    `Judged response score ${normalizedPayload.score.toFixed(2)} (${normalizedPayload.scoreScale}, normalized ${normalizedPayload.normalizedScore.toFixed(2)}) -> ${normalizedPayload.accepted ? 'accepted' : 'rejected'}.`;

  if (!normalizedPayload.feedback && normalizedPayload.improvements.length === 0) {
    return baseSummary;
  }

  const feedbackSegment = normalizedPayload.feedback ? `Feedback: ${normalizedPayload.feedback}.` : '';
  const improvementSegment = normalizedPayload.improvements.length > 0
    ? `Improvements: ${normalizedPayload.improvements.slice(0, 5).join(' | ')}.`
    : '';
  return [baseSummary, feedbackSegment, improvementSegment].filter(Boolean).join(' ').trim();
}

function requireNonEmptyText(value: unknown, fieldName: string, maxLength: number): string {
  //audit Assumption: judged payload text fields are required for meaningful learning; risk: empty text creates noisy/low-signal records; invariant: trimmed non-empty string returned; handling: strict validation + truncation.
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Judged response payload field "${fieldName}" must be a non-empty string`);
  }
  return truncateText(value.trim(), maxLength);
}

function normalizeFiniteNumber(value: unknown, fieldName: string): number {
  //audit Assumption: score must be numeric; risk: NaN/non-numeric values break acceptance gating; invariant: finite number returned; handling: throw validation error.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Judged response payload field "${fieldName}" must be a finite number`);
  }
  return value;
}

function normalizeImprovements(improvements: unknown): string[] {
  if (!Array.isArray(improvements)) {
    return [];
  }
  return improvements
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0)
    .slice(0, MAX_IMPROVEMENTS);
}

function resolveClearScoreScale(score: number, declaredScale?: ClearScoreScale): ClearScoreScale {
  if (declaredScale === '0-1' || declaredScale === '0-10') {
    return declaredScale;
  }

  //audit Assumption: scores <=1 are normalized scale by default; risk: ambiguous scale for low 0-10 scores; invariant: deterministic inference; handling: use threshold heuristic.
  if (score <= 1) {
    return '0-1';
  }
  return '0-10';
}

function normalizeClearScoreForThreshold(
  score: number,
  scoreScale: ClearScoreScale,
  minimumClearScore: number
): number {
  const minimumScale: ClearScoreScale = minimumClearScore <= 1 ? '0-1' : '0-10';
  if (scoreScale === minimumScale) {
    return score;
  }
  if (scoreScale === '0-10' && minimumScale === '0-1') {
    return score / 10;
  }
  return score * 10;
}

function mapNormalizedScoreToPriority(normalizedScore: number): 'high' | 'medium' | 'low' {
  //audit Assumption: reinforcement minimum score can be configured in either 0-1 or 0-10 scale; risk: wrong priority mapping if scale misunderstood; invariant: normalized score converted to 0-10 before mapping; handling: explicit conversion branch.
  const asTenPointScore = normalizedScore <= 1 ? normalizedScore * 10 : normalizedScore;
  if (asTenPointScore >= 8) {
    return 'high';
  }
  if (asTenPointScore >= 5) {
    return 'medium';
  }
  return 'low';
}

function buildJudgedFeedbackIdempotencyKey(payload: NormalizedJudgedPayload): string {
  //audit Assumption: stable hash identity should include request + normalized judgment content; risk: collisions skipping distinct writes; invariant: deterministic key for semantically identical judged records; handling: include request, judge, scores, and content digests.
  const promptDigest = crypto
    .createHash('sha256')
    .update(payload.prompt)
    .digest('hex')
    .slice(0, IDENTITY_HASH_LENGTH);
  const responseDigest = crypto
    .createHash('sha256')
    .update(payload.response)
    .digest('hex')
    .slice(0, IDENTITY_HASH_LENGTH);
  const judgeIdentity = payload.judge ?? 'unknown';
  return [
    payload.requestId,
    judgeIdentity,
    payload.scoreScale,
    payload.score.toFixed(3),
    promptDigest,
    responseDigest
  ].join('|');
}

function getCachedJudgedResult(idempotencyKey: string, nowMs: number): JudgedResponseResult | null {
  purgeExpiredJudgedResults(nowMs);
  const cached = recentJudgedResultByIdempotencyKey.get(idempotencyKey);
  if (!cached) {
    return null;
  }
  return cached.result;
}

function cacheJudgedResult(idempotencyKey: string, result: JudgedResponseResult, nowMs: number): void {
  purgeExpiredJudgedResults(nowMs);
  enforceJudgedCacheCapacity();
  recentJudgedResultByIdempotencyKey.set(idempotencyKey, {
    storedAtMs: nowMs,
    result
  });
}

function purgeExpiredJudgedResults(nowMs: number): void {
  for (const [key, cached] of recentJudgedResultByIdempotencyKey.entries()) {
    //audit Assumption: stale cache entries no longer useful for loop suppression; risk: unbounded memory growth; invariant: cache entries remain within TTL window; handling: periodic purge on read/write.
    if (nowMs - cached.storedAtMs > JUDGED_IDEMPOTENCY_WINDOW_MS) {
      recentJudgedResultByIdempotencyKey.delete(key);
    }
  }
}

function enforceJudgedCacheCapacity(): void {
  //audit Assumption: idempotency cache should stay bounded under high cardinality traffic; risk: unbounded memory growth; invariant: entry count remains below configured max; handling: evict oldest entries before inserts.
  while (recentJudgedResultByIdempotencyKey.size >= JUDGED_CACHE_MAX_ENTRIES) {
    const oldestKey = recentJudgedResultByIdempotencyKey.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    recentJudgedResultByIdempotencyKey.delete(oldestKey);
    judgedFeedbackRuntimeTelemetry.cacheEvictions += 1;
  }
}

function extractSourceEndpoint(metadata: Record<string, unknown>): string | undefined {
  const sourceEndpointValue = metadata.sourceEndpoint;
  if (typeof sourceEndpointValue !== 'string') {
    return undefined;
  }
  const trimmed = sourceEndpointValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeJudgedText(value: string): string {
  //audit Assumption: judged text may include raw secrets from prompt/response traces; risk: sensitive persistence leakage; invariant: known secret patterns are masked before DB write; handling: deterministic regex redaction.
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_OPENAI_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, '[REDACTED_BEARER_TOKEN]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED]');
}

function sanitizeMetadataRecord(value: unknown): Record<string, unknown> {
  //audit Assumption: caller metadata can be absent or malformed; risk: unsafe object spread and unstable persistence; invariant: metadata is always a plain object record; handling: fallback to empty record when root is invalid.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const seenObjects = new WeakSet<object>();
  const sanitizedValue = sanitizeMetadataValue(value, 0, seenObjects);
  if (typeof sanitizedValue === 'object' && sanitizedValue !== null && !Array.isArray(sanitizedValue)) {
    return sanitizedValue as Record<string, unknown>;
  }
  return {};
}

function sanitizeMetadataValue(
  value: unknown,
  depth: number,
  seenObjects: WeakSet<object>
): unknown {
  //audit Assumption: recursive sanitization must terminate predictably; risk: deep/cyclic inputs causing stack or memory pressure; invariant: depth and cycle guards bound traversal; handling: truncate deep/cyclic branches.
  if (depth > MAX_METADATA_DEPTH) {
    return '[TRUNCATED_DEPTH]';
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'string') {
    return truncateText(sanitizeJudgedText(value), MAX_RESPONSE_LENGTH);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message
    };
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'object') {
    return String(value);
  }

  if (seenObjects.has(value)) {
    return '[CIRCULAR_REFERENCE]';
  }
  seenObjects.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map(item => sanitizeMetadataValue(item, depth + 1, seenObjects))
      .filter(item => item !== undefined);
  }

  //audit Assumption: non-plain objects may include class instances with hidden behaviors; risk: serializing unsafe internals; invariant: only plain records are traversed as objects; handling: coerce non-plain objects to string descriptors.
  if (!isPlainRecord(value)) {
    return Object.prototype.toString.call(value);
  }

  const sanitizedRecord: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_METADATA_KEYS_PER_OBJECT);
  for (const [rawKey, rawEntryValue] of entries) {
    if (DANGEROUS_METADATA_KEYS.has(rawKey)) {
      continue;
    }
    const sanitizedEntryValue = sanitizeMetadataValue(rawEntryValue, depth + 1, seenObjects);
    if (sanitizedEntryValue === undefined) {
      continue;
    }
    sanitizedRecord[rawKey] = sanitizedEntryValue;
  }
  return sanitizedRecord;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

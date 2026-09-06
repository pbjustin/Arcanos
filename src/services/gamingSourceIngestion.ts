import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  findOrCreateGptJob,
  getJobById,
  IdempotencyKeyConflictError,
  JobRepositoryUnavailableError
} from '@core/db/repositories/jobRepository.js';
import {
  GamingSourceRepositoryUnavailableError,
  getGamingSourceById,
  persistGamingSourceRevision
} from '@core/db/repositories/gamingSourceRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { buildQueuedGptJobInput } from '@shared/gpt/asyncGptJob.js';
import {
  buildGamingDocumentSearchText,
  classifyGamingDocumentQuality,
  classifyGamingStructuredExtractionQuality,
  detectGamingDocumentGame,
  selectGamingSourceAdmissionUrl,
  selectGamingSourcePublicUrl
} from '@shared/gaming/gamingDocumentIngestionCore.js';
import { truncateTextByCharacters } from '@shared/http/clientResponseCommon.js';
import { planAutonomousWorkerJob } from '@services/workerAutonomyService.js';

import { ingestGamingBuildResource } from './gamingBuildResources.js';
import {
  GAMING_DOCUMENT_RESOLVER_VERSION,
  describeGamingDocumentSource,
  resolveGamingDocument
} from './gamingDocumentResolution.js';
import {
  chunkGamingDocument,
  GAMING_DOCUMENT_CHUNKING_VERSION,
  GAMING_DURABLE_DOCUMENT_LIMITS,
  hashGamingDocumentRevision
} from './gamingDurableDocumentChunks.js';
import {
  GAMING_BUILD_RESOURCE_SCHEMA_VERSION,
  GAMING_BUILD_RESOURCE_HARD_LIMITS,
  GAMING_RESOURCE_TYPES,
  type GamingResourceType
} from './gamingBuildResourceSchema.js';
import { canonicalizeGamingGameName } from './gamingGameDetection.js';
import { sanitizeGamingDiscoveryCandidateUrl } from './gamingSourceDiscovery.js';
import { textContainsExactGamingVersion } from './gamingVersion.js';

import {
  retrieveStoredGamingKnowledge,
  type GamingStoredKnowledgeContext,
  type GamingStoredKnowledgeInput
} from './gamingStoredKnowledge.js';
export type { GamingStoredKnowledgeContext } from './gamingStoredKnowledge.js';
export const GAMING_SOURCE_INGESTION_REQUEST_PATH = '/gpt-access/gaming/sources/ingestions';
export const GAMING_SOURCE_REFRESH_REQUEST_PATH = '/gpt-access/gaming/sources/refreshes';
export const GAMING_SOURCE_INGESTION_REASON = 'gaming_source_ingestion';
export const GAMING_SOURCE_INGESTION_GPT_ID = 'arcanos-gaming';

const MAX_SOURCE_URLS = 4;
const MAX_TITLE_CHARS = 240;
const MIN_USEFUL_TEXT_CHARS = 120;
const IDEMPOTENCY_KEY_MAX_CHARS = 240;
const GAMING_SOURCE_OPERATION_ERROR_MAX_CHARS = 240;
const GAMING_PATCH_VERSION_MAX_CHARS = 64;
const SOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERIFIED_PATCH_METHODS = new Set([
  'extractor',
  'fetched_content_exact_match'
]);

const allowedSourceTypeHints = GAMING_RESOURCE_TYPES.filter(
  (value): value is Exclude<GamingResourceType, 'unknown'> => value !== 'unknown'
);

const sourceTypeHintSchema = z.enum(
  allowedSourceTypeHints as [Exclude<GamingResourceType, 'unknown'>, ...Array<Exclude<GamingResourceType, 'unknown'>>]
);

const ingestPayloadSchema = z.object({
  game: z.string().trim().min(1).max(120),
  sourceUrls: z.array(z.string().trim().min(1).max(2_048)).min(1).max(MAX_SOURCE_URLS),
  sourceTypeHint: sourceTypeHintSchema.optional(),
  patchVersion: z.string().trim().min(1).max(64).optional(),
  origin: z.enum(['user_supplied', 'gpt_web_search']).optional().default('user_supplied'),
  idempotencyKey: z.string().trim().min(8).max(IDEMPOTENCY_KEY_MAX_CHARS).optional()
}).strict();

const ingestRequestSchema = z.object({
  action: z.enum(['ingest']),
  payload: ingestPayloadSchema
}).strict();

const refreshPayloadSchema = z.object({
  sourceIds: z.array(z.string().trim().regex(SOURCE_ID_PATTERN)).min(1).max(MAX_SOURCE_URLS),
  idempotencyKey: z.string().trim().min(8).max(IDEMPOTENCY_KEY_MAX_CHARS).optional(),
  reason: z.enum(['user_requested', 'stale', 'patch_update']).optional().default('user_requested')
}).strict();

const refreshRequestSchema = z.object({
  action: z.enum(['refresh']),
  payload: refreshPayloadSchema
}).strict();

const queuedSourceSchema = z.object({
  submittedIndex: z.number().int().min(0).max(MAX_SOURCE_URLS - 1),
  canonicalUrl: z.string().url().max(2_048),
  game: z.string().trim().min(1).max(120),
  gameKey: z.string().trim().min(1).max(160),
  sourceId: z.string().regex(SOURCE_ID_PATTERN).optional(),
  sourceTypeHint: sourceTypeHintSchema.optional(),
  sourceTrustType: z.enum(['official', 'patch_notes', 'wiki', 'curated', 'supplied']).optional(),
  trustScore: z.number().min(0).max(1).optional(),
  patchVersion: z.string().trim().min(1).max(64).optional(),
  origin: z.enum(['user_supplied', 'gpt_web_search', 'refresh'])
}).strict();

const admissionErrorSchema = z.object({
  code: z.enum([
    'INVALID_URL',
    'UNSUPPORTED_SCHEME',
    'CREDENTIALS_NOT_ALLOWED',
    'URL_BLOCKED',
    'DUPLICATE_URL',
    'SOURCE_NOT_FOUND'
  ]),
  message: z.string().max(240),
  retryable: z.literal(false)
}).strict();

const rejectedSourceSchema = z.object({
  submittedIndex: z.number().int().min(0).max(MAX_SOURCE_URLS - 1),
  status: z.literal('rejected'),
  recordsCreated: z.literal(0),
  recordsUpdated: z.literal(0),
  error: admissionErrorSchema
}).strict();

const queuedGamingIngestionBodySchema = z.object({
  action: z.enum(['ingest', 'refresh']),
  schemaVersion: z.literal('1'),
  sources: z.array(queuedSourceSchema).min(1).max(MAX_SOURCE_URLS),
  rejectedSources: z.array(rejectedSourceSchema).max(MAX_SOURCE_URLS),
  submittedCount: z.number().int().min(1).max(MAX_SOURCE_URLS),
  refreshReason: z.enum(['user_requested', 'stale', 'patch_update']).optional()
}).strict();

type QueuedGamingSource = z.infer<typeof queuedSourceSchema>;
type RejectedGamingSource = z.infer<typeof rejectedSourceSchema>;
type QueuedGamingIngestionBody = z.infer<typeof queuedGamingIngestionBodySchema>;

export type GamingSourcePublicStatus =
  | 'queued'
  | 'running'
  | 'stored'
  | 'updated'
  | 'unchanged'
  | 'rejected'
  | 'failed';

export interface GamingSourcePublicError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface GamingSourceIngestionItemResult {
  submittedIndex: number;
  status: GamingSourcePublicStatus;
  canonicalUrl?: string;
  sourceId?: string;
  sourceType?: string;
  patchVersion?: string;
  recordsCreated: number;
  recordsUpdated: number;
  fetchedAt?: string;
  completedAt?: string;
  warnings?: string[];
  error?: GamingSourcePublicError;
}

export interface GamingSourceIngestionOutput {
  ok: true;
  action: 'ingest' | 'refresh' | 'status';
  ingestionId: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled' | 'expired';
  counts: {
    total: number;
    queued: number;
    succeeded: number;
    rejected: number;
    failed: number;
    recordsCreated: number;
    recordsUpdated: number;
  };
  sources: GamingSourceIngestionItemResult[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  requestId?: string;
  traceId?: string;
}

export interface GamingSourceGatewayContext {
  actorKey: string;
  requestId?: string;
  traceId?: string;
  idempotencyKey?: string | null;
  logger?: {
    info?: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
    error?: (event: string, data?: Record<string, unknown>) => void;
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function gamingSourceActorScopeHash(actorKey: string): string {
  return sha256(`${actorKey}\ngaming-source-ingestion`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function canonicalGameKey(game: string): string {
  return canonicalizeGamingGameName(game)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 160);
}

function publicAdmissionError(
  code: RejectedGamingSource['error']['code'],
  message: string
): RejectedGamingSource['error'] {
  return { code, message, retryable: false };
}

function rejectAdmission(
  submittedIndex: number,
  code: RejectedGamingSource['error']['code'],
  message: string
): RejectedGamingSource {
  return {
    submittedIndex,
    status: 'rejected',
    recordsCreated: 0,
    recordsUpdated: 0,
    error: publicAdmissionError(code, message)
  };
}

function admitUrl(
  rawUrl: string,
  submittedIndex: number,
  seenCanonicalUrls: Set<string>
): { source?: string; rejection?: RejectedGamingSource } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      rejection: rejectAdmission(submittedIndex, 'INVALID_URL', 'The source URL is malformed.')
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      rejection: rejectAdmission(
        submittedIndex,
        'UNSUPPORTED_SCHEME',
        'Gaming source ingestion accepts public HTTPS URLs only.'
      )
    };
  }
  if (parsed.username || parsed.password) {
    return {
      rejection: rejectAdmission(
        submittedIndex,
        'CREDENTIALS_NOT_ALLOWED',
        'Credentials are not allowed in source URLs.'
      )
    };
  }

  const sanitized = sanitizeGamingDiscoveryCandidateUrl(rawUrl);
  if (sanitized.rejected || !sanitized.url) {
    return {
      rejection: rejectAdmission(
        submittedIndex,
        'URL_BLOCKED',
        'The source URL did not pass the public gaming-source policy.'
      )
    };
  }

  const description = describeGamingDocumentSource(sanitized.url);
  const canonicalUrl = selectGamingSourceAdmissionUrl(sanitized.url, description);
  if (seenCanonicalUrls.has(canonicalUrl)) {
    return {
      rejection: rejectAdmission(
        submittedIndex,
        'DUPLICATE_URL',
        'The canonical source URL is duplicated in this request.'
      )
    };
  }
  seenCanonicalUrls.add(canonicalUrl);
  return { source: canonicalUrl };
}

function resolveExplicitIdempotencyKey(
  bodyKey: string | undefined,
  headerKey: string | null | undefined
): { key?: string; error?: string } {
  const normalizedBodyKey = bodyKey?.trim();
  const normalizedHeaderKey = headerKey?.trim();
  if (normalizedHeaderKey && (normalizedHeaderKey.length < 8 || normalizedHeaderKey.length > IDEMPOTENCY_KEY_MAX_CHARS)) {
    return { error: `Idempotency-Key must be 8-${IDEMPOTENCY_KEY_MAX_CHARS} characters.` };
  }
  if (normalizedBodyKey && normalizedHeaderKey && normalizedBodyKey !== normalizedHeaderKey) {
    return { error: 'payload.idempotencyKey must match the Idempotency-Key header.' };
  }
  const key = normalizedHeaderKey ?? normalizedBodyKey;
  return key ? { key } : { error: 'An idempotencyKey or Idempotency-Key header is required.' };
}

function buildQueuedCounts(body: QueuedGamingIngestionBody) {
  return {
    total: body.submittedCount,
    queued: body.sources.length,
    succeeded: 0,
    rejected: body.rejectedSources.length,
    failed: 0,
    recordsCreated: 0,
    recordsUpdated: 0
  };
}

function queuedSourceResults(body: QueuedGamingIngestionBody): GamingSourceIngestionItemResult[] {
  return [
    ...body.sources.map((source) => ({
      submittedIndex: source.submittedIndex,
      status: 'queued' as const,
      canonicalUrl: source.canonicalUrl,
      ...(source.sourceId ? { sourceId: source.sourceId } : {}),
      recordsCreated: 0,
      recordsUpdated: 0
    })),
    ...body.rejectedSources
  ].sort((left, right) => left.submittedIndex - right.submittedIndex);
}

function resolveVerifiedPatch(input: {
  claimedPatch?: string;
  extractedPatch?: string;
  fetchedEvidence: string;
}): { version: string; method: 'extractor' | 'fetched_content_exact_match' } | null {
  const extractedPatch = input.extractedPatch?.trim();
  if (extractedPatch) {
    if (extractedPatch.length > GAMING_PATCH_VERSION_MAX_CHARS) {
      return null;
    }
    return { version: extractedPatch, method: 'extractor' };
  }
  const claimedPatch = input.claimedPatch?.trim();
  if (
    claimedPatch
    && claimedPatch.length <= GAMING_PATCH_VERSION_MAX_CHARS
    && textContainsExactGamingVersion(input.fetchedEvidence, claimedPatch)
  ) {
    return {
      version: claimedPatch,
      method: 'fetched_content_exact_match'
    };
  }
  return null;
}

function readBoundedGamingPatchVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= GAMING_PATCH_VERSION_MAX_CHARS
    ? normalized
    : undefined;
}

function equalPatchVersion(left: unknown, right: string): boolean {
  return typeof left === 'string'
    && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function resolveVerifiedStoredPatch(record: {
  patch: string | null;
  revisionPatch: string | null;
  normalized?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}): string | undefined {
  const patchVersion = readBoundedGamingPatchVersion(
    record.patch ?? record.revisionPatch
  );
  if (!patchVersion) {
    return undefined;
  }
  const provenance = record.provenance ?? {};
  const provenanceMethod = provenance.patchVerificationMethod;
  if (
    typeof provenanceMethod === 'string'
    && VERIFIED_PATCH_METHODS.has(provenanceMethod)
    && equalPatchVersion(provenance.verifiedPatchVersion, patchVersion)
  ) {
    return patchVersion;
  }
  // Compatibility for revisions written before explicit verification metadata:
  // structured extractors already stored their independently parsed patch in
  // the normalized record, while caller-only generic records did not.
  return equalPatchVersion(record.normalized?.patch, patchVersion)
    ? patchVersion
    : undefined;
}

function projectBoundedPublicPatchVersion(
  source: GamingSourceIngestionItemResult
): GamingSourceIngestionItemResult {
  const projectedSource = { ...source };
  delete projectedSource.patchVersion;
  const patchVersion = readBoundedGamingPatchVersion(source.patchVersion);
  if (patchVersion) {
    projectedSource.patchVersion = patchVersion;
  }
  return projectedSource;
}

function terminalSourceResults(
  body: QueuedGamingIngestionBody,
  status: 'cancelled' | 'expired' | 'failed'
): GamingSourceIngestionItemResult[] {
  const message = status === 'cancelled'
    ? 'The ingestion was cancelled before a source result was recorded.'
    : status === 'expired'
      ? 'The ingestion expired before a source result was recorded.'
      : 'The ingestion failed before a source result was recorded.';
  return [
    ...body.sources.map((source) => ({
      submittedIndex: source.submittedIndex,
      status: 'failed' as const,
      canonicalUrl: source.canonicalUrl,
      ...(source.sourceId ? { sourceId: source.sourceId } : {}),
      recordsCreated: 0,
      recordsUpdated: 0,
      error: {
        code: 'INTERNAL_ERROR',
        message,
        retryable: false
      }
    })),
    ...body.rejectedSources
  ].sort((left, right) => left.submittedIndex - right.submittedIndex);
}

function mapStoredJobStatus(status: string): GamingSourceIngestionOutput['status'] {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'completed':
      return 'completed';
    default:
      return 'failed';
  }
}

function isGamingIngestionQueuedInput(input: unknown): input is {
  gptId: string;
  body: QueuedGamingIngestionBody;
  requestPath: string;
  executionModeReason: string;
  requestId?: string;
  traceId?: string;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return record.gptId === GAMING_SOURCE_INGESTION_GPT_ID
    && record.executionModeReason === GAMING_SOURCE_INGESTION_REASON
    && (record.requestPath === GAMING_SOURCE_INGESTION_REQUEST_PATH
      || record.requestPath === GAMING_SOURCE_REFRESH_REQUEST_PATH)
    && queuedGamingIngestionBodySchema.safeParse(record.body).success;
}

export function parseQueuedGamingSourceIngestionBody(body: unknown):
  | { ok: true; value: QueuedGamingIngestionBody }
  | { ok: false; error: string } {
  const parsed = queuedGamingIngestionBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ')
    };
  }
  return { ok: true, value: parsed.data };
}

export function isQueuedGamingSourceIngestion(input: {
  gptId: string;
  requestPath?: string;
  executionModeReason?: string;
  body: Record<string, unknown>;
}): boolean {
  return input.gptId === GAMING_SOURCE_INGESTION_GPT_ID
    && input.executionModeReason === GAMING_SOURCE_INGESTION_REASON
    && (input.requestPath === GAMING_SOURCE_INGESTION_REQUEST_PATH
      || input.requestPath === GAMING_SOURCE_REFRESH_REQUEST_PATH)
    && queuedGamingIngestionBodySchema.safeParse(input.body).success;
}

function buildGatewayValidationError(message: string, sources?: RejectedGamingSource[]) {
  const boundedMessage = truncateTextByCharacters(
    message,
    GAMING_SOURCE_OPERATION_ERROR_MAX_CHARS
  );
  return {
    statusCode: sources && sources.length > 0 ? 422 : 400,
    payload: {
      ok: false,
      error: {
        code: sources && sources.length > 0
          ? 'GAMING_SOURCE_ADMISSION_REJECTED'
          : 'GAMING_SOURCE_VALIDATION_ERROR',
        message: boundedMessage
      },
      ...(sources ? { sources } : {})
    }
  };
}

async function enqueueGamingIngestion(
  body: QueuedGamingIngestionBody,
  idempotencyKey: string,
  context: GamingSourceGatewayContext
) {
  const traceId = context.traceId ?? context.requestId ?? sha256(`${context.actorKey}:${Date.now()}`).slice(0, 24);
  const requestPath = body.action === 'refresh'
    ? GAMING_SOURCE_REFRESH_REQUEST_PATH
    : GAMING_SOURCE_INGESTION_REQUEST_PATH;
  const queuedInput = buildQueuedGptJobInput({
    gptId: GAMING_SOURCE_INGESTION_GPT_ID,
    body,
    bypassIntentRouting: true,
    requestId: context.requestId ?? traceId,
    traceId,
    correlationId: traceId,
    routeHint: body.action,
    requestPath,
    executionModeReason: GAMING_SOURCE_INGESTION_REASON
  });
  const fingerprintHash = sha256(stableJson({
    action: body.action,
    sources: [...body.sources]
      .map((source) => ({
        canonicalUrl: source.canonicalUrl,
        gameKey: source.gameKey,
        sourceId: source.sourceId ?? null,
        sourceTypeHint: source.sourceTypeHint ?? null,
        patchVersion: source.patchVersion ?? null
      }))
      .sort((left, right) => left.canonicalUrl.localeCompare(right.canonicalUrl)),
    rejected: body.rejectedSources.map((source) => ({
      submittedIndex: source.submittedIndex,
      code: source.error.code
    })),
    refreshReason: body.refreshReason ?? null
  }));
  const scopeHash = gamingSourceActorScopeHash(context.actorKey);

  try {
    const plannedJob = await planAutonomousWorkerJob('gpt', queuedInput, { maxRetries: 2 });
    const created = await findOrCreateGptJob({
      workerId: process.env.WORKER_ID || 'gpt-access',
      input: queuedInput,
      requestFingerprintHash: fingerprintHash,
      idempotencyScopeHash: scopeHash,
      idempotencyKeyHash: sha256(idempotencyKey),
      idempotencyOrigin: 'explicit',
      createOptions: {
        ...plannedJob,
        correlationId: traceId
      }
    });
    const parsedCreatedAt = new Date(created.job.created_at).toISOString();
    context.logger?.info?.('gaming.source_ingestion.enqueued', {
      traceId,
      ingestionId: created.job.id,
      action: body.action,
      acceptedSourceCount: body.sources.length,
      rejectedSourceCount: body.rejectedSources.length,
      deduplicated: created.deduped
    });
    return {
      statusCode: 202,
      payload: {
        ok: true,
        action: body.action,
        ingestionId: created.job.id,
        status: mapStoredJobStatus(created.job.status),
        deduplicated: created.deduped,
        statusUrl: `${GAMING_SOURCE_INGESTION_REQUEST_PATH}/${created.job.id}`,
        sources: queuedSourceResults(body),
        createdAt: parsedCreatedAt,
        requestId: context.requestId,
        traceId
      }
    };
  } catch (error: unknown) {
    if (error instanceof IdempotencyKeyConflictError) {
      return {
        statusCode: 409,
        payload: {
          ok: false,
          error: {
            code: 'GAMING_SOURCE_IDEMPOTENCY_CONFLICT',
            message: 'The idempotency key is already bound to a different ingestion request.'
          }
        }
      };
    }
    if (error instanceof JobRepositoryUnavailableError) {
      return {
        statusCode: 503,
        payload: {
          ok: false,
          error: {
            code: 'GAMING_SOURCE_JOBS_UNAVAILABLE',
            message: 'Durable gaming-source ingestion is unavailable.'
          }
        }
      };
    }
    context.logger?.error?.('gaming.source_ingestion.enqueue_failed', {
      traceId,
      action: body.action,
      errorType: error instanceof Error ? error.name : 'unknown'
    });
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_INTERNAL_ERROR',
          message: 'Failed to enqueue gaming-source ingestion.'
        }
      }
    };
  }
}

export async function createGamingSourceIngestion(
  requestBody: unknown,
  context: GamingSourceGatewayContext
) {
  const parsed = ingestRequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return buildGatewayValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  }
  const idempotency = resolveExplicitIdempotencyKey(parsed.data.payload.idempotencyKey, context.idempotencyKey);
  if (!idempotency.key) {
    return buildGatewayValidationError(idempotency.error ?? 'An idempotency key is required.');
  }

  const game = canonicalizeGamingGameName(parsed.data.payload.game);
  const gameKey = canonicalGameKey(game);
  const seenCanonicalUrls = new Set<string>();
  const sources: QueuedGamingSource[] = [];
  const rejectedSources: RejectedGamingSource[] = [];
  parsed.data.payload.sourceUrls.forEach((rawUrl, submittedIndex) => {
    const admission = admitUrl(rawUrl, submittedIndex, seenCanonicalUrls);
    if (admission.rejection) {
      rejectedSources.push(admission.rejection);
      return;
    }
    sources.push({
      submittedIndex,
      canonicalUrl: admission.source!,
      game,
      gameKey,
      sourceTypeHint: parsed.data.payload.sourceTypeHint,
      patchVersion: parsed.data.payload.patchVersion,
      origin: parsed.data.payload.origin
    });
  });
  if (sources.length === 0) {
    return buildGatewayValidationError('Every submitted source URL was rejected.', rejectedSources);
  }
  return enqueueGamingIngestion({
    action: 'ingest',
    schemaVersion: '1',
    sources,
    rejectedSources,
    submittedCount: parsed.data.payload.sourceUrls.length
  }, idempotency.key, context);
}

export async function refreshGamingSources(
  requestBody: unknown,
  context: GamingSourceGatewayContext
) {
  const parsed = refreshRequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return buildGatewayValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  }
  const idempotency = resolveExplicitIdempotencyKey(parsed.data.payload.idempotencyKey, context.idempotencyKey);
  if (!idempotency.key) {
    return buildGatewayValidationError(idempotency.error ?? 'An idempotency key is required.');
  }

  const sources: QueuedGamingSource[] = [];
  const rejectedSources: RejectedGamingSource[] = [];
  const seenSourceIds = new Set<string>();
  try {
    for (let submittedIndex = 0; submittedIndex < parsed.data.payload.sourceIds.length; submittedIndex += 1) {
      const sourceId = parsed.data.payload.sourceIds[submittedIndex];
      if (seenSourceIds.has(sourceId)) {
        rejectedSources.push(rejectAdmission(
          submittedIndex,
          'DUPLICATE_URL',
          'The source identifier is duplicated in this request.'
        ));
        continue;
      }
      seenSourceIds.add(sourceId);
      const source = await getGamingSourceById(sourceId);
      if (!source) {
        rejectedSources.push(rejectAdmission(
          submittedIndex,
          'SOURCE_NOT_FOUND',
          'The gaming source was not found.'
        ));
        continue;
      }
      const refreshPatchVersion = readBoundedGamingPatchVersion(
        source.latestRevision?.patch
      );
      sources.push({
        submittedIndex,
        canonicalUrl: source.canonicalUrl,
        game: source.game,
        gameKey: source.gameKey,
        sourceId: source.id,
        sourceTypeHint: source.sourceType === 'patch_notes' || source.sourceType === 'wiki'
          ? source.sourceType
          : 'article',
        sourceTrustType: source.sourceType,
        trustScore: source.trustScore,
        ...(refreshPatchVersion ? { patchVersion: refreshPatchVersion } : {}),
        origin: 'refresh'
      });
    }
  } catch (error: unknown) {
    if (error instanceof GamingSourceRepositoryUnavailableError) {
      return {
        statusCode: 503,
        payload: {
          ok: false,
          error: {
            code: 'GAMING_SOURCE_STORAGE_UNAVAILABLE',
            message: 'Gaming-source refresh storage is unavailable.'
          }
        }
      };
    }
    logger.error('gaming.source_refresh.lookup_failed', {
      requestId: context.requestId,
      traceId: context.traceId,
      errorType: error instanceof Error ? error.name : 'unknown'
    });
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_INTERNAL_ERROR',
          message: 'Failed to refresh gaming sources.'
        }
      }
    };
  }
  if (sources.length === 0) {
    return buildGatewayValidationError('Every requested gaming source was rejected.', rejectedSources);
  }
  return enqueueGamingIngestion({
    action: 'refresh',
    schemaVersion: '1',
    sources,
    rejectedSources,
    submittedCount: parsed.data.payload.sourceIds.length,
    refreshReason: parsed.data.payload.reason
  }, idempotency.key, context);
}

function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') {
    return undefined;
  }
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function classifySourceFailure(error: unknown): GamingSourcePublicError {
  const status = readHttpStatus(error);
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (status === 401 || status === 403) {
    return {
      code: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'ACCESS_DENIED',
      message: 'The source does not allow anonymous public fetching.',
      retryable: false
    };
  }
  if (status === 404 || status === 410) {
    return { code: 'SOURCE_NOT_FOUND', message: 'The source page was not found.', retryable: false };
  }
  if (status !== undefined && status >= 300 && status < 400) {
    return {
      code: 'REDIRECT_NOT_ALLOWED',
      message: 'The source redirected; redirects are not followed by the safe fetcher.',
      retryable: false
    };
  }
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return { code: 'FETCH_FAILED', message: 'The source fetch failed transiently.', retryable: true };
  }
  if (status !== undefined && status >= 400) {
    return { code: 'FETCH_FAILED', message: 'The source rejected the public fetch.', retryable: false };
  }
  if (message.includes('timeout') || message.includes('timed out') || message.includes('deadline')) {
    return { code: 'FETCH_TIMEOUT', message: 'The source fetch timed out.', retryable: true };
  }
  if (message.includes('content type')) {
    return {
      code: 'UNSUPPORTED_CONTENT_TYPE',
      message: 'The source returned an unsupported content type.',
      retryable: false
    };
  }
  if (message.includes('maxcontentlength') || message.includes('too large')) {
    return { code: 'RESPONSE_TOO_LARGE', message: 'The source response is too large.', retryable: false };
  }
  if (message.includes('private') || message.includes('reserved') || message.includes('internal')) {
    return {
      code: 'PRIVATE_NETWORK_BLOCKED',
      message: 'The source did not pass the public-network safety check.',
      retryable: false
    };
  }
  if (message.includes('redirect')) {
    return {
      code: 'REDIRECT_NOT_ALLOWED',
      message: 'The source redirected; redirects are not followed by the safe fetcher.',
      retryable: false
    };
  }
  return { code: 'FETCH_FAILED', message: 'The source could not be fetched.', retryable: true };
}

function sourceTypeToRecordType(sourceType: GamingResourceType): 'guide' | 'build' | 'meta' {
  if (['build_planner', 'loadout', 'skill_tree', 'character_profile', 'calculator'].includes(sourceType)) {
    return 'build';
  }
  if (sourceType === 'patch_notes') {
    return 'meta';
  }
  return 'guide';
}

function sourceTypeToTrustType(
  sourceType: GamingResourceType,
  queuedSource: QueuedGamingSource
): 'official' | 'patch_notes' | 'wiki' | 'curated' | 'supplied' {
  if (queuedSource.sourceTrustType) {
    return queuedSource.sourceTrustType;
  }
  if (sourceType === 'patch_notes' || sourceType === 'wiki') {
    return sourceType;
  }
  return 'supplied';
}

function pageLooksAuthenticationBlocked(text: string): boolean {
  if (text.length > 2_000) {
    return false;
  }
  return /\b(?:sign in|log in|login required|enable javascript|verify you are human|captcha|access denied)\b/iu.test(text);
}

async function ingestOneSource(
  source: QueuedGamingSource,
  signal?: AbortSignal,
  context: { requestId?: string; traceId?: string } = {}
): Promise<GamingSourceIngestionItemResult> {
  const startedAt = Date.now();
  const urlHash = sha256(source.canonicalUrl).slice(0, 16);
  const logContext = {
    module: 'gaming-source-ingestion',
    sourceHost: new URL(source.canonicalUrl).hostname,
    sourceUrlHash: urlHash,
    submittedIndex: source.submittedIndex,
    ...context,
    action: source.origin === 'refresh' ? 'refresh' : 'ingest'
  };
  logger.info('gaming.source.fetch_started', logContext);
  try {
    const fetchedAt = new Date().toISOString();
    const document = await resolveGamingDocument(source.canonicalUrl, GAMING_DURABLE_DOCUMENT_LIMITS.documentChars, {
      signal,
      documentPurpose: 'durable',
      includeLinks: false,
      rawDocumentMaxChars: GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars
    });
    signal?.throwIfAborted();
    const chunked = await chunkGamingDocument(document.text, { signal });
    const cleanedText = chunked.text;
    const documentTruncated = document.metrics.truncated || chunked.documentTruncated;
    const documentQuality = classifyGamingDocumentQuality({
      cleanedText,
      navigationDensity: document.extraction.navigationDensity,
      truncated: documentTruncated,
      minUsefulTextChars: MIN_USEFUL_TEXT_CHARS
    });
    const resolutionProvenance = {
      resolverId: document.resolution.resolverId,
      resolverVersion: document.resolution.resolverVersion,
      resolutionStrategy: document.resolution.strategy,
      requestedHost: document.host,
      resolvedDocumentType: document.resolution.documentType,
      documentTruncated,
      rawTextLength: document.metrics.rawTextLength,
      cleanedTextLength: cleanedText.length,
      documentCharsResolved: document.extraction.cleanedTextLength,
      documentCharsIndexed: chunked.indexedChars,
      chunkCount: chunked.chunks.length,
      chunkingVersion: chunked.chunkingVersion,
      coverageStatus: documentTruncated ? 'partial' : 'complete'
    };
    logger.info('gaming.source.resolution_completed', {
      ...logContext,
      ...resolutionProvenance,
      documentQuality
    });
    if (cleanedText.length < MIN_USEFUL_TEXT_CHARS) {
      const code = pageLooksAuthenticationBlocked(cleanedText)
        ? 'AUTHENTICATION_REQUIRED'
        : 'EXTRACTION_EMPTY';
      return {
        submittedIndex: source.submittedIndex,
        status: 'rejected',
        canonicalUrl: source.canonicalUrl,
        ...(source.sourceId ? { sourceId: source.sourceId } : {}),
        recordsCreated: 0,
        recordsUpdated: 0,
        completedAt: new Date().toISOString(),
        error: {
          code,
          message: code === 'AUTHENTICATION_REQUIRED'
            ? 'The source requires an interactive or authenticated session.'
            : 'The source did not contain enough usable public text.',
          retryable: false
        }
      };
    }

    const pageTitle = document.metadata.title?.slice(0, MAX_TITLE_CHARS);
    const pageHeadings = document.metadata.headings?.slice(0, 1_000);
    const detectedGame = detectGamingDocumentGame({
      canonicalUrl: source.canonicalUrl,
      pageTitle,
      pageHeadings
    });
    if (
      detectedGame.game
      && detectedGame.confidence >= 0.8
      && canonicalGameKey(detectedGame.game) !== source.gameKey
    ) {
      return {
        submittedIndex: source.submittedIndex,
        status: 'rejected',
        canonicalUrl: source.canonicalUrl,
        ...(source.sourceId ? { sourceId: source.sourceId } : {}),
        recordsCreated: 0,
        recordsUpdated: 0,
        completedAt: new Date().toISOString(),
        error: {
          code: 'GAME_MISMATCH',
          message: 'The source could not be associated with the requested game.',
          retryable: false
        }
      };
    }

    const normalized = await ingestGamingBuildResource({
      url: source.canonicalUrl,
      requestedGame: source.game,
      contentType: document.contentType,
      html: document.rawDocument?.contentType.includes('html') ? document.rawDocument.body : undefined,
      text: cleanedText,
      metadata: {
        title: pageTitle,
        headings: pageHeadings
      },
      signal
    }, { useCache: false });
    const supportsStructuredExtraction = document.resolution.supportsStructuredExtraction;
    const normalizedBuild = supportsStructuredExtraction ? normalized.build : null;
    if (supportsStructuredExtraction && normalized.failureReason === 'STRUCTURED_RESOURCE_GAME_MISMATCH') {
      return {
        submittedIndex: source.submittedIndex,
        status: 'rejected',
        canonicalUrl: source.canonicalUrl,
        ...(source.sourceId ? { sourceId: source.sourceId } : {}),
        recordsCreated: 0,
        recordsUpdated: 0,
        completedAt: new Date().toISOString(),
        error: {
          code: 'GAME_MISMATCH',
          message: 'The structured source belongs to a different game.',
          retryable: false
        }
      };
    }

    const classifiedSourceType = normalized.classification.type !== 'unknown'
      ? normalized.classification.type
      : source.sourceTypeHint ?? 'article';
    // Document-only resolvers must not turn prose into a build record merely
    // because an item identifier resembles a planner or loadout URL.
    const sourceType = !supportsStructuredExtraction && sourceTypeToRecordType(classifiedSourceType) === 'build'
      ? 'article' : classifiedSourceType;
    const hasStructuredFields = Boolean(normalizedBuild && (
      normalizedBuild.equipment?.length || normalizedBuild.skills?.length
      || Object.keys(normalizedBuild.stats ?? {}).length
    ));
    const structuredExtractionQuality = classifyGamingStructuredExtractionQuality({
      isBuildRecord: sourceTypeToRecordType(sourceType) === 'build',
      hasStructuredFields,
      quality: normalized.quality
    });
    logger.info('gaming.source.normalization_completed', {
      ...logContext,
      sourceType,
      documentQuality,
      structuredExtractionQuality,
      extractor: normalized.adapterId,
      extractorVersion: normalized.adapterVersion
    });
    const title = normalizedBuild?.title ?? pageTitle;
    const normalizedEvidence = supportsStructuredExtraction
      ? normalized.evidenceText.trim().slice(0, GAMING_BUILD_RESOURCE_HARD_LIMITS.maxEvidenceChars) : '';
    const patchVerification = resolveVerifiedPatch({
      claimedPatch: source.patchVersion,
      extractedPatch: normalizedBuild?.patch,
      fetchedEvidence: [
        pageTitle,
        pageHeadings,
        normalizedEvidence,
        cleanedText
      ].filter(Boolean).join('\n\n')
    });
    const patchVersion = patchVerification?.version;
    const normalizedData: Record<string, unknown> = normalizedBuild
      ? { ...normalizedBuild }
      : {
          schemaVersion: '1',
          game: source.game,
          title,
          sourceType,
          summary: cleanedText.slice(0, 2_000)
        };
    delete normalizedData.patch;
    if (patchVersion) {
      normalizedData.patch = patchVersion;
    }
    const contentHash = hashGamingDocumentRevision(cleanedText, stableJson(normalizedData));
    // Revision identity includes acquisition policy so refreshing an older
    // extraction can replace stale provenance/quality even if its prose matches.
    const extractorVersion = `${GAMING_DOCUMENT_RESOLVER_VERSION}:${sha256(stableJson({
      adapterId: normalized.adapterId,
      adapterVersion: normalized.adapterVersion,
      resolverId: document.resolution.resolverId,
      resolverVersion: document.resolution.resolverVersion,
      documentResolverVersion: GAMING_DOCUMENT_RESOLVER_VERSION,
      chunkingVersion: GAMING_DOCUMENT_CHUNKING_VERSION
    }))}`;
    const records = chunked.chunks.map((chunk) => {
      const { text, semanticKey, ...chunkMetadata } = chunk;
      // Structured build payloads remain compatible on the first record only;
      // every other record contains its own prose and bounded document metadata.
      const chunkData: Record<string, unknown> = {
        ...(normalizedBuild && chunk.ordinal === 0 ? normalizedData : {
          game: source.game, title, sourceType, ...(patchVersion ? { patch: patchVersion } : {})
        }),
        schemaVersion: GAMING_DOCUMENT_CHUNKING_VERSION,
        text,
        ...(chunk.ordinal === 0 && normalizedEvidence ? { structuredEvidence: normalizedEvidence } : {}),
        chunk: chunkMetadata
      };
      return {
        recordType: sourceTypeToRecordType(sourceType),
        semanticKey: sha256(stableJson({ gameKey: source.gameKey, recordType: sourceTypeToRecordType(sourceType), semanticKey })),
        payloadHash: sha256(stableJson(chunkData)),
        title,
        patch: patchVersion,
        searchText: buildGamingDocumentSearchText({
          cleanedText: text, title, game: source.game, patchVersion,
          normalizedEvidence: chunk.ordinal === 0 ? normalizedEvidence : '',
          // Reserve the actual metadata plus all four possible blank-line separators.
          maxChars: GAMING_DURABLE_DOCUMENT_LIMITS.maxChunkChars + GAMING_BUILD_RESOURCE_HARD_LIMITS.maxEvidenceChars
            + (title?.length ?? 0) + source.game.length + (patchVersion?.length ?? 0) + 8
        }),
        normalized: chunkData
      };
    });
    signal?.throwIfAborted();
    const persisted = await persistGamingSourceRevision({
      gameKey: source.gameKey,
      gameName: source.game,
      canonicalUrl: source.canonicalUrl,
      publicUrl: selectGamingSourcePublicUrl(source.canonicalUrl, document.publicUrl, supportsStructuredExtraction),
      sourceType: sourceTypeToTrustType(sourceType, source),
      trustScore: source.trustScore ?? 0.25,
      priority: 100,
      contentHash,
      cleanedContent: cleanedText.slice(0, GAMING_DURABLE_DOCUMENT_LIMITS.revisionPreviewChars)
        .replace(/[\uD800-\uDBFF]$/u, ''),
      fetchedAt,
      patch: patchVersion,
      extractor: normalized.adapterId,
      extractorVersion,
      normalizerSchemaVersion: GAMING_BUILD_RESOURCE_SCHEMA_VERSION,
      provenance: {
        canonicalUrl: source.canonicalUrl,
        origin: source.origin,
        sourceTypeHint: source.sourceTypeHint ?? null,
        submittedIndex: source.submittedIndex,
        claimedPatchVersion: source.patchVersion ?? null,
        verifiedPatchVersion: patchVersion ?? null,
        patchVerificationMethod: patchVerification?.method ?? null,
        structuredExtractorVersion: normalized.adapterVersion,
        documentResolverVersion: GAMING_DOCUMENT_RESOLVER_VERSION,
        ...resolutionProvenance
      },
      extractionMetrics: {
        ...resolutionProvenance,
        structured: normalized.metrics,
        extractionQuality: documentQuality,
        structuredExtractionQuality,
        validationIssues: normalized.validation.issues.slice(0, 16),
        origin: source.origin
      },
      records
    });
    const status = persisted.state === 'unchanged'
      ? 'unchanged'
      : persisted.state === 'created'
        ? 'stored'
        : 'updated';
    logger.info('gaming.source.chunking_completed', {
      ...logContext,
      sourceId: persisted.sourceId,
      revisionId: persisted.revisionId,
      documentChars: cleanedText.length,
      indexedChars: chunked.indexedChars,
      chunkCount: records.length,
      averageChunkChars: Math.round(chunked.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) / records.length),
      maxChunkChars: Math.max(...chunked.chunks.map((chunk) => chunk.text.length)),
      documentTruncated,
      chunkingVersion: chunked.chunkingVersion,
      coverageStatus: documentTruncated ? 'partial' : 'complete'
    });
    logger.info('gaming.source.ingestion_completed', {
      ...logContext,
      sourceId: persisted.sourceId,
      status,
      sourceType,
      extractionQuality: documentQuality,
      structuredExtractionQuality,
      recordsCreated: persisted.recordsCreated,
      recordsUpdated: persisted.recordsUpdated,
      elapsedMs: Date.now() - startedAt
    });
    return {
      submittedIndex: source.submittedIndex,
      status,
      canonicalUrl: source.canonicalUrl,
      sourceId: persisted.sourceId,
      sourceType,
      ...(patchVersion ? { patchVersion } : {}),
      recordsCreated: persisted.recordsCreated,
      recordsUpdated: persisted.recordsUpdated,
      fetchedAt,
      completedAt: new Date().toISOString(),
      ...(documentQuality === 'partial' || documentQuality === 'metadata-only'
        ? { warnings: ['EXTRACTION_PARTIAL'] }
        : {})
    };
  } catch (error: unknown) {
    if (signal?.aborted) {
      throw error;
    }
    const classified = classifySourceFailure(error);
    logger.warn('gaming.source.ingestion_failed', {
      ...logContext,
      errorCode: classified.code,
      retryable: classified.retryable,
      elapsedMs: Date.now() - startedAt
    });
    return {
      submittedIndex: source.submittedIndex,
      status: classified.retryable ? 'failed' : 'rejected',
      canonicalUrl: source.canonicalUrl,
      ...(source.sourceId ? { sourceId: source.sourceId } : {}),
      recordsCreated: 0,
      recordsUpdated: 0,
      completedAt: new Date().toISOString(),
      error: classified
    };
  }
}

export async function executeQueuedGamingSourceIngestion(
  ingestionId: string,
  body: unknown,
  options: { signal?: AbortSignal; requestId?: string; traceId?: string } = {}
): Promise<{ output: GamingSourceIngestionOutput; retryable: boolean }> {
  const parsed = queuedGamingIngestionBodySchema.safeParse(body);
  if (!parsed.success) {
    throw Object.assign(new Error('Invalid queued gaming-source ingestion payload.'), {
      code: 'GAMING_SOURCE_JOB_INVALID'
    });
  }
  const startedAt = new Date().toISOString();
  const processed: GamingSourceIngestionItemResult[] = [];
  for (const source of parsed.data.sources) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Gaming-source ingestion was cancelled.');
    }
    processed.push(await ingestOneSource(source, options.signal, {
      requestId: options.requestId,
      traceId: options.traceId
    }));
  }
  const sources = [...processed, ...parsed.data.rejectedSources]
    .sort((left, right) => left.submittedIndex - right.submittedIndex);
  const succeeded = sources.filter((source) => ['stored', 'updated', 'unchanged'].includes(source.status)).length;
  const rejected = sources.filter((source) => source.status === 'rejected').length;
  const failed = sources.filter((source) => source.status === 'failed').length;
  const completedWithErrors = rejected > 0 || failed > 0;
  const retryable = succeeded === 0
    && failed > 0
    && sources.filter((source) => source.status === 'failed').every((source) => source.error?.retryable === true);
  const completedAt = new Date().toISOString();
  return {
    output: {
      ok: true,
      action: parsed.data.action,
      ingestionId,
      status: completedWithErrors ? 'completed_with_errors' : 'completed',
      counts: {
        total: parsed.data.submittedCount,
        queued: 0,
        succeeded,
        rejected,
        failed,
        recordsCreated: sources.reduce((sum, source) => sum + source.recordsCreated, 0),
        recordsUpdated: sources.reduce((sum, source) => sum + source.recordsUpdated, 0)
      },
      sources,
      createdAt: startedAt,
      updatedAt: completedAt,
      completedAt,
      requestId: options.requestId,
      traceId: options.traceId
    },
    retryable
  };
}

export async function getGamingSourceIngestionStatus(
  ingestionId: string,
  context: Pick<GamingSourceGatewayContext, 'actorKey' | 'requestId' | 'traceId' | 'logger'>
) {
  if (!SOURCE_ID_PATTERN.test(ingestionId)) {
    return buildGatewayValidationError('ingestionId must be a UUID.');
  }
  try {
    const job = await getJobById(ingestionId);
    if (
      !job
      || job.job_type !== 'gpt'
      || !isGamingIngestionQueuedInput(job.input)
      || job.idempotency_scope_hash !== gamingSourceActorScopeHash(context.actorKey)
    ) {
      return {
        statusCode: 404,
        payload: {
          ok: false,
          error: {
            code: 'GAMING_SOURCE_INGESTION_NOT_FOUND',
            message: 'The gaming-source ingestion was not found.'
          }
        }
      };
    }
    const input = job.input;
    const parsedBody = queuedGamingIngestionBodySchema.parse(input.body);
    const createdAt = new Date(job.created_at).toISOString();
    const updatedAt = new Date(job.updated_at).toISOString();
    const status = mapStoredJobStatus(job.status);
    if (
      (job.status === 'completed' || job.status === 'failed')
      && job.output
      && typeof job.output === 'object'
      && !Array.isArray(job.output)
      && (job.output as { ingestionId?: unknown }).ingestionId === ingestionId
    ) {
      const output = job.output as GamingSourceIngestionOutput;
      return {
        statusCode: 200,
        payload: {
          ...output,
          action: 'status',
          status: job.status === 'failed' ? 'failed' : output.status,
          sources: output.sources.map(projectBoundedPublicPatchVersion),
          createdAt,
          updatedAt,
          ...(job.completed_at ? { completedAt: new Date(job.completed_at).toISOString() } : {}),
          requestId: context.requestId ?? input.requestId,
          traceId: context.traceId ?? input.traceId
        }
      };
    }
    const terminalStatus = status === 'cancelled' || status === 'expired' || status === 'failed'
      ? status
      : undefined;
    const sources = terminalStatus
      ? terminalSourceResults(parsedBody, terminalStatus)
      : queuedSourceResults(parsedBody).map((source) => (
        source.status === 'queued' && status === 'running'
          ? { ...source, status: 'running' as const }
          : source
      ));
    return {
      statusCode: 200,
      payload: {
        ok: true,
        action: 'status',
        ingestionId,
        status,
        counts: terminalStatus
          ? {
            ...buildQueuedCounts(parsedBody),
            queued: 0,
            failed: parsedBody.sources.length
          }
          : {
            ...buildQueuedCounts(parsedBody),
            queued: status === 'running' ? 0 : parsedBody.sources.length
          },
        sources,
        createdAt,
        updatedAt,
        ...(job.completed_at ? { completedAt: new Date(job.completed_at).toISOString() } : {}),
        requestId: context.requestId ?? input.requestId,
        traceId: context.traceId ?? input.traceId
      }
    };
  } catch (error: unknown) {
    if (error instanceof JobRepositoryUnavailableError) {
      return {
        statusCode: 503,
        payload: {
          ok: false,
          error: {
            code: 'GAMING_SOURCE_JOBS_UNAVAILABLE',
            message: 'Gaming-source ingestion status is unavailable.'
          }
        }
      };
    }
    logger.error('gaming.source_ingestion.status_failed', {
      requestId: context.requestId,
      traceId: context.traceId,
      errorType: error instanceof Error ? error.name : 'unknown'
    });
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: {
          code: 'GAMING_SOURCE_INTERNAL_ERROR',
          message: 'Failed to read gaming-source ingestion status.'
        }
      }
    };
  }
}

export async function buildStoredGamingKnowledgeContext(
  input: GamingStoredKnowledgeInput
): Promise<GamingStoredKnowledgeContext> {
  return retrieveStoredGamingKnowledge(input, { resolveVerifiedPatch: resolveVerifiedStoredPatch });
}

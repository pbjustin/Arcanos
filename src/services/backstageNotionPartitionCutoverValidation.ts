import { createHash } from 'node:crypto';

import {
  BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS,
  BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  normalizeBackstageNotionPartitionRoutingIntent,
  type BackstageNotionPartitionRoutingIntent,
} from '@shared/backstage/backstageNotionPartitionRoutingCore.js';
import {
  BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS,
  type BackstageNotionRagCitation,
  type BackstageNotionRagCoverage,
  type BackstageNotionRagQuery,
  type BackstageNotionRagRetrieval,
  type BackstageNotionRagRetrievalMode,
} from './backstageNotionRag.js';
import type {
  BackstageNotionPartitionRagRetrieval,
  BackstageNotionPartitionRetrievalPlan,
} from './backstageNotionPartitionRetrieval.js';

export const BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_VERSION = 1;
export const BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_MAX_CASES = 64;
export const BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_MAX_PAGE_REQUESTS = 4_096;

const MAX_CITATIONS_PER_PATH = BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
  * BACKSTAGE_NOTION_PARTITION_MAX_CHUNKS;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/u;
const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/u;

export type BackstageNotionPartitionCutoverValidationCaseKind =
  | 'exact_scope'
  | 'relevant'
  | 'complete_scope';

export type BackstageNotionPartitionCutoverValidationErrorCode =
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID'
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_ANCHOR_UNAVAILABLE'
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_ANCHOR_CHANGED'
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_RETRIEVAL_UNAVAILABLE'
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_VERSION_DRIFT'
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_PARITY_MISMATCH'
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_CURSOR_INVALID'
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_COVERAGE_INCOMPLETE'
  | 'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_EVIDENCE_SEAL_FAILED';

const ERROR_MESSAGES: Readonly<Record<
  BackstageNotionPartitionCutoverValidationErrorCode,
  string
>> = Object.freeze({
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID:
    'The bounded partition cutover validation input is invalid.',
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_ANCHOR_UNAVAILABLE:
    'The partition cutover validation anchor is unavailable.',
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_ANCHOR_CHANGED:
    'The partition cutover validation anchor changed before evidence sealing.',
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_RETRIEVAL_UNAVAILABLE:
    'A partition cutover validation retrieval was unavailable.',
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_VERSION_DRIFT:
    'A partition cutover validation retrieval crossed authority versions.',
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_PARITY_MISMATCH:
    'The partition cutover validation comparison did not pass.',
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_CURSOR_INVALID:
    'A partition cutover validation cursor path was invalid.',
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_COVERAGE_INCOMPLETE:
    'A partition cutover validation scope was not covered completely.',
  BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_EVIDENCE_SEAL_FAILED:
    'The partition cutover validation evidence could not be sealed.',
});

export class BackstageNotionPartitionCutoverValidationError extends Error {
  constructor(readonly code: BackstageNotionPartitionCutoverValidationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'BackstageNotionPartitionCutoverValidationError';
  }
}

export interface BackstageNotionPartitionCutoverValidationAnchor {
  readonly universeId: string;
  readonly monolithSnapshotId: string;
  readonly partitionManifestId: string;
  readonly partitionConfigurationVersionId: string;
  readonly partitionConfigurationHash: string;
  readonly partitionSourceGenerationId: string;
  readonly partitionSourceDigest: string;
  readonly partitionSourceVerificationHash: string;
  readonly reconciliationGeneration: number;
  readonly rollbackMonolithVerifiedAt: Date;
  readonly rollbackMonolithValidUntil: Date;
}

export interface BackstageNotionPartitionCutoverValidationCase {
  /** Content-free stable label used only in bounded evidence. */
  readonly caseId: string;
  readonly kind: BackstageNotionPartitionCutoverValidationCaseKind;
  /** One canonical representative request without a continuation cursor. */
  readonly query: BackstageNotionRagQuery;
}

export interface BackstageNotionPartitionCutoverValidationCaseAttestation {
  readonly caseId: string;
  readonly kind: BackstageNotionPartitionCutoverValidationCaseKind;
  readonly citationCount: number;
  readonly monolithRequestCount: number;
  readonly partitionRequestCount: number;
  readonly cursorContinuationObserved: boolean;
  readonly requestBindingDigest: string;
  readonly partitionPlanDigest: string;
  readonly comparisonDigest: string;
}

export interface BackstageNotionPartitionCutoverValidationAttestation {
  readonly version: typeof BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_VERSION;
  readonly universeId: string;
  readonly monolithSnapshotId: string;
  readonly partitionManifestId: string;
  readonly partitionConfigurationVersionId: string;
  readonly partitionConfigurationHash: string;
  readonly partitionSourceGenerationId: string;
  readonly partitionSourceDigest: string;
  readonly partitionSourceVerificationHash: string;
  readonly reconciliationGeneration: number;
  readonly rollbackMonolithVerifiedAt: Date;
  readonly rollbackMonolithValidUntil: Date;
  readonly caseCount: number;
  readonly exactScopeCaseCount: number;
  readonly relevantCaseCount: number;
  readonly completeScopeCaseCount: number;
  readonly cursorContinuationCaseCount: number;
  readonly monolithRequestCount: number;
  readonly partitionRequestCount: number;
  readonly citationCount: number;
  readonly exactScopeParityPassed: true;
  readonly relevantRetrievalParityPassed: true;
  readonly completeScopeParityPassed: true;
  readonly cursorStabilityPassed: true;
  readonly cases: readonly BackstageNotionPartitionCutoverValidationCaseAttestation[];
  readonly attestationDigest: string;
  readonly validatedAt: Date;
}

export interface BackstageNotionPartitionCutoverValidationDependencies {
  readonly loadAnchor: (
    universeId: string
  ) => Promise<BackstageNotionPartitionCutoverValidationAnchor | null>;
  /** Must execute directly against the supplied immutable snapshot. */
  readonly retrieveMonolithPinned: (input: Readonly<{
    universeId: string;
    snapshotId: string;
    query: BackstageNotionRagQuery;
    cursor: string | null;
  }>) => Promise<BackstageNotionRagRetrieval>;
  /**
   * Trusted adapter to the exact production request planner/router. Validation
   * cases cannot supply a plan or routing intent themselves.
   */
  readonly derivePartitionPlan: (input: Readonly<{
    universeId: string;
    manifestId: string;
    query: BackstageNotionRagQuery;
  }>) => Promise<BackstageNotionPartitionRetrievalPlan>;
  /** Must execute directly against the supplied immutable manifest. */
  readonly retrievePartitionPinned: (input: Readonly<{
    universeId: string;
    manifestId: string;
    plan: BackstageNotionPartitionRetrievalPlan;
    cursor: string | null;
  }>) => Promise<BackstageNotionPartitionRagRetrieval>;
  readonly sealEvidence: (
    evidence: BackstageNotionPartitionCutoverValidationAttestation
  ) => Promise<void>;
  readonly now?: () => Date;
}

type ValidationRetrieval =
  | BackstageNotionRagRetrieval
  | BackstageNotionPartitionRagRetrieval;

interface RetrievalShape {
  readonly promptDigest: string;
  readonly citationDigest: string;
  readonly citationCount: number;
  readonly retrievalMode: BackstageNotionRagRetrievalMode;
  readonly chunkCount: number;
  readonly truncated: boolean;
  readonly coverageDigest: string;
}

interface CompletePath {
  readonly requestCount: number;
  readonly citationCount: number;
  readonly citationSetDigest: string;
  readonly scopeChunkCount: number;
  readonly continuationObserved: boolean;
}

interface NormalizedValidationQuery {
  readonly requestBindingDigest: string;
  readonly normalizedRequestDigest: string;
  readonly retrievalMode: BackstageNotionRagRetrievalMode;
  readonly hasScope: boolean;
}

interface PreparedValidationCase {
  readonly caseId: string;
  readonly kind: BackstageNotionPartitionCutoverValidationCaseKind;
  readonly query: BackstageNotionRagQuery;
  readonly partitionPlan: BackstageNotionPartitionRetrievalPlan;
  readonly requestBindingDigest: string;
  readonly partitionPlanDigest: string;
}

function fail(code: BackstageNotionPartitionCutoverValidationErrorCode): never {
  throw new BackstageNotionPartitionCutoverValidationError(code);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeAnchor(
  value: BackstageNotionPartitionCutoverValidationAnchor | null,
  universeId: string
): BackstageNotionPartitionCutoverValidationAnchor {
  if (
    value === null
    || !isPlainObject(value)
    || value.universeId !== universeId
    || !UUID_PATTERN.test(value.monolithSnapshotId)
    || !UUID_PATTERN.test(value.partitionManifestId)
    || !UUID_PATTERN.test(value.partitionConfigurationVersionId)
    || !SHA256_PATTERN.test(value.partitionConfigurationHash)
    || !UUID_PATTERN.test(value.partitionSourceGenerationId)
    || !SHA256_PATTERN.test(value.partitionSourceDigest)
    || !SHA256_PATTERN.test(value.partitionSourceVerificationHash)
    || !Number.isSafeInteger(value.reconciliationGeneration)
    || value.reconciliationGeneration < 1
    || !(value.rollbackMonolithVerifiedAt instanceof Date)
    || !Number.isFinite(value.rollbackMonolithVerifiedAt.getTime())
    || !(value.rollbackMonolithValidUntil instanceof Date)
    || !Number.isFinite(value.rollbackMonolithValidUntil.getTime())
    || value.rollbackMonolithVerifiedAt.getTime()
      > value.rollbackMonolithValidUntil.getTime()
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_ANCHOR_UNAVAILABLE');
  }
  return Object.freeze({ ...value });
}

function sameAnchor(
  left: BackstageNotionPartitionCutoverValidationAnchor,
  right: BackstageNotionPartitionCutoverValidationAnchor
): boolean {
  return left.universeId === right.universeId
    && left.monolithSnapshotId === right.monolithSnapshotId
    && left.partitionManifestId === right.partitionManifestId
    && left.partitionConfigurationVersionId === right.partitionConfigurationVersionId
    && left.partitionConfigurationHash === right.partitionConfigurationHash
    && left.partitionSourceGenerationId === right.partitionSourceGenerationId
    && left.partitionSourceDigest === right.partitionSourceDigest
    && left.partitionSourceVerificationHash === right.partitionSourceVerificationHash
    && left.reconciliationGeneration === right.reconciliationGeneration
    && left.rollbackMonolithVerifiedAt.getTime()
      === right.rollbackMonolithVerifiedAt.getTime()
    && left.rollbackMonolithValidUntil.getTime()
      === right.rollbackMonolithValidUntil.getTime();
}

function readClosedDataObject(
  value: unknown,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const actualKeys = Reflect.ownKeys(value);
  const allowed = new Set(allowedKeys);
  if (
    actualKeys.length < requiredKeys.length
    || actualKeys.length > allowed.size
    || actualKeys.some(key => typeof key !== 'string' || !allowed.has(key))
    || requiredKeys.some(key => !actualKeys.includes(key))
  ) {
    return null;
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of actualKeys) {
    if (typeof key !== 'string') {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function normalizeScopeText(value: unknown): Readonly<{
  binding: string;
  normalized: string;
}> | null {
  if (typeof value !== 'string' || !value.trim() || codePointLength(value) > 500) {
    return null;
  }
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized ? Object.freeze({ binding: value, normalized }) : null;
}

function normalizeScopePathForBinding(
  value: unknown,
  maximumSegments: number
): Readonly<{
  binding: readonly string[];
  normalized: readonly string[];
}> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1
    || value.length > maximumSegments
  ) {
    return null;
  }
  const allowedKeys = new Set<PropertyKey>(['length']);
  const binding: string[] = [];
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    const segment = normalizeScopeText(descriptor.value);
    if (!segment) {
      return null;
    }
    binding.push(segment.binding);
    normalized.push(segment.normalized);
  }
  if (Reflect.ownKeys(value).some(key => !allowedKeys.has(key))) {
    return null;
  }
  return Object.freeze({
    binding: Object.freeze(binding),
    normalized: Object.freeze(normalized),
  });
}

function normalizeValidationQuery(
  input: BackstageNotionRagQuery
): NormalizedValidationQuery | null {
  let bindingQuery: string;
  let retrievalMode: BackstageNotionRagRetrievalMode;
  let bindingScope: Readonly<Record<string, unknown>> | null = null;
  let normalizedScope: Readonly<Record<string, unknown>> | null = null;
  if (typeof input === 'string') {
    bindingQuery = input;
    retrievalMode = 'relevant';
  } else {
    const request = readClosedDataObject(
      input,
      ['query'],
      ['query', 'retrievalScope', 'retrievalMode', 'mode', 'cursor']
    );
    if (
      !request
      || typeof request.query !== 'string'
      || request.cursor !== undefined
    ) {
      return null;
    }
    bindingQuery = request.query;
    const requestedMode = request.retrievalMode ?? request.mode ?? 'relevant';
    if (
      (request.retrievalMode !== undefined && request.mode !== undefined
        && request.retrievalMode !== request.mode)
      || (requestedMode !== 'relevant' && requestedMode !== 'complete_scope')
    ) {
      return null;
    }
    retrievalMode = requestedMode;
    if (request.retrievalScope !== undefined) {
      const scope = readClosedDataObject(
        request.retrievalScope,
        ['pageTitle'],
        ['pageTitle', 'pagePath', 'sectionPath', 'scopeKind']
      );
      if (!scope) {
        return null;
      }
      const pageTitle = normalizeScopeText(scope.pageTitle);
      const pagePath = normalizeScopePathForBinding(scope.pagePath, 101);
      const sectionPath = normalizeScopePathForBinding(scope.sectionPath, 32);
      const scopeKind = scope.scopeKind ?? 'page';
      if (
        !pageTitle
        || pagePath === null
        || sectionPath === null
        || (scopeKind !== 'page' && scopeKind !== 'subtree')
        || (scopeKind === 'subtree' && sectionPath !== undefined)
      ) {
        return null;
      }
      bindingScope = Object.freeze({
        pageTitle: pageTitle.binding,
        ...(pagePath ? { pagePath: pagePath.binding } : {}),
        ...(sectionPath ? { sectionPath: sectionPath.binding } : {}),
        ...(Object.hasOwn(scope, 'scopeKind') ? { scopeKind } : {}),
      });
      normalizedScope = Object.freeze({
        pageTitle: pageTitle.normalized,
        ...(pagePath ? { pagePath: pagePath.normalized } : {}),
        ...(sectionPath ? { sectionPath: sectionPath.normalized } : {}),
        scopeKind,
      });
    }
  }
  if (
    !bindingQuery.trim()
    || codePointLength(bindingQuery) > BACKSTAGE_NOTION_RAG_MAX_QUERY_CODE_POINTS
  ) {
    return null;
  }
  return Object.freeze({
    requestBindingDigest: sha256(JSON.stringify({
      format: 'backstage-notion-partition-retrieval-request-v1',
      query: bindingQuery,
      retrievalMode,
      retrievalScope: bindingScope,
    })),
    normalizedRequestDigest: sha256(JSON.stringify({
      format: 'backstage-notion-partition-cutover-validation-request-v1',
      query: bindingQuery.trim(),
      retrievalMode,
      retrievalScope: normalizedScope,
    })),
    retrievalMode,
    hasScope: normalizedScope !== null,
  });
}

function validateCases(
  cases: readonly BackstageNotionPartitionCutoverValidationCase[]
): readonly BackstageNotionPartitionCutoverValidationCase[] {
  if (
    !Array.isArray(cases)
    || cases.length < 3
    || cases.length > BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_MAX_CASES
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
  }
  const ids = new Set<string>();
  const kinds = new Set<BackstageNotionPartitionCutoverValidationCaseKind>();
  const normalized = cases.map(item => {
    const candidateObject = readClosedDataObject(
      item,
      ['caseId', 'kind', 'query'],
      ['caseId', 'kind', 'query']
    );
    if (!candidateObject) {
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
    }
    if (
      typeof candidateObject.caseId !== 'string'
      || !SAFE_ID_PATTERN.test(candidateObject.caseId)
      || ids.has(candidateObject.caseId)
      || (
        candidateObject.kind !== 'exact_scope'
        && candidateObject.kind !== 'relevant'
        && candidateObject.kind !== 'complete_scope'
      )
    ) {
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
    }
    const request = normalizeValidationQuery(
      candidateObject.query as BackstageNotionRagQuery
    );
    if (
      request === null
      || (
        candidateObject.kind === 'complete_scope'
        && request.retrievalMode !== 'complete_scope'
      )
      || (
        candidateObject.kind !== 'complete_scope'
        && request.retrievalMode !== 'relevant'
      )
      || (
        (candidateObject.kind === 'exact_scope' || candidateObject.kind === 'complete_scope')
        && !request.hasScope
      )
    ) {
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
    }
    const candidate: BackstageNotionPartitionCutoverValidationCase = Object.freeze({
      caseId: candidateObject.caseId,
      kind: candidateObject.kind,
      query: candidateObject.query as BackstageNotionRagQuery,
    });
    ids.add(candidate.caseId);
    kinds.add(candidate.kind);
    return candidate;
  });
  if (
    !kinds.has('exact_scope')
    || !kinds.has('relevant')
    || !kinds.has('complete_scope')
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
  }
  return Object.freeze(normalized);
}

function relevantIntentShape(
  intent: Extract<BackstageNotionPartitionRoutingIntent, { kind: 'relevant' }>
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: intent.kind,
    cardinality: intent.cardinality,
    allowedTiers: Object.freeze([...intent.allowedTiers]),
    explicitArchive: intent.explicitArchive,
    selectors: Object.freeze(intent.selectors.map(selector => Object.freeze({
      allScopeTags: Object.freeze([...selector.allScopeTags]),
      allCategoryTags: Object.freeze([...selector.allCategoryTags]),
    }))),
  });
}

async function prepareValidationCase(input: {
  readonly item: BackstageNotionPartitionCutoverValidationCase;
  readonly anchor: BackstageNotionPartitionCutoverValidationAnchor;
  readonly dependencies: BackstageNotionPartitionCutoverValidationDependencies;
}): Promise<PreparedValidationCase> {
  const canonicalRequest = normalizeValidationQuery(input.item.query);
  if (!canonicalRequest) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
  }
  let rawPlan: BackstageNotionPartitionRetrievalPlan;
  try {
    rawPlan = await input.dependencies.derivePartitionPlan({
      universeId: input.anchor.universeId,
      manifestId: input.anchor.partitionManifestId,
      query: input.item.query,
    });
  } catch {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_RETRIEVAL_UNAVAILABLE');
  }
  const plan = readClosedDataObject(
    rawPlan,
    ['query'],
    ['query', 'relevantRoutingIntent']
  );
  if (!plan) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
  }
  const plannedRequest = normalizeValidationQuery(plan.query as BackstageNotionRagQuery);
  if (
    !plannedRequest
    || plannedRequest.requestBindingDigest !== canonicalRequest.requestBindingDigest
    || plannedRequest.normalizedRequestDigest !== canonicalRequest.normalizedRequestDigest
    || plannedRequest.retrievalMode !== canonicalRequest.retrievalMode
    || plannedRequest.hasScope !== canonicalRequest.hasScope
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
  }

  const shouldHaveRelevantIntent = canonicalRequest.retrievalMode === 'relevant'
    && !canonicalRequest.hasScope;
  const hasRelevantIntent = Object.hasOwn(plan, 'relevantRoutingIntent');
  let relevantRoutingIntent: Extract<
    BackstageNotionPartitionRoutingIntent,
    { kind: 'relevant' }
  > | null = null;
  if (shouldHaveRelevantIntent !== hasRelevantIntent) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
  }
  if (hasRelevantIntent) {
    try {
      const normalizedIntent = normalizeBackstageNotionPartitionRoutingIntent(
        plan.relevantRoutingIntent
      );
      if (normalizedIntent.kind !== 'relevant') {
        fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
      }
      relevantRoutingIntent = normalizedIntent;
    } catch (error) {
      if (error instanceof BackstageNotionPartitionCutoverValidationError) {
        throw error;
      }
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
    }
  }
  const partitionPlan: BackstageNotionPartitionRetrievalPlan = Object.freeze({
    query: input.item.query,
    ...(relevantRoutingIntent ? { relevantRoutingIntent } : {}),
  });
  const partitionPlanDigest = sha256(JSON.stringify({
    format: 'backstage-notion-partition-cutover-validation-plan-v1',
    requestBindingDigest: canonicalRequest.requestBindingDigest,
    normalizedRequestDigest: canonicalRequest.normalizedRequestDigest,
    relevantRoutingIntent: relevantRoutingIntent
      ? relevantIntentShape(relevantRoutingIntent)
      : null,
  }));
  return Object.freeze({
    caseId: input.item.caseId,
    kind: input.item.kind,
    query: input.item.query,
    partitionPlan,
    requestBindingDigest: canonicalRequest.requestBindingDigest,
    partitionPlanDigest,
  });
}

function coverageShape(coverage: BackstageNotionRagCoverage): Readonly<Record<string, unknown>> {
  return Object.freeze({
    status: coverage.status,
    scopeChunks: coverage.scopeChunks,
    selectedChunks: coverage.selectedChunks,
    omittedChunks: coverage.omittedChunks,
    promptTruncated: coverage.promptTruncated,
    exhaustive: coverage.exhaustive,
    hasMore: coverage.hasMore,
    ...('scopePages' in coverage ? {
      scopePages: coverage.scopePages,
      selectedPages: coverage.selectedPages,
      omittedPages: coverage.omittedPages,
    } : {}),
  });
}

function citationSignature(citation: BackstageNotionRagCitation): string {
  if (
    !isPlainObject(citation)
    || !SHA256_PATTERN.test(citation.chunkId)
    || !SHA256_PATTERN.test(citation.contentHash)
    || typeof citation.category !== 'string'
    || !citation.category
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_RETRIEVAL_UNAVAILABLE');
  }
  return sha256(JSON.stringify({
    chunkId: citation.chunkId,
    contentHash: citation.contentHash,
    category: citation.category,
  }));
}

function relevantCitationDigest(citations: readonly BackstageNotionRagCitation[]): string {
  return sha256(JSON.stringify(citations.map(citation => ({
    contentHash: citation.contentHash,
    category: citation.category,
  }))));
}

function validateRetrieval(input: {
  readonly retrieval: ValidationRetrieval;
  readonly side: 'monolith' | 'partition';
  readonly anchor: BackstageNotionPartitionCutoverValidationAnchor;
  readonly expectedMode: BackstageNotionRagRetrievalMode;
}): void {
  const { retrieval, anchor } = input;
  if (
    !isPlainObject(retrieval)
    || retrieval.universeId !== anchor.universeId
    || retrieval.retrievalMode !== input.expectedMode
    || typeof retrieval.prompt !== 'string'
    || !Array.isArray(retrieval.citations)
    || retrieval.citations.length < 1
    || retrieval.citations.length > MAX_CITATIONS_PER_PATH
    || !Number.isSafeInteger(retrieval.chunkCount)
    || retrieval.chunkCount !== retrieval.citations.length
    || typeof retrieval.truncated !== 'boolean'
    || !isPlainObject(retrieval.coverage)
    || retrieval.coverage.selectedChunks !== retrieval.chunkCount
    || retrieval.coverage.hasMore !== (retrieval.nextCursor !== null)
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_RETRIEVAL_UNAVAILABLE');
  }
  const coverageCursor = retrieval.coverage.nextCursor;
  if (
    retrieval.nextCursor === null
      ? coverageCursor !== undefined
      : (
          !CURSOR_PATTERN.test(retrieval.nextCursor)
          || coverageCursor !== retrieval.nextCursor
        )
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_CURSOR_INVALID');
  }
  retrieval.citations.forEach(citationSignature);
  if (input.side === 'monolith') {
    if (
      !('snapshotId' in retrieval)
      || retrieval.snapshotId !== anchor.monolithSnapshotId
    ) {
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_VERSION_DRIFT');
    }
    return;
  }
  if (
    !('manifestId' in retrieval)
    || retrieval.manifestId !== anchor.partitionManifestId
    || retrieval.configurationVersionId !== anchor.partitionConfigurationVersionId
    || retrieval.configurationHash !== anchor.partitionConfigurationHash
    || retrieval.configurationCurrent !== true
    || retrieval.routingComplete !== true
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_VERSION_DRIFT');
  }
}

function retrievalShape(
  retrieval: ValidationRetrieval,
  relevantSemantics: boolean
): RetrievalShape {
  return Object.freeze({
    promptDigest: sha256(retrieval.prompt),
    citationDigest: relevantSemantics
      ? relevantCitationDigest(retrieval.citations)
      : sha256(JSON.stringify(retrieval.citations.map(citationSignature))),
    citationCount: retrieval.citations.length,
    retrievalMode: retrieval.retrievalMode,
    chunkCount: retrieval.chunkCount,
    truncated: retrieval.truncated,
    coverageDigest: relevantSemantics
      ? sha256(JSON.stringify({ status: retrieval.coverage.status }))
      : sha256(JSON.stringify(coverageShape(retrieval.coverage))),
  });
}

function sameRetrievalShape(left: RetrievalShape, right: RetrievalShape): boolean {
  return left.promptDigest === right.promptDigest
    && left.citationDigest === right.citationDigest
    && left.citationCount === right.citationCount
    && left.retrievalMode === right.retrievalMode
    && left.chunkCount === right.chunkCount
    && left.truncated === right.truncated
    && left.coverageDigest === right.coverageDigest;
}

async function retrieveOnce(input: {
  readonly item: PreparedValidationCase;
  readonly anchor: BackstageNotionPartitionCutoverValidationAnchor;
  readonly dependencies: BackstageNotionPartitionCutoverValidationDependencies;
}): Promise<Readonly<{
  monolith: BackstageNotionRagRetrieval;
  partition: BackstageNotionPartitionRagRetrieval;
}>> {
  let monolith: BackstageNotionRagRetrieval;
  let partition: BackstageNotionPartitionRagRetrieval;
  try {
    monolith = await input.dependencies.retrieveMonolithPinned({
      universeId: input.anchor.universeId,
      snapshotId: input.anchor.monolithSnapshotId,
      query: input.item.query,
      cursor: null,
    });
    partition = await input.dependencies.retrievePartitionPinned({
      universeId: input.anchor.universeId,
      manifestId: input.anchor.partitionManifestId,
      plan: input.item.partitionPlan,
      cursor: null,
    });
  } catch (error) {
    if (error instanceof BackstageNotionPartitionCutoverValidationError) {
      throw error;
    }
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_RETRIEVAL_UNAVAILABLE');
  }
  validateRetrieval({
    retrieval: monolith,
    side: 'monolith',
    anchor: input.anchor,
    expectedMode: 'relevant',
  });
  validateRetrieval({
    retrieval: partition,
    side: 'partition',
    anchor: input.anchor,
    expectedMode: 'relevant',
  });
  return Object.freeze({ monolith, partition });
}

async function collectCompletePath(input: {
  readonly side: 'monolith' | 'partition';
  readonly item: PreparedValidationCase;
  readonly anchor: BackstageNotionPartitionCutoverValidationAnchor;
  readonly dependencies: BackstageNotionPartitionCutoverValidationDependencies;
}): Promise<CompletePath> {
  let cursor: string | null = null;
  let requestCount = 0;
  let expectedScopeChunks: number | null = null;
  const seenCursors = new Set<string>();
  const seenCitations = new Set<string>();
  const citations: string[] = [];

  while (requestCount < BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_MAX_PAGE_REQUESTS) {
    let retrieval: ValidationRetrieval;
    try {
      retrieval = input.side === 'monolith'
        ? await input.dependencies.retrieveMonolithPinned({
            universeId: input.anchor.universeId,
            snapshotId: input.anchor.monolithSnapshotId,
            query: input.item.query,
            cursor,
          })
        : await input.dependencies.retrievePartitionPinned({
            universeId: input.anchor.universeId,
            manifestId: input.anchor.partitionManifestId,
            plan: input.item.partitionPlan,
            cursor,
          });
    } catch (error) {
      if (error instanceof BackstageNotionPartitionCutoverValidationError) {
        throw error;
      }
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_RETRIEVAL_UNAVAILABLE');
    }
    requestCount += 1;
    validateRetrieval({
      retrieval,
      side: input.side,
      anchor: input.anchor,
      expectedMode: 'complete_scope',
    });
    if (
      !Number.isSafeInteger(retrieval.coverage.scopeChunks)
      || retrieval.coverage.scopeChunks < 1
      || retrieval.coverage.scopeChunks > MAX_CITATIONS_PER_PATH
      || (
        expectedScopeChunks !== null
        && retrieval.coverage.scopeChunks !== expectedScopeChunks
      )
    ) {
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_COVERAGE_INCOMPLETE');
    }
    expectedScopeChunks ??= retrieval.coverage.scopeChunks;
    for (const citation of retrieval.citations) {
      const signature = citationSignature(citation);
      if (seenCitations.has(signature) || citations.length >= MAX_CITATIONS_PER_PATH) {
        fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_COVERAGE_INCOMPLETE');
      }
      seenCitations.add(signature);
      citations.push(signature);
    }
    if (!retrieval.coverage.hasMore) {
      if (citations.length !== expectedScopeChunks) {
        fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_COVERAGE_INCOMPLETE');
      }
      return Object.freeze({
        requestCount,
        citationCount: citations.length,
        citationSetDigest: sha256(JSON.stringify([...citations].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0
        ))),
        scopeChunkCount: expectedScopeChunks,
        continuationObserved: requestCount > 1,
      });
    }
    const nextCursor: string | null = retrieval.nextCursor;
    if (
      nextCursor === null
      || nextCursor === cursor
      || seenCursors.has(nextCursor)
    ) {
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_CURSOR_INVALID');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_CURSOR_INVALID');
}

function compareCompletePaths(left: CompletePath, right: CompletePath): boolean {
  return left.citationCount === right.citationCount
    && left.citationSetDigest === right.citationSetDigest
    && left.scopeChunkCount === right.scopeChunkCount;
}

function comparisonDigest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

async function loadAnchor(
  universeId: string,
  dependencies: BackstageNotionPartitionCutoverValidationDependencies
): Promise<BackstageNotionPartitionCutoverValidationAnchor> {
  try {
    return normalizeAnchor(await dependencies.loadAnchor(universeId), universeId);
  } catch (error) {
    if (error instanceof BackstageNotionPartitionCutoverValidationError) {
      throw error;
    }
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_ANCHOR_UNAVAILABLE');
  }
}

/**
 * Explicitly validate representative monolith/partition parity for one exact
 * immutable authority pair. This function has no scheduler, mode resolver, or
 * production wiring; callers must opt in and supply every read and seal effect.
 */
export async function validateAndSealBackstageNotionPartitionCutover(input: {
  readonly universeId: string;
  readonly cases: readonly BackstageNotionPartitionCutoverValidationCase[];
  readonly dependencies: BackstageNotionPartitionCutoverValidationDependencies;
}): Promise<BackstageNotionPartitionCutoverValidationAttestation> {
  if (
    !UNIVERSE_ID_PATTERN.test(input.universeId)
    || !input.dependencies
    || typeof input.dependencies.loadAnchor !== 'function'
    || typeof input.dependencies.retrieveMonolithPinned !== 'function'
    || typeof input.dependencies.derivePartitionPlan !== 'function'
    || typeof input.dependencies.retrievePartitionPinned !== 'function'
    || typeof input.dependencies.sealEvidence !== 'function'
    || (
      input.dependencies.now !== undefined
      && typeof input.dependencies.now !== 'function'
    )
  ) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
  }
  const cases = validateCases(input.cases);
  const anchor = await loadAnchor(input.universeId, input.dependencies);
  const caseAttestations: BackstageNotionPartitionCutoverValidationCaseAttestation[] = [];

  for (const candidate of cases) {
    const item = await prepareValidationCase({
      item: candidate,
      anchor,
      dependencies: input.dependencies,
    });
    if (item.kind === 'complete_scope') {
      const monolith = await collectCompletePath({
        side: 'monolith',
        item,
        anchor,
        dependencies: input.dependencies,
      });
      const partition = await collectCompletePath({
        side: 'partition',
        item,
        anchor,
        dependencies: input.dependencies,
      });
      if (!compareCompletePaths(monolith, partition)) {
        fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_PARITY_MISMATCH');
      }
      caseAttestations.push(Object.freeze({
        caseId: item.caseId,
        kind: item.kind,
        citationCount: monolith.citationCount,
        monolithRequestCount: monolith.requestCount,
        partitionRequestCount: partition.requestCount,
        cursorContinuationObserved:
          monolith.continuationObserved && partition.continuationObserved,
        requestBindingDigest: item.requestBindingDigest,
        partitionPlanDigest: item.partitionPlanDigest,
        comparisonDigest: comparisonDigest({ monolith, partition }),
      }));
      continue;
    }

    const retrievals = await retrieveOnce({
      item,
      anchor,
      dependencies: input.dependencies,
    });
    const relevantSemantics = item.kind === 'relevant';
    const monolith = retrievalShape(retrievals.monolith, relevantSemantics);
    const partition = retrievalShape(retrievals.partition, relevantSemantics);
    if (!sameRetrievalShape(monolith, partition)) {
      fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_PARITY_MISMATCH');
    }
    caseAttestations.push(Object.freeze({
      caseId: item.caseId,
      kind: item.kind,
      citationCount: monolith.citationCount,
      monolithRequestCount: 1,
      partitionRequestCount: 1,
      cursorContinuationObserved: false,
      requestBindingDigest: item.requestBindingDigest,
      partitionPlanDigest: item.partitionPlanDigest,
      comparisonDigest: comparisonDigest({ monolith, partition }),
    }));
  }

  const cursorContinuationCaseCount = caseAttestations.filter(item =>
    item.kind === 'complete_scope' && item.cursorContinuationObserved
  ).length;
  if (cursorContinuationCaseCount < 1) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_COVERAGE_INCOMPLETE');
  }

  const stableCases = Object.freeze([...caseAttestations].sort((left, right) =>
    left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0
  ));
  const exactScopeCaseCount = stableCases.filter(item => item.kind === 'exact_scope').length;
  const relevantCaseCount = stableCases.filter(item => item.kind === 'relevant').length;
  const completeScopeCaseCount = stableCases.filter(
    item => item.kind === 'complete_scope'
  ).length;
  const monolithRequestCount = stableCases.reduce(
    (total, item) => total + item.monolithRequestCount,
    0
  );
  const partitionRequestCount = stableCases.reduce(
    (total, item) => total + item.partitionRequestCount,
    0
  );
  const citationCount = stableCases.reduce((total, item) => total + item.citationCount, 0);
  const digestInput = Object.freeze({
    version: BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_VERSION,
    universeId: anchor.universeId,
    monolithSnapshotId: anchor.monolithSnapshotId,
    partitionManifestId: anchor.partitionManifestId,
    partitionConfigurationVersionId: anchor.partitionConfigurationVersionId,
    partitionConfigurationHash: anchor.partitionConfigurationHash,
    partitionSourceGenerationId: anchor.partitionSourceGenerationId,
    partitionSourceDigest: anchor.partitionSourceDigest,
    partitionSourceVerificationHash: anchor.partitionSourceVerificationHash,
    reconciliationGeneration: anchor.reconciliationGeneration,
    rollbackMonolithVerifiedAt: anchor.rollbackMonolithVerifiedAt,
    rollbackMonolithValidUntil: anchor.rollbackMonolithValidUntil,
    caseCount: stableCases.length,
    exactScopeCaseCount,
    relevantCaseCount,
    completeScopeCaseCount,
    cursorContinuationCaseCount,
    monolithRequestCount,
    partitionRequestCount,
    citationCount,
    cases: stableCases,
  });
  const now = input.dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID');
  }
  const attestation: BackstageNotionPartitionCutoverValidationAttestation = Object.freeze({
    ...digestInput,
    exactScopeParityPassed: true,
    relevantRetrievalParityPassed: true,
    completeScopeParityPassed: true,
    cursorStabilityPassed: true,
    attestationDigest: comparisonDigest(digestInput),
    validatedAt: new Date(now.getTime()),
  });

  const terminalAnchor = await loadAnchor(input.universeId, input.dependencies);
  if (!sameAnchor(anchor, terminalAnchor)) {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_ANCHOR_CHANGED');
  }
  try {
    await input.dependencies.sealEvidence(attestation);
  } catch {
    fail('BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_EVIDENCE_SEAL_FAILED');
  }
  return attestation;
}

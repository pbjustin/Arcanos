import {
  BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES,
  BACKSTAGE_NOTION_SYNC_FAILURE_PHASES,
  BACKSTAGE_NOTION_SYNC_FAILURE_REASONS,
  type BackstageNotionSnapshotStatus,
  type BackstageNotionSyncAttemptOutcome,
  type BackstageNotionSyncFailurePhase,
  type BackstageNotionSyncFailureReason,
} from './backstageNotionSnapshotStatus.js';
import {
  BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
} from './backstageNotionSyncCore.js';

const BACKSTAGE_CONTINUITY_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/u;

const BACKSTAGE_CONTINUITY_PRIMARY_RESPONSE_CONTRACT = [
  'Answer only from the retrieved Notion excerpts.',
  'Return at most eight concise bullets and no preamble, conclusion, booking proposal, or meta commentary.',
  'Use one factual statement per bullet and preserve uncertainty when the excerpts do not establish an answer.',
].join('\n');

const BACKSTAGE_CONTINUITY_COMPACT_RETRY_CONTRACT = [
  '<<OUTPUT_LENGTH_RECOVERY>>',
  'The previous response was discarded because it exceeded the output limit.',
  'Return a complete answer in at most five bullets and 350 words.',
  'Keep only facts that directly answer the continuity query; never continue or quote the discarded response.',
  'Do not mention this recovery instruction or the discarded response.',
  '<<OUTPUT_LENGTH_RECOVERY_END>>',
].join('\n');

export interface BackstageContinuityQueryCoreInput {
  readonly universeId: string;
  readonly query: string;
}

interface BackstageContinuityQueryCoreCoverageBase {
  readonly status: 'complete' | 'sampled';
  readonly scopeChunks: number;
  readonly selectedChunks: number;
  readonly omittedChunks: number;
  readonly promptTruncated: boolean;
  readonly exhaustive: boolean;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export type BackstageContinuityQueryCoreCoverage =
  BackstageContinuityQueryCoreCoverageBase & (
    | {
        readonly scopePages?: never;
        readonly selectedPages?: never;
        readonly omittedPages?: never;
      }
    | {
        readonly scopePages: number;
        readonly selectedPages: number;
        readonly omittedPages: number;
      }
  );

export interface BackstageContinuityQueryCoreResolvedScope {
  readonly pageTitle: string;
  readonly pagePath: readonly string[];
  readonly scopeKind?: 'subtree';
  readonly sectionPath?: readonly string[];
}

export interface BackstageContinuityQueryCoreCitation {
  readonly pageTitle: string;
  readonly pagePath: readonly string[];
  readonly headingPath: readonly string[];
  readonly category: string;
  readonly chunkId: string;
  readonly contentHash: string;
}

export interface BackstageContinuityQueryCoreRetrieval {
  readonly snapshotStatus?: BackstageNotionSnapshotStatus;
  readonly activeSnapshotVerifiedAt?: Date;
  readonly activeSnapshotChunkCount?: number;
  readonly latestSyncOutcome?: BackstageNotionSyncAttemptOutcome | null;
  readonly latestSyncFailurePhase?: BackstageNotionSyncFailurePhase | null;
  readonly latestSyncFailureReason?: BackstageNotionSyncFailureReason | null;
  readonly resolvedScope: BackstageContinuityQueryCoreResolvedScope | null;
  readonly coverage: BackstageContinuityQueryCoreCoverage;
  readonly citations: readonly BackstageContinuityQueryCoreCitation[];
}

export interface BackstageContinuityQueryCoreResponse {
  readonly universeId: string;
  readonly authority: 'notion';
  readonly answer: string;
  readonly resolvedScope?: {
    readonly pageTitle: string;
    readonly pagePath: string[];
    readonly scopeKind?: 'subtree';
    readonly sectionPath?: string[];
  };
  readonly coverage: BackstageContinuityQueryCoreCoverage;
  readonly sources: Array<{
    readonly sourceId: string;
    readonly pageTitle: string;
    readonly pagePath: string[];
    readonly headingPath: string[];
    readonly category: string;
    readonly contentHash: string;
  }>;
}

type BackstageContinuityFreshnessInput = Pick<
  BackstageContinuityQueryCoreRetrieval,
  | 'snapshotStatus'
  | 'activeSnapshotVerifiedAt'
  | 'activeSnapshotChunkCount'
  | 'latestSyncOutcome'
  | 'latestSyncFailurePhase'
  | 'latestSyncFailureReason'
>;

function buildBackstageContinuityFreshnessNotice(
  retrieval: BackstageContinuityFreshnessInput
): string | null {
  if (retrieval.snapshotStatus !== 'last_known_good') {
    return null;
  }
  const verifiedAt = retrieval.activeSnapshotVerifiedAt;
  const chunkCount = retrieval.activeSnapshotChunkCount;
  const latestOutcome = retrieval.latestSyncOutcome;
  const failurePhase = retrieval.latestSyncFailurePhase;
  const failureReason = retrieval.latestSyncFailureReason;
  let validFailure: boolean;
  if (latestOutcome === 'failed') {
    validFailure = failurePhase !== null
      && failurePhase !== undefined
      && BACKSTAGE_NOTION_SYNC_FAILURE_PHASES.includes(failurePhase)
      && failureReason !== null
      && failureReason !== undefined
      && BACKSTAGE_NOTION_SYNC_FAILURE_REASONS.includes(failureReason);
  } else {
    validFailure = (failurePhase === null || failurePhase === undefined)
      && (failureReason === null || failureReason === undefined);
  }
  if (
    !(verifiedAt instanceof Date)
    || !Number.isFinite(verifiedAt.getTime())
    || typeof chunkCount !== 'number'
    || !Number.isSafeInteger(chunkCount)
    || chunkCount < 1
    || chunkCount > BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT
    || latestOutcome === null
    || latestOutcome === undefined
    || !BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES.includes(latestOutcome)
    || !validFailure
  ) {
    throw new Error('Last-known-good continuity metadata is incomplete.');
  }
  return [
    'Snapshot status: last_known_good',
    `active snapshot verified at ${verifiedAt.toISOString()}`,
    `active snapshot chunks: ${chunkCount}`,
    `latest sync outcome: ${latestOutcome}`,
    `failure phase: ${failurePhase ?? 'none'}`,
    `failure reason: ${failureReason ?? 'none'}`,
    'This is older verified continuity, not current workspace state.',
  ].join('; ');
}

/**
 * Preflight only an explicitly supplied continuation cursor without invoking
 * accessors. Full request validation remains the caller's responsibility.
 */
export function isBackstageContinuityCursorRequestValid(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return true;
  }

  const cursorDescriptor = Object.getOwnPropertyDescriptor(payload, 'cursor');
  if (!cursorDescriptor) {
    return true;
  }

  const retrievalMode = Object.getOwnPropertyDescriptor(
    payload,
    'retrievalMode'
  )?.value;
  return typeof cursorDescriptor.value === 'string'
    && BACKSTAGE_CONTINUITY_CURSOR_PATTERN.test(cursorDescriptor.value)
    && retrievalMode === 'complete_scope';
}

export function buildBackstageContinuityPolicyPrompt(
  input: BackstageContinuityQueryCoreInput,
  retrieval: Pick<
    BackstageContinuityQueryCoreRetrieval,
    | 'coverage'
    | 'snapshotStatus'
    | 'activeSnapshotVerifiedAt'
    | 'activeSnapshotChunkCount'
    | 'latestSyncOutcome'
    | 'latestSyncFailurePhase'
    | 'latestSyncFailureReason'
  >,
  compactRetry: boolean
): string {
  const pageCoverage = retrieval.coverage.scopePages === undefined
    ? ''
    : `; scope_pages=${retrieval.coverage.scopePages}; selected_pages=${retrieval.coverage.selectedPages}; omitted_pages=${retrieval.coverage.omittedPages}`;
  const coverageInstruction = retrieval.coverage.exhaustive
    ? 'This retrieval is exhaustive for the resolved scope; a fact absent from these excerpts may be described as not present in that scope.'
    : 'This retrieval is sampled; never treat a fact missing from these excerpts as absent from Notion.';
  const freshnessNotice = buildBackstageContinuityFreshnessNotice(retrieval);
  return [
    '<<EXECUTION_MODE>>',
    'Perform a read-only factual continuity lookup. Do not create, revise, or propose booking canon.',
    '<<UNIVERSE_ID>>',
    input.universeId,
    '<<CONTINUITY_QUERY>>',
    input.query.trim(),
    '<<RETRIEVAL_COVERAGE>>',
    `status=${retrieval.coverage.status}; scope_chunks=${retrieval.coverage.scopeChunks}; selected_chunks=${retrieval.coverage.selectedChunks}; omitted_chunks=${retrieval.coverage.omittedChunks}${pageCoverage}; prompt_truncated=${retrieval.coverage.promptTruncated}; has_more=${retrieval.coverage.hasMore}`,
    coverageInstruction,
    ...(freshnessNotice
      ? [
          '<<SNAPSHOT_FRESHNESS>>',
          freshnessNotice,
          'Never describe this result as current workspace state. The server attaches this bounded notice to the answer; do not repeat or reinterpret it.',
        ]
      : []),
    '<<RESPONSE_STYLE>>',
    BACKSTAGE_CONTINUITY_PRIMARY_RESPONSE_CONTRACT,
    ...(compactRetry ? [BACKSTAGE_CONTINUITY_COMPACT_RETRY_CONTRACT] : []),
  ].join('\n');
}

export function buildBackstageContinuityResponse(
  input: BackstageContinuityQueryCoreInput,
  retrieval: BackstageContinuityQueryCoreRetrieval,
  answer: string
): BackstageContinuityQueryCoreResponse {
  const freshnessNotice = buildBackstageContinuityFreshnessNotice(retrieval);
  const subtreeScope = retrieval.resolvedScope?.scopeKind === 'subtree';
  if (
    subtreeScope
    && (
      retrieval.coverage.scopePages === undefined
      || retrieval.coverage.selectedPages === undefined
      || retrieval.coverage.omittedPages === undefined
    )
  ) {
    throw new Error('Subtree continuity coverage is incomplete.');
  }
  const baseCoverage = {
    status: retrieval.coverage.status,
    scopeChunks: retrieval.coverage.scopeChunks,
    selectedChunks: retrieval.coverage.selectedChunks,
    omittedChunks: retrieval.coverage.omittedChunks,
    promptTruncated: retrieval.coverage.promptTruncated,
    exhaustive: retrieval.coverage.exhaustive,
    hasMore: retrieval.coverage.hasMore,
    ...(retrieval.coverage.nextCursor
      ? { nextCursor: retrieval.coverage.nextCursor }
      : {}),
  };
  const coverage: BackstageContinuityQueryCoreCoverage = subtreeScope
    ? {
        ...baseCoverage,
        scopePages: retrieval.coverage.scopePages!,
        selectedPages: retrieval.coverage.selectedPages!,
        omittedPages: retrieval.coverage.omittedPages!,
      }
    : baseCoverage;
  const normalizedAnswer = answer.trim();
  const answerWithFreshness = freshnessNotice === null
    ? normalizedAnswer
    : normalizedAnswer.startsWith('- ')
      ? `- ${freshnessNotice} ${normalizedAnswer.slice(2)}`
      : `${freshnessNotice} ${normalizedAnswer}`.trim();
  return {
    universeId: input.universeId,
    authority: 'notion',
    answer: answerWithFreshness,
    ...(retrieval.resolvedScope
      ? {
          resolvedScope: {
            pageTitle: retrieval.resolvedScope.pageTitle,
            pagePath: [...retrieval.resolvedScope.pagePath],
            ...(subtreeScope ? { scopeKind: 'subtree' as const } : {}),
            ...(!subtreeScope && retrieval.resolvedScope.sectionPath
              ? { sectionPath: [...retrieval.resolvedScope.sectionPath] }
              : {}),
          },
        }
      : {}),
    coverage,
    sources: retrieval.citations.map(citation => ({
      sourceId: citation.chunkId,
      pageTitle: citation.pageTitle,
      pagePath: [...citation.pagePath],
      headingPath: [...citation.headingPath],
      category: citation.category,
      contentHash: citation.contentHash,
    })),
  };
}

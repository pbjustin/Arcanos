import {
  getBackstageNotionMonolithAuthorityStatusRepository,
  type BackstageNotionMonolithAuthorityOperationalState,
  type BackstageNotionMonolithAuthorityStatusRepository,
} from '@core/db/repositories/backstageNotionSyncStatusRepository.js';
import {
  BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import {
  resolveBackstageNotionAuthorityRoot as resolveConfiguredAuthorityRoot,
} from '@shared/backstage/backstageNotionAuthorityCore.js';
import {
  BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
} from '@shared/backstage/backstageNotionSyncCore.js';
import {
  BACKSTAGE_NOTION_RAG_MAX_STALENESS_DEFAULT_MS,
  BACKSTAGE_NOTION_RAG_MAX_STALENESS_ENV_NAME,
  BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES,
  BACKSTAGE_NOTION_SYNC_FAILURE_PHASES,
  BACKSTAGE_NOTION_SYNC_FAILURE_REASONS,
  boundBackstageNotionRagMaximumStalenessMs,
  resolveBackstageNotionSnapshotStatusObservation,
  type BackstageNotionLatestSyncAttemptObservation,
  type BackstageNotionSnapshotStatus,
  type BackstageNotionSyncAttemptOutcome,
  type BackstageNotionSyncFailurePhase,
  type BackstageNotionSyncFailureReason,
} from '@shared/backstage/backstageNotionSnapshotStatus.js';
import {
  readBackstageNotionAuthorityConfiguration,
  type BackstageNotionAuthorityEnvironmentReader,
} from './backstageNotionAuthority.js';
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from './openai/embeddings.js';

export const BACKSTAGE_NOTION_MONOLITH_AUTHORITY_STATUS_VERSION = 1;

export type BackstageNotionMonolithAuthorityOperationalStatus =
  | BackstageNotionSnapshotStatus
  | 'syncing';

export interface BackstageNotionMonolithAuthorityStatusData {
  readonly version: typeof BACKSTAGE_NOTION_MONOLITH_AUTHORITY_STATUS_VERSION;
  readonly surface: 'monolith_authority';
  readonly authority: 'notion';
  readonly status: BackstageNotionMonolithAuthorityOperationalStatus;
  readonly snapshotStatus: BackstageNotionSnapshotStatus;
  readonly freshnessSatisfied: boolean;
  readonly syncInProgress: boolean;
  readonly activeSnapshotReadable: boolean;
  readonly activeSnapshotChunkCount: number;
  readonly latestSyncOutcome: BackstageNotionSyncAttemptOutcome | null;
  readonly latestSyncFailurePhase: BackstageNotionSyncFailurePhase | null;
  readonly latestSyncFailureReason: BackstageNotionSyncFailureReason | null;
}

export type BackstageNotionMonolithAuthorityStatusResolution =
  | Readonly<{ status: 'ready'; data: BackstageNotionMonolithAuthorityStatusData }>
  | Readonly<{ status: 'not_found' | 'unavailable' }>;

export interface BackstageNotionMonolithAuthorityStatusDependencies {
  readonly readEnvironment?: BackstageNotionAuthorityEnvironmentReader;
  readonly repository?: BackstageNotionMonolithAuthorityStatusRepository;
  readonly maximumStalenessMs?: number;
}

export interface ResolveBackstageNotionMonolithAuthorityStatusInput {
  readonly universeId: string;
  readonly dependencies?: BackstageNotionMonolithAuthorityStatusDependencies;
}

export interface BackstageNotionMonolithAuthorityStatusHttpResult {
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}

const SYNC_OUTCOMES = new Set<string>(BACKSTAGE_NOTION_SYNC_ATTEMPT_OUTCOMES);
const FAILURE_PHASES = new Set<string>(BACKSTAGE_NOTION_SYNC_FAILURE_PHASES);
const FAILURE_REASONS = new Set<string>(BACKSTAGE_NOTION_SYNC_FAILURE_REASONS);
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function unavailableResolution(): BackstageNotionMonolithAuthorityStatusResolution {
  return Object.freeze({ status: 'unavailable' as const });
}

function projectLatestAttempt(
  latest: BackstageNotionLatestSyncAttemptObservation | null
): Pick<
  BackstageNotionMonolithAuthorityStatusData,
  'latestSyncOutcome' | 'latestSyncFailurePhase' | 'latestSyncFailureReason'
> {
  if (latest === null) {
    return Object.freeze({
      latestSyncOutcome: null,
      latestSyncFailurePhase: null,
      latestSyncFailureReason: null,
    });
  }
  const raw = latest as unknown as {
    outcome?: unknown;
    failurePhase?: unknown;
    failureReason?: unknown;
  };
  const latestSyncOutcome = typeof raw.outcome === 'string'
    && SYNC_OUTCOMES.has(raw.outcome)
    ? raw.outcome as BackstageNotionSyncAttemptOutcome
    : null;
  const latestSyncFailurePhase = typeof raw.failurePhase === 'string'
    && FAILURE_PHASES.has(raw.failurePhase)
    ? raw.failurePhase as BackstageNotionSyncFailurePhase
    : null;
  const latestSyncFailureReason = typeof raw.failureReason === 'string'
    && FAILURE_REASONS.has(raw.failureReason)
    ? raw.failureReason as BackstageNotionSyncFailureReason
    : null;
  if (
    latestSyncOutcome === null
    || (latestSyncOutcome === 'failed'
      ? latestSyncFailurePhase === null || latestSyncFailureReason === null
      : latestSyncFailurePhase !== null || latestSyncFailureReason !== null)
  ) {
    return Object.freeze({
      latestSyncOutcome: null,
      latestSyncFailurePhase: null,
      latestSyncFailureReason: null,
    });
  }
  return Object.freeze({
    latestSyncOutcome,
    latestSyncFailurePhase,
    latestSyncFailureReason,
  });
}

function activeStateMatchesEffectiveRoot(
  state: BackstageNotionMonolithAuthorityOperationalState,
  configuredRootPresent: boolean
): boolean {
  return state.durableAuthority === 'notion'
    && state.activeSnapshotReadable
    && state.durableRootPresent
    && (!configuredRootPresent || state.configuredRootMatchesDurable === true);
}

function isLatestAttemptShapeValid(
  latest: BackstageNotionLatestSyncAttemptObservation | null,
  observedAtMs: number
): boolean {
  if (latest === null) {
    return true;
  }
  const startedAtMs = latest.startedAt instanceof Date
    ? latest.startedAt.getTime()
    : Number.NaN;
  const completedAtMs = latest.completedAt instanceof Date
    ? latest.completedAt.getTime()
    : Number.NaN;
  if (
    !Number.isFinite(startedAtMs)
    || startedAtMs - observedAtMs > MAXIMUM_CLOCK_SKEW_MS
    || !SYNC_OUTCOMES.has(latest.outcome)
    || (latest.completedAt !== null && (
      !Number.isFinite(completedAtMs)
      || completedAtMs < startedAtMs
      || completedAtMs - observedAtMs > MAXIMUM_CLOCK_SKEW_MS
    ))
  ) {
    return false;
  }
  if (latest.outcome === 'running') {
    return latest.completedAt === null
      && latest.successfulSnapshotMatchesActive === null
      && latest.failurePhase === null
      && latest.failureReason === null;
  }
  if (latest.outcome === 'failed') {
    return latest.completedAt !== null
      && latest.successfulSnapshotMatchesActive === null
      && typeof latest.failurePhase === 'string'
      && FAILURE_PHASES.has(latest.failurePhase)
      && typeof latest.failureReason === 'string'
      && FAILURE_REASONS.has(latest.failureReason);
  }
  return latest.completedAt !== null
    && typeof latest.successfulSnapshotMatchesActive === 'boolean'
    && latest.failurePhase === null
    && latest.failureReason === null;
}

function assertOperationalStateShape(
  state: BackstageNotionMonolithAuthorityOperationalState,
  configuredRootPresent: boolean
): void {
  const observedAtValid = state.observedAt instanceof Date
    && Number.isFinite(state.observedAt.getTime());
  const verifiedAtValid = state.activeSnapshotVerifiedAt === null
    || (
      state.activeSnapshotVerifiedAt instanceof Date
      && Number.isFinite(state.activeSnapshotVerifiedAt.getTime())
    );
  const pageCountValid = Number.isSafeInteger(state.activeSnapshotPageCount)
    && state.activeSnapshotPageCount >= 0
    && state.activeSnapshotPageCount
      <= BACKSTAGE_NOTION_MAX_PAGES_PER_SNAPSHOT;
  const chunkCountValid = Number.isSafeInteger(state.activeSnapshotChunkCount)
    && state.activeSnapshotChunkCount >= 0
    && state.activeSnapshotChunkCount
      <= BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT;
  const configuredRootMatchValid = configuredRootPresent
    && state.durableAuthority === 'notion'
    ? typeof state.configuredRootMatchesDurable === 'boolean'
    : state.configuredRootMatchesDurable === null;
  const absentSnapshotShapeValid = state.activeSnapshotPresent || (
    !state.activeSnapshotReadable
    && !state.durableRootPresent
    && state.activeSnapshotVerifiedAt === null
    && state.activeSnapshotPageCount === 0
    && state.activeSnapshotChunkCount === 0
  );
  const readableSnapshotShapeValid = !state.activeSnapshotReadable || (
    state.activeSnapshotPresent
    && state.durableAuthority === 'notion'
    && state.durableRootPresent
    && state.activeSnapshotVerifiedAt !== null
    && state.activeSnapshotPageCount >= 1
    && state.activeSnapshotChunkCount >= 1
  );
  const latestAttemptShapeValid = isLatestAttemptShapeValid(
    state.latestSyncAttempt,
    state.observedAt instanceof Date
      ? state.observedAt.getTime()
      : Number.NaN
  );

  if (
    !observedAtValid
    || !verifiedAtValid
    || !pageCountValid
    || !chunkCountValid
    || typeof state.durableRootPresent !== 'boolean'
    || typeof state.activeSnapshotPresent !== 'boolean'
    || typeof state.activeSnapshotReadable !== 'boolean'
    || typeof state.syncInProgress !== 'boolean'
    || !configuredRootMatchValid
    || !absentSnapshotShapeValid
    || !readableSnapshotShapeValid
    || !latestAttemptShapeValid
    || (state.durableRootPresent && state.durableAuthority !== 'notion')
  ) {
    throw new Error('Backstage Notion authority observation is invalid.');
  }
}

/**
 * Resolve a closed monolith-only authority state from one integrity-checked
 * PostgreSQL observation. This seam performs no provider, embedding, or corpus
 * read and is safe for protected generation admission checks.
 */
export async function resolveBackstageNotionMonolithAuthorityStatus(
  input: ResolveBackstageNotionMonolithAuthorityStatusInput
): Promise<BackstageNotionMonolithAuthorityStatusResolution> {
  const configured = readBackstageNotionAuthorityConfiguration({
    readEnvironment: input.dependencies?.readEnvironment,
  });
  if (configured.status === 'invalid') {
    return unavailableResolution();
  }
  const configuredRoot = resolveConfiguredAuthorityRoot(
    configured,
    input.universeId
  );

  let state: BackstageNotionMonolithAuthorityOperationalState;
  let maximumStalenessMs: number;
  try {
    const repository = input.dependencies?.repository
      ?? getBackstageNotionMonolithAuthorityStatusRepository();
    state = await repository.loadMonolithAuthorityOperationalState({
      universeId: input.universeId,
      configuredRootPageId: configuredRoot?.rootPageId ?? null,
      expectedEmbeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    });
    maximumStalenessMs = boundBackstageNotionRagMaximumStalenessMs(
      input.dependencies?.maximumStalenessMs
        ?? getEnvNumber(
          BACKSTAGE_NOTION_RAG_MAX_STALENESS_ENV_NAME,
          BACKSTAGE_NOTION_RAG_MAX_STALENESS_DEFAULT_MS
        )
    );
  } catch {
    return unavailableResolution();
  }

  try {
    assertOperationalStateShape(state, configuredRoot !== null);
    if (
      state.durableAuthority === 'notion'
      && !state.durableRootPresent
    ) {
      return unavailableResolution();
    }
    if (
      configuredRoot
      && state.durableAuthority === 'notion'
      && state.configuredRootMatchesDurable !== true
    ) {
      return unavailableResolution();
    }
    if (!configuredRoot && state.durableAuthority !== 'notion') {
      return Object.freeze({ status: 'not_found' as const });
    }

    const activeSnapshotReadable = activeStateMatchesEffectiveRoot(
      state,
      configuredRoot !== null
    );
    if (state.activeSnapshotPresent && !activeSnapshotReadable) {
      return unavailableResolution();
    }
    const snapshotResolution = resolveBackstageNotionSnapshotStatusObservation({
      activeSnapshotPresent: state.activeSnapshotPresent,
      activeSnapshotReadable,
      activeSnapshotVerifiedAt: state.activeSnapshotVerifiedAt,
      now: state.observedAt,
      maximumStalenessMs,
      latestSyncAttempt: state.latestSyncAttempt,
    });
    if (activeSnapshotReadable && snapshotResolution.status === 'unavailable') {
      return unavailableResolution();
    }
    const latestProjection = projectLatestAttempt(state.latestSyncAttempt);
    const snapshotStatus = snapshotResolution.status;
    const data: BackstageNotionMonolithAuthorityStatusData = Object.freeze({
      version: BACKSTAGE_NOTION_MONOLITH_AUTHORITY_STATUS_VERSION,
      surface: 'monolith_authority' as const,
      authority: 'notion' as const,
      status: state.syncInProgress ? 'syncing' as const : snapshotStatus,
      snapshotStatus,
      freshnessSatisfied: snapshotResolution.fresh,
      syncInProgress: state.syncInProgress,
      activeSnapshotReadable,
      activeSnapshotChunkCount: activeSnapshotReadable
        ? state.activeSnapshotChunkCount
        : 0,
      ...latestProjection,
    });
    return Object.freeze({ status: 'ready' as const, data });
  } catch {
    return unavailableResolution();
  }
}

function response(
  statusCode: number,
  payload: Record<string, unknown>
): BackstageNotionMonolithAuthorityStatusHttpResult {
  return Object.freeze({ statusCode, payload: Object.freeze(payload) });
}

function errorResponse(
  statusCode: number,
  code: string,
  message: string
): BackstageNotionMonolithAuthorityStatusHttpResult {
  return response(statusCode, {
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

/** Map the reusable closed resolution to the authenticated HTTP contract. */
export async function getBackstageNotionMonolithAuthorityStatus(
  input: ResolveBackstageNotionMonolithAuthorityStatusInput
): Promise<BackstageNotionMonolithAuthorityStatusHttpResult> {
  const resolution = await resolveBackstageNotionMonolithAuthorityStatus(input);
  if (resolution.status === 'not_found') {
    return errorResponse(
      404,
      'BACKSTAGE_NOTION_AUTHORITY_STATUS_NOT_FOUND',
      'The Notion authority status target was not found.'
    );
  }
  if (resolution.status === 'unavailable') {
    return errorResponse(
      503,
      'BACKSTAGE_NOTION_AUTHORITY_STATUS_UNAVAILABLE',
      'Notion authority status is unavailable.'
    );
  }
  if (resolution.status !== 'ready') {
    return errorResponse(
      503,
      'BACKSTAGE_NOTION_AUTHORITY_STATUS_UNAVAILABLE',
      'Notion authority status is unavailable.'
    );
  }
  return response(200, { ok: true, data: resolution.data });
}

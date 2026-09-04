import { describe, expect, it, jest } from '@jest/globals';

import type {
  BackstageNotionMonolithAuthorityOperationalState,
  BackstageNotionMonolithAuthorityStatusRepository,
} from '../src/core/db/repositories/backstageNotionSyncStatusRepository.js';
import {
  getBackstageNotionMonolithAuthorityStatus,
  resolveBackstageNotionMonolithAuthorityStatus,
} from '../src/services/backstageNotionAuthorityStatus.js';
import {
  BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME,
} from '../src/shared/backstage/backstageNotionAuthorityCore.js';

const UNIVERSE_ID = 'my-universe-2k26';
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const OBSERVED_AT = new Date('2026-09-03T16:00:00.000Z');
const VERIFIED_AT = new Date('2026-09-03T15:55:00.000Z');

function authorityConfiguration(rootPageId = ROOT_PAGE_ID): string {
  return JSON.stringify({
    [UNIVERSE_ID]: {
      rootPageId,
      displayName: 'Synthetic authority root',
    },
  });
}

function configuredEnvironment(
  configuration = authorityConfiguration()
): (name: string) => string | undefined {
  return name => name === BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME
    ? configuration
    : undefined;
}

function operationalState(
  overrides: Partial<BackstageNotionMonolithAuthorityOperationalState> = {}
): BackstageNotionMonolithAuthorityOperationalState {
  return {
    observedAt: OBSERVED_AT,
    durableAuthority: 'notion',
    durableRootPresent: true,
    configuredRootMatchesDurable: true,
    activeSnapshotPresent: true,
    activeSnapshotVerifiedAt: VERIFIED_AT,
    activeSnapshotPageCount: 2,
    activeSnapshotChunkCount: 3,
    activeSnapshotReadable: true,
    latestSyncAttempt: {
      startedAt: new Date('2026-09-03T15:56:00.000Z'),
      completedAt: new Date('2026-09-03T15:58:00.000Z'),
      outcome: 'unchanged',
      successfulSnapshotMatchesActive: true,
      failurePhase: null,
      failureReason: null,
    },
    syncInProgress: false,
    ...overrides,
  };
}

function repositoryReturning(
  state: BackstageNotionMonolithAuthorityOperationalState
): BackstageNotionMonolithAuthorityStatusRepository & {
  loadMonolithAuthorityOperationalState: ReturnType<typeof jest.fn>;
} {
  return {
    loadMonolithAuthorityOperationalState: jest.fn(async () => state),
  };
}

describe('Backstage Notion monolith authority operational status', () => {
  it('reports current_complete from one integrity-checked repository read', async () => {
    const repository = repositoryReturning(operationalState());

    const resolution = await resolveBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment(),
        repository,
        maximumStalenessMs: 60 * 60 * 1_000,
      },
    });

    expect(repository.loadMonolithAuthorityOperationalState).toHaveBeenCalledWith({
      universeId: UNIVERSE_ID,
      configuredRootPageId: ROOT_PAGE_ID,
      expectedEmbeddingModel: 'text-embedding-3-small',
    });
    expect(resolution).toEqual({
      status: 'ready',
      data: {
        version: 1,
        surface: 'monolith_authority',
        authority: 'notion',
        status: 'current_complete',
        snapshotStatus: 'current_complete',
        freshnessSatisfied: true,
        syncInProgress: false,
        activeSnapshotReadable: true,
        activeSnapshotChunkCount: 3,
        latestSyncOutcome: 'unchanged',
        latestSyncFailurePhase: null,
        latestSyncFailureReason: null,
      },
    });
  });

  it.each([
    ['a newer failed refresh', operationalState({
      latestSyncAttempt: {
        startedAt: new Date('2026-09-03T15:56:00.000Z'),
        completedAt: new Date('2026-09-03T15:58:00.000Z'),
        outcome: 'failed',
        successfulSnapshotMatchesActive: null,
        failurePhase: 'embedding',
        failureReason: 'embedding_failed',
      },
    }), true],
    ['a stale active snapshot', operationalState({
      activeSnapshotVerifiedAt: new Date('2026-09-03T13:00:00.000Z'),
    }), false],
  ] as const)('reports last_known_good for %s', async (_label, state, fresh) => {
    const resolution = await resolveBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment(),
        repository: repositoryReturning(state),
        maximumStalenessMs: 60 * 60 * 1_000,
      },
    });

    expect(resolution.status).toBe('ready');
    if (resolution.status === 'ready') {
      expect(resolution.data.status).toBe('last_known_good');
      expect(resolution.data.snapshotStatus).toBe('last_known_good');
      expect(resolution.data.freshnessSatisfied).toBe(fresh);
    }
  });

  it('reports syncing only from a live lease, including before first activation', async () => {
    const firstActivation = operationalState({
      durableAuthority: 'postgres',
      durableRootPresent: false,
      configuredRootMatchesDurable: null,
      activeSnapshotPresent: false,
      activeSnapshotVerifiedAt: null,
      activeSnapshotPageCount: 0,
      activeSnapshotChunkCount: 0,
      activeSnapshotReadable: false,
      latestSyncAttempt: {
        startedAt: new Date('2026-09-03T15:59:00.000Z'),
        completedAt: null,
        outcome: 'running',
        successfulSnapshotMatchesActive: null,
        failurePhase: null,
        failureReason: null,
      },
      syncInProgress: true,
    });
    const resolution = await resolveBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment(),
        repository: repositoryReturning(firstActivation),
        maximumStalenessMs: 60 * 60 * 1_000,
      },
    });

    expect(resolution).toMatchObject({
      status: 'ready',
      data: {
        status: 'syncing',
        snapshotStatus: 'unavailable',
        freshnessSatisfied: false,
        syncInProgress: true,
        activeSnapshotReadable: false,
        activeSnapshotChunkCount: 0,
      },
    });
  });

  it('does not infer syncing from an orphan running attempt', async () => {
    const resolution = await resolveBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment(),
        repository: repositoryReturning(operationalState({
          latestSyncAttempt: {
            startedAt: new Date('2026-09-03T15:56:00.000Z'),
            completedAt: null,
            outcome: 'running',
            successfulSnapshotMatchesActive: null,
            failurePhase: null,
            failureReason: null,
          },
          syncInProgress: false,
        })),
        maximumStalenessMs: 60 * 60 * 1_000,
      },
    });

    expect(resolution.status).toBe('ready');
    if (resolution.status === 'ready') {
      expect(resolution.data.status).toBe('last_known_good');
      expect(resolution.data.syncInProgress).toBe(false);
    }
  });

  it('reports valid no-snapshot authority as unavailable without leaking state', async () => {
    const resolution = await resolveBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment(),
        repository: repositoryReturning(operationalState({
          durableAuthority: 'postgres',
          durableRootPresent: false,
          configuredRootMatchesDurable: null,
          activeSnapshotPresent: false,
          activeSnapshotVerifiedAt: null,
          activeSnapshotPageCount: 0,
          activeSnapshotChunkCount: 0,
          activeSnapshotReadable: false,
          latestSyncAttempt: null,
        })),
        maximumStalenessMs: 60 * 60 * 1_000,
      },
    });

    expect(resolution).toMatchObject({
      status: 'ready',
      data: {
        status: 'unavailable',
        snapshotStatus: 'unavailable',
        freshnessSatisfied: false,
      },
    });
  });

  it.each([
    'malformed manifest',
    'wrong embedding model',
    'verification before snapshot creation',
    'invalid page scope metadata',
    'invalid chunk scope metadata',
    'snapshot count mismatch',
    'missing root page',
  ])('returns fixed 503 when PostgreSQL rejects %s', async corruption => {
    const hostileState = {
      ...operationalState({ activeSnapshotReadable: false }),
      corruption,
      snapshotId: 'hostile-snapshot-id',
      content: 'hostile-authority-content',
    } as unknown as BackstageNotionMonolithAuthorityOperationalState;
    const result = await getBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment(),
        repository: repositoryReturning(hostileState),
        maximumStalenessMs: 60 * 60 * 1_000,
      },
    });

    expect(result).toEqual({
      statusCode: 503,
      payload: {
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_AUTHORITY_STATUS_UNAVAILABLE',
          message: 'Notion authority status is unavailable.',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(corruption);
    expect(JSON.stringify(result)).not.toContain('hostile-snapshot-id');
    expect(JSON.stringify(result)).not.toContain('hostile-authority-content');
  });

  it('fails closed on a configured-to-durable root mismatch', async () => {
    const result = await getBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment(),
        repository: repositoryReturning(operationalState({
          configuredRootMatchesDurable: false,
        })),
      },
    });

    expect(result.statusCode).toBe(503);
    expect(result.payload).toEqual({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_AUTHORITY_STATUS_UNAVAILABLE',
        message: 'Notion authority status is unavailable.',
      },
    });
  });

  it('returns fixed failures for malformed configuration, database failure, and no authority', async () => {
    const neverRead = jest.fn(async () => operationalState());
    const malformed = await getBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment('{'),
        repository: { loadMonolithAuthorityOperationalState: neverRead },
      },
    });
    expect(malformed.statusCode).toBe(503);
    expect(neverRead).not.toHaveBeenCalled();

    const databaseFailure = await getBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: configuredEnvironment(),
        repository: {
          loadMonolithAuthorityOperationalState: async () => {
            throw new Error('database-password=hostile-secret');
          },
        },
      },
    });
    expect(databaseFailure.statusCode).toBe(503);
    expect(JSON.stringify(databaseFailure)).not.toContain('hostile-secret');

    const noAuthority = await getBackstageNotionMonolithAuthorityStatus({
      universeId: UNIVERSE_ID,
      dependencies: {
        readEnvironment: () => undefined,
        repository: repositoryReturning(operationalState({
          durableAuthority: null,
          durableRootPresent: false,
          configuredRootMatchesDurable: null,
          activeSnapshotPresent: false,
          activeSnapshotVerifiedAt: null,
          activeSnapshotPageCount: 0,
          activeSnapshotChunkCount: 0,
          activeSnapshotReadable: false,
          latestSyncAttempt: null,
        })),
      },
    });
    expect(noAuthority).toEqual({
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_AUTHORITY_STATUS_NOT_FOUND',
          message: 'The Notion authority status target was not found.',
        },
      },
    });
  });
});

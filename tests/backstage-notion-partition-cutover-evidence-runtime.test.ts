import { createHash } from 'node:crypto';

import { describe, expect, it, jest } from '@jest/globals';

import type {
  BackstageNotionPartitionCutoverEvidenceRepository,
} from '../src/core/db/repositories/backstageNotionPartitionCutoverEvidenceRepository.js';
import type {
  PostgresBackstageNotionPartitionRepository,
} from '../src/core/db/repositories/backstageNotionPartitionRepository.js';
import type {
  BackstageNotionActiveSnapshotHeader,
  BackstageNotionRagRepository,
} from '../src/core/db/repositories/backstageNotionRagRepository.js';
import type {
  BackstageNotionSyncAttemptRecord,
  BackstageNotionSyncStatusRepository,
} from '../src/core/db/repositories/backstageNotionSyncStatusRepository.js';
import type {
  BackstageNotionPartitionCutoverGateEvidence,
} from '../src/shared/backstage/backstageNotionPartitionCutoverGate.js';
import {
  parseBackstageNotionPartitionConfiguration,
} from '../src/shared/backstage/backstageNotionPartitionCore.js';
import type {
  BackstageNotionAuthorityRoot,
} from '../src/services/backstageNotionAuthority.js';
import type {
  BackstageNotionPartitionCutoverValidationAttestation,
} from '../src/services/backstageNotionPartitionCutoverValidation.js';
import type {
  BackstageNotionPartitionRagRetrieval,
  BackstageNotionPartitionRetrievalPlan,
} from '../src/services/backstageNotionPartitionRetrieval.js';
import type {
  BackstageNotionRagQuery,
  BackstageNotionRagRetrieval,
} from '../src/services/backstageNotionRag.js';

const UNIVERSE_ID = 'my-universe-2k26';
const OTHER_UNIVERSE_ID = 'my-universe-archive';
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ROOT_PAGE_ID = '22222222-2222-4222-8222-222222222222';
const MONOLITH_SNAPSHOT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_MONOLITH_SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444';
const PARTITION_MANIFEST_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_PARTITION_MANIFEST_ID = '66666666-6666-4666-8666-666666666666';
const CONFIGURATION_VERSION_ID = '77777777-7777-4777-8777-777777777777';
const SOURCE_GENERATION_ID = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-08-30T16:00:00.000Z');
const MAXIMUM_STALENESS_MS = 60 * 60 * 1_000;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function queryText(query: BackstageNotionRagQuery): string {
  return typeof query === 'string' ? query : query.query;
}

const retrieveMonolithMock = jest.fn(async (
  _universeId: string,
  query: BackstageNotionRagQuery,
  dependencies: Readonly<{
    embedQuery?: (value: string) => Promise<number[]>;
  }> = {}
) => {
  await dependencies.embedQuery?.(queryText(query));
  return Object.freeze({ side: 'monolith' }) as unknown as BackstageNotionRagRetrieval;
});
const retrievePartitionMock = jest.fn(async (
  _universeId: string,
  plan: BackstageNotionPartitionRetrievalPlan,
  dependencies: Readonly<{
    embedQuery?: (value: string) => Promise<number[]>;
  }> = {}
) => {
  await dependencies.embedQuery?.(queryText(plan.query));
  return Object.freeze({ side: 'partition' }) as unknown as BackstageNotionPartitionRagRetrieval;
});
const derivePlanMock = jest.fn((query: BackstageNotionRagQuery) => (
  Object.freeze({ query }) as BackstageNotionPartitionRetrievalPlan
));
const pinnedRequestMock = jest.fn();
const pinnedScopeRequestMock = jest.fn();
const sealedAttestation = Object.freeze({
  version: 1,
  universeId: UNIVERSE_ID,
}) as unknown as BackstageNotionPartitionCutoverValidationAttestation;
const validateAndSealMock = jest.fn(async () => sealedAttestation);

jest.unstable_mockModule('../src/services/backstageNotionRag.js', () => ({
  retrieveBackstageNotionRagContext: retrieveMonolithMock,
}));
jest.unstable_mockModule(
  '../src/services/backstageNotionPartitionRetrieval.js',
  () => ({
    retrieveBackstageNotionPartitionRagContext: retrievePartitionMock,
  })
);
jest.unstable_mockModule(
  '../src/services/backstageNotionPartitionCutover.js',
  () => ({
    deriveBackstageNotionPartitionCutoverValidationPlan: derivePlanMock,
  })
);
jest.unstable_mockModule(
  '../src/services/backstageNotionPartitionRouting.js',
  () => ({
    resolveBackstageNotionPartitionPinnedRequest: pinnedRequestMock,
    resolveBackstageNotionPartitionPinnedScopeRequest: pinnedScopeRequestMock,
  })
);
jest.unstable_mockModule(
  '../src/services/backstageNotionPartitionCutoverValidation.js',
  () => ({
    validateAndSealBackstageNotionPartitionCutover: validateAndSealMock,
  })
);

const {
  createBackstageNotionPartitionCutoverValidationDependencies,
  loadBackstageNotionPartitionCutoverGateEvidence,
  loadBackstageNotionPartitionCutoverGateEvidenceSet,
  validateAndPersistBackstageNotionPartitionCutover,
} = await import('../src/services/backstageNotionPartitionCutoverEvidence.js');

const CONFIGURATION = parseBackstageNotionPartitionConfiguration(JSON.stringify({
  version: 1,
  generation: 'runtime-test-generation',
  universes: [{
    universeId: UNIVERSE_ID,
    shards: [{
      shardKey: 'raw/current',
      rootPageId: ROOT_PAGE_ID,
      displayName: 'Raw current',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:raw'],
      categoryTags: ['current'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }, {
      shardKey: 'shared/current',
      rootPageId: OTHER_ROOT_PAGE_ID,
      displayName: 'Shared current',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['shared'],
      categoryTags: ['current'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }],
  }, {
    universeId: OTHER_UNIVERSE_ID,
    shards: [{
      shardKey: 'archive/current',
      rootPageId: '99999999-9999-4999-8999-999999999999',
      displayName: 'Archive current',
      retrievalTier: 'archive',
      required: false,
      scopeTags: ['archive'],
      categoryTags: ['archive'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }],
  }],
}));

if (CONFIGURATION.status !== 'valid') {
  throw new Error('The runtime test partition configuration must be valid.');
}

const EXPECTED_CONFIGURATION = Object.freeze({
  generation: CONFIGURATION.generation,
  semanticDigest: CONFIGURATION.semanticDigest,
});

const ANCHOR = Object.freeze({
  universeId: UNIVERSE_ID,
  monolithSnapshotId: MONOLITH_SNAPSHOT_ID,
  partitionManifestId: PARTITION_MANIFEST_ID,
  partitionConfigurationVersionId: CONFIGURATION_VERSION_ID,
  partitionConfigurationGeneration: CONFIGURATION.generation,
  partitionConfigurationHash: CONFIGURATION.semanticDigest,
  partitionSourceGenerationId: SOURCE_GENERATION_ID,
  partitionSourceDigest: hash('source'),
  partitionSourceVerificationHash: hash('source-verification'),
  reconciliationGeneration: 7,
  rollbackMonolithVerifiedAt: new Date(NOW),
  rollbackMonolithValidUntil: new Date(
    NOW.getTime() + MAXIMUM_STALENESS_MS
  ),
});

const MONOLITH: BackstageNotionActiveSnapshotHeader = Object.freeze({
  authority: 'notion',
  verifiedAt: new Date(NOW),
  snapshot: Object.freeze({
    id: MONOLITH_SNAPSHOT_ID,
    universeId: UNIVERSE_ID,
    rootPageId: ROOT_PAGE_ID,
    manifestHash: hash('monolith-manifest'),
    embeddingModel: 'text-embedding-3-small',
    pageCount: 2,
    chunkCount: 2,
    sourceMaxEditedAt: new Date('2026-08-30T15:30:00.000Z'),
    syncHolderId: 'runtime-test-holder',
    createdAt: new Date('2026-08-30T15:45:00.000Z'),
  }),
});

const PARTITION_ROUTING_STATE = Object.freeze({
  universeId: UNIVERSE_ID,
  manifestId: PARTITION_MANIFEST_ID,
  manifestGeneration: '1',
  configurationVersionId: CONFIGURATION_VERSION_ID,
  configurationGeneration: 'runtime-test-generation',
  configurationHash: CONFIGURATION.semanticDigest,
  configurationCurrent: true,
  embeddingModel: 'text-embedding-3-small',
  embeddingVersion: 1,
  embeddingDimension: 2,
  indexFormatVersion: 1,
  manifestCreatedAt: new Date('2026-08-30T15:46:00.000Z'),
  manifestSealedAt: new Date('2026-08-30T15:47:00.000Z'),
  pageCount: 2,
  chunkCount: 2,
  members: Object.freeze([]),
  omissions: Object.freeze([]),
});

function evidenceRepository(input: Readonly<{
  loadValidationAnchor?: BackstageNotionPartitionCutoverEvidenceRepository[
    'loadValidationAnchor'
  ];
  loadGateEvidence?: BackstageNotionPartitionCutoverEvidenceRepository[
    'loadGateEvidence'
  ];
}> = {}): BackstageNotionPartitionCutoverEvidenceRepository {
  return {
    loadValidationAnchor: input.loadValidationAnchor
      ?? jest.fn(async () => ANCHOR),
    sealEvidence: jest.fn(async () => undefined),
    loadGateEvidence: input.loadGateEvidence
      ?? jest.fn(async () => null),
  };
}

function monolithRepository(
  header: BackstageNotionActiveSnapshotHeader | null = MONOLITH
): BackstageNotionRagRepository {
  return {
    loadActiveSnapshotHeader: jest.fn(async () => header),
    resolveSnapshotScope: jest.fn(),
    loadSnapshotChunkPage: jest.fn(),
    rankSnapshotCandidates: jest.fn(),
  } as unknown as BackstageNotionRagRepository;
}

function partitionRepository(
  routingState: typeof PARTITION_ROUTING_STATE | null = PARTITION_ROUTING_STATE
): PostgresBackstageNotionPartitionRepository {
  return {
    loadActiveManifestRoutingState: jest.fn(async () => routingState),
  } as unknown as PostgresBackstageNotionPartitionRepository;
}

function syncAttempt(
  outcome: BackstageNotionSyncAttemptRecord['outcome'],
  options: Partial<BackstageNotionSyncAttemptRecord> = {}
): BackstageNotionSyncAttemptRecord {
  return {
    universeId: UNIVERSE_ID,
    attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    generation: '1',
    startedAt: new Date(NOW.getTime() - 2 * 60 * 1_000),
    completedAt: outcome === 'running'
      ? null
      : new Date(NOW.getTime() - 60 * 1_000),
    outcome,
    failurePhase: outcome === 'failed' ? 'chunking' : null,
    failureReason: outcome === 'failed' ? 'chunk_limit_reached' : null,
    pagesDiscovered: 2,
    pagesFetched: 2,
    blocksFetched: 2,
    chunksProduced: outcome === 'activated' ? 2 : 0,
    chunksEmbedded: outcome === 'activated' ? 2 : 0,
    candidateSnapshotCreated: outcome === 'activated',
    candidateSnapshotValidated: outcome === 'activated',
    candidateSnapshotActivated: outcome === 'activated',
    activatedSnapshotId: outcome === 'activated' || outcome === 'unchanged'
      ? MONOLITH_SNAPSHOT_ID
      : null,
    ...options,
  };
}

function syncStatusRepository(
  latest: BackstageNotionSyncAttemptRecord | null = syncAttempt('unchanged')
): BackstageNotionSyncStatusRepository {
  return {
    beginSyncAttempt: jest.fn(),
    completeSyncAttempt: jest.fn(),
    loadLatestSyncAttempt: jest.fn(async () => latest),
  } as unknown as BackstageNotionSyncStatusRepository;
}

const AUTHORITY_ROOT: BackstageNotionAuthorityRoot = Object.freeze({
  universeId: UNIVERSE_ID,
  rootPageId: ROOT_PAGE_ID,
  displayName: 'Synthetic authority',
});

describe('Backstage Notion partition cutover evidence runtime', () => {
  it('fails closed to missing gate evidence when repository loading fails', async () => {
    const loadGateEvidence = jest.fn(async () => {
      throw new Error('PRIVATE database diagnostic');
    });

    await expect(loadBackstageNotionPartitionCutoverGateEvidence({
      universeId: UNIVERSE_ID,
      configurationHash: CONFIGURATION.semanticDigest,
      configuredShardKeys: ['raw/current', 'shared/current'],
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
      repository: evidenceRepository({ loadGateEvidence }),
    })).resolves.toBeNull();

    expect(loadGateEvidence).toHaveBeenCalledWith({
      universeId: UNIVERSE_ID,
      configurationHash: CONFIGURATION.semanticDigest,
      configuredShardKeys: ['raw/current', 'shared/current'],
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
    });
  });

  it('loads evidence only against each configured universe, digest, and shard set', async () => {
    const firstEvidence = Object.freeze({ universeId: UNIVERSE_ID }) as unknown as BackstageNotionPartitionCutoverGateEvidence;
    const loadGateEvidence = jest.fn(async (input: Readonly<{
      universeId: string;
    }>) => input.universeId === UNIVERSE_ID ? firstEvidence : null);

    const loaded = await loadBackstageNotionPartitionCutoverGateEvidenceSet(
      CONFIGURATION,
      evidenceRepository({ loadGateEvidence }),
      MAXIMUM_STALENESS_MS
    );

    expect(loaded).toEqual([firstEvidence]);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(loadGateEvidence).toHaveBeenCalledTimes(2);
    expect(loadGateEvidence).toHaveBeenNthCalledWith(1, {
      universeId: UNIVERSE_ID,
      configurationHash: CONFIGURATION.semanticDigest,
      configuredShardKeys: ['raw/current', 'shared/current'],
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
    });
    expect(loadGateEvidence).toHaveBeenNthCalledWith(2, {
      universeId: OTHER_UNIVERSE_ID,
      configurationHash: CONFIGURATION.semanticDigest,
      configuredShardKeys: ['archive/current'],
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
    });
  });

  it.each([
    ['monolith snapshot', {
      monolithSnapshotId: OTHER_MONOLITH_SNAPSHOT_ID,
    }, MONOLITH, PARTITION_ROUTING_STATE],
    ['partition manifest', {}, MONOLITH, {
      ...PARTITION_ROUTING_STATE,
      manifestId: OTHER_PARTITION_MANIFEST_ID,
    }],
    ['partition configuration', {}, MONOLITH, {
      ...PARTITION_ROUTING_STATE,
      configurationHash: hash('other-configuration'),
    }],
    ['non-current partition configuration', {}, MONOLITH, {
      ...PARTITION_ROUTING_STATE,
      configurationCurrent: false,
    }],
  ])('rejects an anchor mismatched to the active %s', async (
    _label,
    anchorOverrides,
    monolith,
    routingState
  ) => {
    const dependencies = createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
      evidenceRepository: evidenceRepository({
        loadValidationAnchor: jest.fn(async () => ({
          ...ANCHOR,
          ...anchorOverrides,
        })),
      }),
      monolithRepository: monolithRepository(monolith),
      partitionRepository: partitionRepository(routingState),
      syncStatusRepository: syncStatusRepository(),
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
      now: () => new Date(NOW),
      }
    );

    await expect(dependencies.loadAnchor(UNIVERSE_ID)).resolves.toBeNull();
  });

  it('accepts a current complete monolith and preserves its exact freshness bound', async () => {
    const latestSync = syncStatusRepository();
    const repository = evidenceRepository();
    const dependencies = createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
      evidenceRepository: repository,
      monolithRepository: monolithRepository(),
      partitionRepository: partitionRepository(),
      syncStatusRepository: latestSync,
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
      now: () => new Date(NOW.getTime() + 15 * 60 * 1_000),
      }
    );

    await expect(dependencies.loadAnchor(UNIVERSE_ID)).resolves.toEqual({
      ...ANCHOR,
      rollbackMonolithVerifiedAt: new Date(NOW),
      rollbackMonolithValidUntil: new Date(
        NOW.getTime() + MAXIMUM_STALENESS_MS
      ),
    });
    expect(latestSync.loadLatestSyncAttempt).toHaveBeenCalledWith(UNIVERSE_ID);
    expect(repository.loadValidationAnchor).toHaveBeenCalledWith({
      universeId: UNIVERSE_ID,
      expectedConfigurationGeneration: CONFIGURATION.generation,
      expectedConfigurationHash: CONFIGURATION.semanticDigest,
    });
  });

  it.each([
    ['failed refresh', syncAttempt('failed', {
      startedAt: new Date(NOW.getTime() + 5 * 60 * 1_000),
      completedAt: new Date(NOW.getTime() + 10 * 60 * 1_000),
    })],
    ['running refresh', syncAttempt('running', {
      startedAt: new Date(NOW.getTime() + 5 * 60 * 1_000),
    })],
    ['newer successful snapshot', syncAttempt('activated', {
      startedAt: new Date(NOW.getTime() + 5 * 60 * 1_000),
      completedAt: new Date(NOW.getTime() + 10 * 60 * 1_000),
      activatedSnapshotId: OTHER_MONOLITH_SNAPSHOT_ID,
    })],
  ])('rejects validation anchoring after a %s', async (_label, attempt) => {
    const dependencies = createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
      evidenceRepository: evidenceRepository(),
      monolithRepository: monolithRepository(),
      partitionRepository: partitionRepository(),
      syncStatusRepository: syncStatusRepository(attempt),
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
      now: () => new Date(NOW.getTime() + 15 * 60 * 1_000),
      }
    );

    await expect(dependencies.loadAnchor(UNIVERSE_ID)).resolves.toBeNull();
  });

  it('rejects validation anchoring after the monolith freshness bound expires', async () => {
    const dependencies = createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
      evidenceRepository: evidenceRepository(),
      monolithRepository: monolithRepository(),
      partitionRepository: partitionRepository(),
      syncStatusRepository: syncStatusRepository(),
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
      now: () => new Date(NOW.getTime() + MAXIMUM_STALENESS_MS + 1),
      }
    );

    await expect(dependencies.loadAnchor(UNIVERSE_ID)).resolves.toBeNull();
  });

  it('pins monolith and partition retrieval to the anchor loaded for the universe', async () => {
    const dependencies = createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
      evidenceRepository: evidenceRepository(),
      monolithRepository: monolithRepository(),
      partitionRepository: partitionRepository(),
      syncStatusRepository: syncStatusRepository(),
      resolveAuthorityRoot: async () => AUTHORITY_ROOT,
      embedQuery: async () => [1, 0],
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
      now: () => new Date(NOW),
      }
    );

    await expect(dependencies.loadAnchor(UNIVERSE_ID)).resolves.toEqual(ANCHOR);
    await expect(dependencies.retrieveMonolithPinned({
      universeId: UNIVERSE_ID,
      snapshotId: OTHER_MONOLITH_SNAPSHOT_ID,
      query: 'representative query',
      cursor: null,
    })).rejects.toThrow('lost its pinned anchor');
    await expect(dependencies.derivePartitionPlan({
      universeId: UNIVERSE_ID,
      manifestId: OTHER_PARTITION_MANIFEST_ID,
      query: 'representative query',
    })).rejects.toThrow('lost its pinned anchor');
    await expect(dependencies.retrievePartitionPinned({
      universeId: UNIVERSE_ID,
      manifestId: OTHER_PARTITION_MANIFEST_ID,
      plan: { query: 'representative query' },
      cursor: null,
    })).rejects.toThrow('lost its pinned anchor');

    expect(retrieveMonolithMock).not.toHaveBeenCalled();
    expect(retrievePartitionMock).not.toHaveBeenCalled();
  });

  it('reuses one embedding promise across pinned monolith and partition paths', async () => {
    const embedQuery = jest.fn(async () => [1, 0]);
    const dependencies = createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
      evidenceRepository: evidenceRepository(),
      monolithRepository: monolithRepository(),
      partitionRepository: partitionRepository(),
      syncStatusRepository: syncStatusRepository(),
      resolveAuthorityRoot: async () => AUTHORITY_ROOT,
      embedQuery,
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
      now: () => new Date(NOW),
      }
    );

    await dependencies.loadAnchor(UNIVERSE_ID);
    const query = 'same representative query';
    const plan = await dependencies.derivePartitionPlan({
      universeId: UNIVERSE_ID,
      manifestId: PARTITION_MANIFEST_ID,
      query,
    });
    await dependencies.retrieveMonolithPinned({
      universeId: UNIVERSE_ID,
      snapshotId: MONOLITH_SNAPSHOT_ID,
      query,
      cursor: null,
    });
    await dependencies.retrieveMonolithPinned({
      universeId: UNIVERSE_ID,
      snapshotId: MONOLITH_SNAPSHOT_ID,
      query,
      cursor: null,
    });
    await dependencies.retrievePartitionPinned({
      universeId: UNIVERSE_ID,
      manifestId: PARTITION_MANIFEST_ID,
      plan,
      cursor: null,
    });

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledWith(query);
    expect(retrieveMonolithMock).toHaveBeenCalledTimes(2);
    expect(retrievePartitionMock).toHaveBeenCalledTimes(1);
  });

  it('rechecks runtime policy immediately before the exact configuration-bound seal', async () => {
    const events: string[] = [];
    const repository = evidenceRepository();
    jest.mocked(repository.sealEvidence).mockImplementation(async () => {
      events.push('seal');
    });
    const assertRuntimePolicyCurrent = jest.fn(async () => {
      events.push('policy');
    });
    const dependencies = createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
        evidenceRepository: repository,
        monolithRepository: monolithRepository(),
        partitionRepository: partitionRepository(),
        syncStatusRepository: syncStatusRepository(),
        maximumStalenessMs: MAXIMUM_STALENESS_MS,
        assertRuntimePolicyCurrent,
      }
    );

    await dependencies.sealEvidence(sealedAttestation);

    expect(events).toEqual(['policy', 'seal']);
    expect(repository.sealEvidence).toHaveBeenCalledWith({
      ...sealedAttestation,
      expectedConfigurationGeneration: CONFIGURATION.generation,
      expectedConfigurationHash: CONFIGURATION.semanticDigest,
    });
  });

  it('does not reach the repository seal after the final policy recheck fails', async () => {
    const repository = evidenceRepository();
    const dependencies = createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
        evidenceRepository: repository,
        monolithRepository: monolithRepository(),
        partitionRepository: partitionRepository(),
        syncStatusRepository: syncStatusRepository(),
        maximumStalenessMs: MAXIMUM_STALENESS_MS,
        assertRuntimePolicyCurrent: async () => {
          throw new Error('mode drifted');
        },
      }
    );

    await expect(dependencies.sealEvidence(sealedAttestation)).rejects.toThrow(
      'mode drifted'
    );
    expect(repository.sealEvidence).not.toHaveBeenCalled();
  });

  it('does not run validation until the explicit facade is invoked', async () => {
    expect(validateAndSealMock).not.toHaveBeenCalled();

    createBackstageNotionPartitionCutoverValidationDependencies(
      EXPECTED_CONFIGURATION,
      {
      evidenceRepository: evidenceRepository(),
      monolithRepository: monolithRepository(),
      partitionRepository: partitionRepository(),
      syncStatusRepository: syncStatusRepository(),
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
      now: () => new Date(NOW),
      }
    );
    expect(validateAndSealMock).not.toHaveBeenCalled();

    await expect(validateAndPersistBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: [],
      expectedConfiguration: EXPECTED_CONFIGURATION,
      overrides: {
        evidenceRepository: evidenceRepository(),
        monolithRepository: monolithRepository(),
        partitionRepository: partitionRepository(),
        syncStatusRepository: syncStatusRepository(),
        maximumStalenessMs: MAXIMUM_STALENESS_MS,
        now: () => new Date(NOW),
      },
    })).resolves.toBe(sealedAttestation);
    expect(validateAndSealMock).toHaveBeenCalledTimes(1);
    expect(validateAndSealMock).toHaveBeenCalledWith(expect.objectContaining({
      universeId: UNIVERSE_ID,
      cases: [],
      dependencies: expect.objectContaining({
        loadAnchor: expect.any(Function),
        retrieveMonolithPinned: expect.any(Function),
        retrievePartitionPinned: expect.any(Function),
        sealEvidence: expect.any(Function),
      }),
    }));
  });
});

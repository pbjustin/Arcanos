import { describe, expect, it, jest } from '@jest/globals';

import {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} from '../src/shared/security/purposeBoundCredential.js';
import {
  resolveBackstageNotionPartitionRouting,
} from '../src/shared/backstage/backstageNotionPartitionRoutingCore.js';
import type {
  BackstageNotionPartitionCutoverGateEvidence,
} from '../src/shared/backstage/backstageNotionPartitionCutoverGate.js';
import {
  BackstageNotionIndexUnavailableError,
  type BackstageNotionRagQuery,
  type BackstageNotionRagRetrieval,
} from '../src/services/backstageNotionRag.js';
import {
  BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET_ENV_NAME,
  BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET_ENV_NAME,
  BACKSTAGE_NOTION_PARTITION_SHADOW_MAX_IN_FLIGHT,
  assertBackstageNotionProtectedLiteralAuthorityCurrent,
  retrieveBackstageNotionAuthorityBookingRagContext,
  retrieveBackstageNotionAuthorityRagContext,
  type BackstageNotionPartitionCutoverDependencies,
} from '../src/services/backstageNotionPartitionCutover.js';
import type {
  BackstageNotionPartitionRagRetrieval,
  BackstageNotionPartitionRetrievalDependencies,
  BackstageNotionPartitionRetrievalPlan,
} from '../src/services/backstageNotionPartitionRetrieval.js';
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from
  '../src/services/openai/embeddings.js';
import {
  runWithBackstageProtectedQueuedExecution,
} from '../src/services/backstageNotionEnrichmentAuthorization.js';

const UNIVERSE_ID = 'my-universe-2k26';
const OTHER_UNIVERSE_ID = 'other-universe';
const MODE_ENV_NAME = 'ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE';
const CONFIG_ENV_NAME = 'ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON';
const CURRENT_CURSOR_SECRET = 'c'.repeat(32);
const PREVIOUS_CURSOR_SECRET = 'p'.repeat(32);

function partitionConfiguration(universeId = UNIVERSE_ID): string {
  return JSON.stringify({
    version: 1,
    generation: 'cutover-generation-1',
    universes: [
      {
        universeId,
        shards: [
          {
            shardKey: 'raw/year-2026',
            rootPageId: '11111111-1111-4111-8111-111111111111',
            displayName: 'Monday Night Raw 2026',
            retrievalTier: 'hot',
            required: true,
            scopeTags: ['brand:raw', 'year:2026'],
            categoryTags: ['show'],
            capacity: {
              maxPages: 64,
              maxChunks: 512,
              maxDepth: 8,
              maxContentCodePoints: 500_000,
            },
          },
        ],
      },
    ],
  });
}

function requiredArchiveConfiguration(): string {
  return JSON.stringify({
    version: 1,
    generation: 'cutover-required-archive-invalid',
    universes: [{
      universeId: UNIVERSE_ID,
      shards: [{
        shardKey: 'archive/raw/2025',
        rootPageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Raw 2025 archive',
        retrievalTier: 'archive',
        required: true,
        scopeTags: ['brand:raw', 'year:2025'],
        categoryTags: ['archive'],
        capacity: {
          maxPages: 64,
          maxChunks: 512,
          maxDepth: 8,
          maxContentCodePoints: 500_000,
        },
      }],
    }],
  });
}

function createEnvironment(
  mode: string | undefined,
  options: {
    configuration?: string;
    cursorSecret?: string;
    previousCursorSecret?: string;
  } = {}
) {
  const values = new Map<string, string | undefined>([
    [MODE_ENV_NAME, mode],
    [CONFIG_ENV_NAME, options.configuration ?? partitionConfiguration()],
    [
      BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET_ENV_NAME,
      options.cursorSecret ?? CURRENT_CURSOR_SECRET,
    ],
    [
      BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET_ENV_NAME,
      options.previousCursorSecret ?? PREVIOUS_CURSOR_SECRET,
    ],
  ]);
  return jest.fn((name: string) => values.get(name));
}

function withoutCursorSecrets(
  readEnvironment: (name: string) => string | undefined
): jest.Mock<(name: string) => string | undefined> {
  return jest.fn((name: string) => (
    name === BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET_ENV_NAME
      || name === BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET_ENV_NAME
      ? undefined
      : readEnvironment(name)
  ));
}

const monolithRetrieval: BackstageNotionRagRetrieval = {
  universeId: UNIVERSE_ID,
  snapshotId: '22222222-2222-4222-8222-222222222222',
  verifiedAt: new Date('2026-08-24T12:00:00.000Z'),
  snapshotStatus: 'current_complete',
  activeSnapshotVerifiedAt: new Date('2026-08-24T12:00:00.000Z'),
  activeSnapshotChunkCount: 20,
  latestSyncOutcome: 'unchanged',
  latestSyncFailurePhase: null,
  latestSyncFailureReason: null,
  prompt: 'MONOLITH PRIVATE CONTEXT',
  chunkCount: 2,
  truncated: false,
  retrievalMode: 'relevant',
  resolvedScope: null,
  coverage: {
    status: 'sampled',
    scopeChunks: 20,
    selectedChunks: 2,
    omittedChunks: 18,
    promptTruncated: false,
    exhaustive: false,
    hasMore: false,
  },
  nextCursor: null,
  citations: [
    {
      pageId: '33333333-3333-4333-8333-333333333333',
      pageTitle: 'Monday Night Raw',
      pagePath: ['My Universe 2K26', 'Monday Night Raw'],
      headingPath: ['Championships'],
      category: 'championships',
      chunkId: 'a'.repeat(64),
      contentHash: 'b'.repeat(64),
    },
  ],
};

const partitionRetrieval: BackstageNotionPartitionRagRetrieval = {
  universeId: UNIVERSE_ID,
  manifestId: '44444444-4444-4444-8444-444444444444',
  configurationVersionId: '55555555-5555-4555-8555-555555555555',
  configurationHash: 'c'.repeat(64),
  configurationCurrent: false,
  selectionDigest: 'd'.repeat(64),
  routingComplete: true,
  selectedShards: [
    {
      shardKey: 'raw/year-2026',
      partitionVersionId: '66666666-6666-4666-8666-666666666666',
      snapshotId: '77777777-7777-4777-8777-777777777777',
      retrievalTier: 'hot',
      required: true,
      decision: 'fresh',
      verifiedAt: '2026-08-24T11:59:00.000Z',
    },
  ],
  matchingOmissions: [],
  verifiedAt: new Date('2026-08-24T11:59:00.000Z'),
  prompt: 'PARTITION PRIVATE CONTEXT',
  chunkCount: 1,
  truncated: false,
  retrievalMode: 'relevant',
  resolvedScope: null,
  coverage: {
    status: 'sampled',
    scopeChunks: 10,
    selectedChunks: 1,
    omittedChunks: 9,
    promptTruncated: false,
    exhaustive: false,
    hasMore: false,
  },
  nextCursor: null,
  citations: [
    {
      pageId: '33333333-3333-4333-8333-333333333333',
      pageTitle: 'Monday Night Raw',
      pagePath: ['My Universe 2K26', 'Monday Night Raw'],
      headingPath: ['Championships'],
      category: 'championships',
      chunkId: 'e'.repeat(64),
      contentHash: 'f'.repeat(64),
      shardKey: 'raw/year-2026',
      partitionVersionId: '66666666-6666-4666-8666-666666666666',
      snapshotId: '77777777-7777-4777-8777-777777777777',
      pageVersionId: '88888888-8888-4888-8888-888888888888',
      chunkVersionId: '99999999-9999-4999-8999-999999999999',
      canonicalUrl: 'https://www.notion.so/example',
      sourceLastEditedAt: '2026-08-24T11:58:00.000Z',
    },
  ],
};

function authorizedDependencies(
  overrides: BackstageNotionPartitionCutoverDependencies = {}
): BackstageNotionPartitionCutoverDependencies {
  return {
    isAuthorized: () => true,
    resolveCutoverEvidence: input => completeCutoverEvidence(input),
    ...overrides,
  };
}

function completeCutoverEvidence(input: Readonly<{
  universeId: string;
  configurationHash: string;
  configuredShardKeys: readonly string[];
}>): BackstageNotionPartitionCutoverGateEvidence {
  const now = Date.now();
  const sourceGenerationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  return Object.freeze({
    evidenceVersion: 1,
    reconciliationGeneration: 7,
    activeReconciliationGeneration: 7,
    publishedReconciliationGeneration: 7,
    universeId: input.universeId,
    manifestId: partitionRetrieval.manifestId,
    activeManifestId: partitionRetrieval.manifestId,
    manifestState: 'sealed' as const,
    manifestReadable: true,
    manifestConfigurationVersionId: partitionRetrieval.configurationVersionId,
    activeConfigurationVersionId: partitionRetrieval.configurationVersionId,
    configurationHash: input.configurationHash,
    activeConfigurationHash: input.configurationHash,
    sourceGenerationId,
    sourceDigest: 'a'.repeat(64),
    sourcePageCount: input.configuredShardKeys.length * 2,
    sourceChunkCount: input.configuredShardKeys.length * 20,
    sourceVerifiedAt: new Date(now - 120_000),
    sourceVerificationHash: 'b'.repeat(64),
    manifestPageCount: input.configuredShardKeys.length * 2,
    manifestChunkCount: input.configuredShardKeys.length * 20,
    embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    indexFormatVersion: 1,
    memberCount: input.configuredShardKeys.length,
    omissionCount: 0,
    members: Object.freeze(input.configuredShardKeys.map((shardKey, index) => Object.freeze({
      shardKey,
      snapshotId: index === 0
        ? partitionRetrieval.selectedShards[0]!.snapshotId
        : `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
      sourceGenerationId,
      indexFormatVersion: 1,
      pageCount: 2,
      chunkCount: 20,
      decision: 'fresh' as const,
      readable: true,
    }))),
    leaseFencingClear: true,
    unresolvedActivationCount: 0,
    parity: Object.freeze({
      shadowComparisonCompleted: true,
      exactScopeParityPassed: true,
      relevantRetrievalParityPassed: true,
      completeScopeParityPassed: true,
      cursorStabilityPassed: true,
    }),
    rollbackMonolithSnapshotId: monolithRetrieval.snapshotId,
    rollbackMonolithReadable: true,
    rollbackMonolithChunkCount: monolithRetrieval.activeSnapshotChunkCount,
    rollbackMonolithValidationVerifiedAt: new Date(now - 120_000),
    rollbackMonolithVerifiedAt: new Date(now - 120_000),
    rollbackMonolithValidUntil: new Date(now + 60 * 60_000),
    verifiedAt: new Date(now - 60_000),
    expiresAt: new Date(now + 60 * 60_000),
  });
}

async function drainUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
}

describe('Backstage Notion partition cutover facade', () => {
  const currentAuthorityStatus = Object.freeze({
    status: 'ready' as const,
    data: Object.freeze({
      version: 1 as const,
      surface: 'monolith_authority' as const,
      authority: 'notion' as const,
      status: 'current_complete' as const,
      snapshotStatus: 'current_complete' as const,
      freshnessSatisfied: true,
      syncInProgress: false,
      activeSnapshotReadable: true,
      activeSnapshotChunkCount: 20,
      latestSyncOutcome: 'unchanged' as const,
      latestSyncFailurePhase: null,
      latestSyncFailureReason: null,
    }),
  });

  it('admits a protected literal from current monolith authority without provider or corpus work', async () => {
    const resolveMonolithAuthorityStatus = jest.fn(
      async () => currentAuthorityStatus
    );
    const embedQuery = jest.fn(async () => [1]);
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    await expect(runWithBackstageProtectedQueuedExecution(
      true,
      () => assertBackstageNotionProtectedLiteralAuthorityCurrent(
        UNIVERSE_ID,
        'Answer directly. Say exactly: current-authority.',
        {
          readEnvironment: createEnvironment('monolith'),
          resolveMonolithAuthorityStatus,
          embedQuery,
          retrieveMonolith,
          retrievePartition,
        }
      )
    )).resolves.toBeUndefined();

    expect(resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(1);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(retrieveMonolith).not.toHaveBeenCalled();
    expect(retrievePartition).not.toHaveBeenCalled();
  });

  it('rejects a protected literal before status work without server-owned authorization', async () => {
    const resolveMonolithAuthorityStatus = jest.fn(
      async () => currentAuthorityStatus
    );

    await expect(runWithBackstageProtectedQueuedExecution(
      false,
      () => assertBackstageNotionProtectedLiteralAuthorityCurrent(
        UNIVERSE_ID,
        'Answer directly. Say exactly: unauthorized.',
        {
          readEnvironment: createEnvironment('monolith'),
          resolveMonolithAuthorityStatus,
        }
      )
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);

    expect(resolveMonolithAuthorityStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['syncing', 'last_known_good'],
    ['last_known_good', 'last_known_good'],
    ['unavailable', 'unavailable'],
  ] as const)(
    'rejects a protected literal while operational status is %s',
    async (status, snapshotStatus) => {
      await expect(assertBackstageNotionProtectedLiteralAuthorityCurrent(
        UNIVERSE_ID,
        'Answer directly. Say exactly: unavailable-authority.',
        {
          isAuthorized: () => true,
          readEnvironment: createEnvironment('monolith'),
          resolveMonolithAuthorityStatus: async () => ({
            status: 'ready',
            data: {
              ...currentAuthorityStatus.data,
              status,
              snapshotStatus,
              syncInProgress: status === 'syncing',
              activeSnapshotReadable: status !== 'unavailable',
              freshnessSatisfied: status === 'syncing',
            },
          }),
        }
      )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    }
  );

  it('admits queued partition mode without distributing cursor keys and performs no gate read', async () => {
    const resolveCutoverEvidence = jest.fn(async () => {
      throw new Error('cutover evidence must not be read for a literal');
    });
    const resolveMonolithAuthorityStatus = jest.fn(
      async () => currentAuthorityStatus
    );

    await expect(assertBackstageNotionProtectedLiteralAuthorityCurrent(
      UNIVERSE_ID,
      'Answer directly. Say exactly: partition-literal.',
      {
        isAuthorized: () => true,
        isProtectedQueuedExecution: () => true,
        readEnvironment: withoutCursorSecrets(createEnvironment('partitioned')),
        resolveCutoverEvidence,
        resolveMonolithAuthorityStatus,
      }
    )).resolves.toBeUndefined();

    expect(resolveCutoverEvidence).not.toHaveBeenCalled();
    expect(resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects direct partition-mode literal admission when its cursor credential is unavailable', async () => {
    const resolveMonolithAuthorityStatus = jest.fn(
      async () => currentAuthorityStatus
    );

    await expect(assertBackstageNotionProtectedLiteralAuthorityCurrent(
      UNIVERSE_ID,
      'Answer directly. Say exactly: missing-cursor-secret.',
      {
        isAuthorized: () => true,
        isProtectedQueuedExecution: () => false,
        readEnvironment: withoutCursorSecrets(createEnvironment('partitioned')),
        resolveMonolithAuthorityStatus,
      }
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);

    expect(resolveMonolithAuthorityStatus).not.toHaveBeenCalled();
  });

  it('checks authorization before hostile request, environment, dependency, or logging access', async () => {
    let queryGetterRead = false;
    let environmentGetterRead = false;
    let partitionGetterRead = false;
    const query = Object.defineProperty({}, 'query', {
      get: () => {
        queryGetterRead = true;
        return 'private query';
      },
    }) as BackstageNotionRagQuery;
    const dependencies = Object.defineProperties(
      { isAuthorized: () => false },
      {
        readEnvironment: {
          get: () => {
            environmentGetterRead = true;
            return jest.fn();
          },
        },
        retrievePartition: {
          get: () => {
            partitionGetterRead = true;
            return jest.fn();
          },
        },
      }
    ) as BackstageNotionPartitionCutoverDependencies;

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      query,
      dependencies
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(queryGetterRead).toBe(false);
    expect(environmentGetterRead).toBe(false);
    expect(partitionGetterRead).toBe(false);
  });

  it.each([
    [
      'custom prototype',
      Object.assign(Object.create({ inherited: true }), {
        query: 'Book Raw in 2026',
      }),
    ],
    [
      'throwing proxy',
      new Proxy({}, {
        getPrototypeOf: () => {
          throw new Error('prototype trap');
        },
      }),
    ],
  ])('rejects a %s request before partition activation effects', async (
    _label,
    query
  ) => {
    const configuredEnvironment = createEnvironment('partitioned');
    const readEnvironment = jest.fn((name: string) => {
      if (name === MODE_ENV_NAME) {
        return 'partitioned';
      }
      throw new Error('partition activation must not be inspected');
    });
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      query as BackstageNotionRagQuery,
      authorizedDependencies({
        readEnvironment,
        retrievePartition,
        embedQuery: jest.fn(async () => [1, 0]),
      })
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(configuredEnvironment).not.toHaveBeenCalled();
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(retrievePartition).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['explicit monolith', 'monolith'],
    ['invalid whitespace', ' shadow '],
    ['invalid case', 'PARTITIONED'],
  ])('keeps %s mode strictly monolithic with one mode read', async (
    _label,
    mode
  ) => {
    const readEnvironment = createEnvironment(mode);
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    const result = await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment,
        retrieveMonolith,
        retrievePartition,
      })
    );

    expect(result).toBe(monolithRetrieval);
    expect(retrieveMonolith).toHaveBeenCalledTimes(1);
    expect(retrievePartition).not.toHaveBeenCalled();
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(readEnvironment).toHaveBeenCalledWith(MODE_ENV_NAME);
  });

  it('fails partitioned reads closed before effects for a required archive shard', async () => {
    const retrievePartition = jest.fn(async () => partitionRetrieval);
    const embedQuery = jest.fn(async () => [1, 0]);

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Use the archived Raw 2025 canon',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned', {
          configuration: requiredArchiveConfiguration(),
        }),
        retrievePartition,
        embedQuery,
      })
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);

    expect(retrievePartition).not.toHaveBeenCalled();
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('returns the exact monolith object after a bounded safe shadow comparison', async () => {
    const readEnvironment = createEnvironment('shadow');
    const retrievePartition = jest.fn(async (
      _universeId: string,
      plan: BackstageNotionPartitionRetrievalPlan,
      dependencies?: BackstageNotionPartitionRetrievalDependencies
    ) => {
      expect(plan.relevantRoutingIntent).toEqual({
        kind: 'relevant',
        cardinality: 'all_matching',
        allowedTiers: ['hot', 'cold'],
        explicitArchive: false,
        selectors: [
          {
            allScopeTags: ['brand:raw', 'year:2026'],
            allCategoryTags: [],
          },
          {
            allScopeTags: ['shared'],
            allCategoryTags: [],
          },
        ],
      });
      expect(dependencies?.resolveCursorEncryptionSecret?.())
        .toBe(CURRENT_CURSOR_SECRET);
      expect(dependencies?.resolvePreviousCursorEncryptionSecret?.())
        .toBe(PREVIOUS_CURSOR_SECRET);
      return partitionRetrieval;
    });
    const retrieveMonolith = jest.fn(async () => {
      expect(retrievePartition).not.toHaveBeenCalled();
      return monolithRetrieval;
    });
    const logInfo = jest.fn();

    const result = await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment,
        retrieveMonolith,
        retrievePartition,
        logInfo,
      })
    );

    expect(result).toBe(monolithRetrieval);
    await drainUntil(() => logInfo.mock.calls.length === 1);
    expect(retrieveMonolith).toHaveBeenCalledTimes(1);
    expect(retrievePartition).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
    const [event, metadata] = logInfo.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe('backstage.notion_partition.shadow_read');
    expect(metadata).toMatchObject({
      outcome: 'compared',
      chunkCountEquivalent: false,
      partitionRoutingComplete: true,
      partitionConfigurationCurrent: false,
    });
    const serializedLog = JSON.stringify([event, metadata]);
    for (const forbidden of [
      UNIVERSE_ID,
      'Book Raw in 2026',
      monolithRetrieval.prompt,
      partitionRetrieval.prompt,
      CURRENT_CURSOR_SECRET,
      PREVIOUS_CURSOR_SECRET,
      partitionRetrieval.manifestId,
      partitionRetrieval.selectedShards[0]!.shardKey,
      partitionRetrieval.citations[0]!.contentHash,
    ]) {
      expect(serializedLog).not.toContain(forbidden);
    }
    expect(readEnvironment.mock.calls.filter(([name]) => name === MODE_ENV_NAME))
      .toHaveLength(1);
    expect(readEnvironment.mock.calls.filter(
      ([name]) => name === CONFIG_ENV_NAME
    )).toHaveLength(1);
    for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      expect(readEnvironment.mock.calls.filter(
        ([name]) => name === environmentName
      )).toHaveLength(1);
    }
  });

  it('isolates partition and logger failures after monolith success', async () => {
    const partitionFailure = new Error('must not escape');
    const retrievePartition = jest.fn(async () => {
      throw partitionFailure;
    });
    const logInfo = jest.fn(() => {
      throw new Error('logger unavailable');
    });

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('shadow'),
        retrieveMonolith: jest.fn(async () => monolithRetrieval),
        retrievePartition,
        logInfo,
      })
    )).resolves.toBe(monolithRetrieval);
    await drainUntil(() => logInfo.mock.calls.length === 1);
    expect(retrievePartition).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_read',
      { outcome: 'partition_unavailable' }
    );
  });

  it('keeps malformed shadow activation diagnostic-only', async () => {
    const retrievePartition = jest.fn(async () => partitionRetrieval);
    const logInfo = jest.fn();

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('shadow', { configuration: '{' }),
        retrieveMonolith: jest.fn(async () => monolithRetrieval),
        retrievePartition,
        logInfo,
      })
    )).resolves.toBe(monolithRetrieval);
    await drainUntil(() => logInfo.mock.calls.length === 1);
    expect(retrievePartition).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_read',
      { outcome: 'activation_unavailable' }
    );
  });

  it('does not inspect partition configuration when the shadow monolith fails', async () => {
    const failure = new Error('monolith failed');
    const readEnvironment = jest.fn((name: string) => {
      if (name === MODE_ENV_NAME) {
        return 'shadow';
      }
      throw new Error('partition environment was read too early');
    });
    const retrievePartition = jest.fn(async () => partitionRetrieval);
    const logInfo = jest.fn();

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment,
        retrieveMonolith: jest.fn(async () => {
          throw failure;
        }),
        retrievePartition,
        logInfo,
      })
    )).rejects.toBe(failure);
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(retrievePartition).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('serves only partition retrieval in exact partitioned mode without fallback', async () => {
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    const result = await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrieveMonolith,
        retrievePartition,
      })
    );

    expect(result).toBe(partitionRetrieval);
    expect(retrievePartition).toHaveBeenCalledTimes(1);
    expect(retrieveMonolith).not.toHaveBeenCalled();
  });

  it('keeps requested partitioned mode on monolith without cutover evidence', async () => {
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrieveMonolith,
        retrievePartition,
        resolveCutoverEvidence: undefined,
      })
    )).resolves.toBe(monolithRetrieval);
    expect(retrieveMonolith).toHaveBeenCalledTimes(1);
    expect(retrievePartition).not.toHaveBeenCalled();
  });

  it('keeps requested partitioned mode on monolith when gate evidence is unavailable', async () => {
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrieveMonolith,
        retrievePartition,
        resolveCutoverEvidence: async () => {
          throw new Error('bounded evidence unavailable');
        },
      })
    )).resolves.toBe(monolithRetrieval);
    expect(retrieveMonolith).toHaveBeenCalledTimes(1);
    expect(retrievePartition).not.toHaveBeenCalled();
  });

  it('keeps requested partitioned mode on monolith for an unsupported manifest embedding model', async () => {
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrieveMonolith,
        retrievePartition,
        resolveCutoverEvidence: input => ({
          ...completeCutoverEvidence(input),
          embeddingModel: 'text-embedding-legacy',
        }),
      })
    )).resolves.toBe(monolithRetrieval);
    expect(retrieveMonolith).toHaveBeenCalledTimes(1);
    expect(retrievePartition).not.toHaveBeenCalled();
  });

  it('serves protected queued booking relevance without distributing cursor keys to the worker', async () => {
    const retrievePartition = jest.fn(async (
      _universeId: string,
      plan: BackstageNotionPartitionRetrievalPlan,
      dependencies?: BackstageNotionPartitionRetrievalDependencies
    ) => {
      expect(plan.query).toBe('Book Raw in 2026');
      expect(dependencies?.resolveCursorEncryptionSecret).toBeUndefined();
      expect(dependencies?.resolvePreviousCursorEncryptionSecret).toBeUndefined();
      return partitionRetrieval;
    });
    const readEnvironment = withoutCursorSecrets(
      createEnvironment('partitioned')
    );

    await expect(retrieveBackstageNotionAuthorityBookingRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        isProtectedQueuedExecution: () => true,
        readEnvironment,
        retrievePartition,
      })
    )).resolves.toBe(partitionRetrieval);
    expect(retrievePartition).toHaveBeenCalledTimes(1);
    for (const environmentName of [
      BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET_ENV_NAME,
      BACKSTAGE_NOTION_PARTITION_CURSOR_PREVIOUS_SECRET_ENV_NAME,
    ]) {
      expect(readEnvironment).not.toHaveBeenCalledWith(environmentName);
    }
  });

  it('still requires the current cursor key for protected queued complete-scope reads', async () => {
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      {
        query: 'Read the full scope',
        retrievalMode: 'complete_scope',
      },
      authorizedDependencies({
        isProtectedQueuedExecution: () => true,
        readEnvironment: withoutCursorSecrets(
          createEnvironment('partitioned')
        ),
        retrievePartition,
      })
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(retrievePartition).not.toHaveBeenCalled();
  });

  it('propagates a partitioned outage without consulting the monolith', async () => {
    const failure = new BackstageNotionIndexUnavailableError();
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => {
      throw failure;
    });

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrieveMonolith,
        retrievePartition,
      })
    )).rejects.toBe(failure);
    expect(retrievePartition).toHaveBeenCalledTimes(1);
    expect(retrieveMonolith).not.toHaveBeenCalled();
  });

  it('re-reads mode per request so rollback immediately restores monolith reads', async () => {
    let mode = 'partitioned';
    const configuredEnvironment = createEnvironment('partitioned');
    const readEnvironment = jest.fn((name: string) => (
      name === MODE_ENV_NAME ? mode : configuredEnvironment(name)
    ));
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);
    const dependencies = authorizedDependencies({
      readEnvironment,
      retrieveMonolith,
      retrievePartition,
    });

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      dependencies
    )).resolves.toBe(partitionRetrieval);
    mode = 'monolith';
    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      dependencies
    )).resolves.toBe(monolithRetrieval);

    expect(retrievePartition).toHaveBeenCalledTimes(1);
    expect(retrieveMonolith).toHaveBeenCalledTimes(1);
    expect(readEnvironment.mock.calls.filter(([name]) => name === MODE_ENV_NAME))
      .toHaveLength(2);
  });

  it('fails closed with no monolith fallback for unconfigured partitioned universes', async () => {
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned', {
          configuration: partitionConfiguration(OTHER_UNIVERSE_ID),
        }),
        retrieveMonolith,
        retrievePartition,
      })
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(retrievePartition).not.toHaveBeenCalled();
    expect(retrieveMonolith).not.toHaveBeenCalled();
  });

  it.each([
    ['embedded whitespace', 'cursor secret with embedded whitespace 0123456789'],
    ['oversized UTF-8 bytes', 'é'.repeat(2_100)],
  ])('rejects %s in the partition cursor secret without fallback', async (
    _label,
    cursorSecret
  ) => {
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async () => partitionRetrieval);

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned', { cursorSecret }),
        retrieveMonolith,
        retrievePartition,
      })
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(retrievePartition).not.toHaveBeenCalled();
    expect(retrieveMonolith).not.toHaveBeenCalled();
  });

  it('skips monolith cursor continuations before partition environment reads', async () => {
    const cursorRetrieval: BackstageNotionRagRetrieval = {
      ...monolithRetrieval,
      retrievalMode: 'complete_scope',
      nextCursor: 'next-monolith-cursor',
    };
    const readEnvironment = jest.fn((name: string) => {
      if (name === MODE_ENV_NAME) {
        return 'shadow';
      }
      throw new Error('cursor shadow should not read partition configuration');
    });
    const retrievePartition = jest.fn(async () => partitionRetrieval);
    const logInfo = jest.fn();

    const result = await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      {
        query: 'Continue the exact scope',
        retrievalMode: 'complete_scope',
        cursor: 'existing-monolith-cursor',
      },
      authorizedDependencies({
        readEnvironment,
        retrieveMonolith: jest.fn(async () => cursorRetrieval),
        retrievePartition,
        logInfo,
      })
    );

    expect(result).toBe(cursorRetrieval);
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(retrievePartition).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_read',
      { outcome: 'cursor_continuation_skipped' }
    );
  });

  it('shares one lazy query-bound embedding across sequential shadow reads', async () => {
    const embedQuery = jest.fn(async () => [0.5, 0.5]);
    const retrieveMonolith = jest.fn(async (
      _universeId: string,
      _query: BackstageNotionRagQuery,
      dependencies?: { embedQuery?: (query: string) => Promise<number[]> }
    ) => {
      await dependencies?.embedQuery?.('Book Raw in 2026');
      await dependencies?.embedQuery?.('Book Raw in 2026');
      return monolithRetrieval;
    });
    const retrievePartition = jest.fn(async (
      _universeId: string,
      _plan: BackstageNotionPartitionRetrievalPlan,
      dependencies?: BackstageNotionPartitionRetrievalDependencies
    ) => {
      await dependencies?.embedQuery?.('Book Raw in 2026');
      return partitionRetrieval;
    });

    await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('shadow'),
        retrieveMonolith,
        retrievePartition,
        embedQuery,
        logInfo: jest.fn(),
      })
    );

    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(embedQuery).toHaveBeenCalledWith('Book Raw in 2026');
  });

  it('does not generate an embedding for partitioned complete-scope retrieval', async () => {
    const embedQuery = jest.fn(async () => [0.5, 0.5]);
    const retrievePartition = jest.fn(async (
      _universeId: string,
      plan: BackstageNotionPartitionRetrievalPlan,
      dependencies?: BackstageNotionPartitionRetrievalDependencies
    ) => {
      expect(plan.relevantRoutingIntent).toBeUndefined();
      expect(dependencies?.embedQuery).toEqual(expect.any(Function));
      return partitionRetrieval;
    });

    await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      {
        query: 'Read the full scope',
        retrievalMode: 'complete_scope',
      },
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrievePartition,
        embedQuery,
      })
    );

    expect(embedQuery).not.toHaveBeenCalled();
  });

  it.each([
    [
      'underspecified hot/cold query',
      'Who should win tonight?',
      ['hot', 'cold'],
      [
        {
          allScopeTags: [],
          allCategoryTags: [],
        },
      ],
    ],
    [
      'brand, year, and exact archive signal',
      'Use archived Raw championship history from 2026',
      ['archive'],
      [
        {
          allScopeTags: ['brand:raw', 'year:2026'],
          allCategoryTags: [],
        },
        {
          allScopeTags: ['shared'],
          allCategoryTags: [],
        },
      ],
    ],
    [
      'archival is not an exact archive signal',
      'Use archival Raw championship context from 2026',
      ['hot', 'cold'],
      [
        {
          allScopeTags: ['brand:raw', 'year:2026'],
          allCategoryTags: [],
        },
        {
          allScopeTags: ['shared'],
          allCategoryTags: [],
        },
      ],
    ],
    [
      'PLE lane, year, and shared canon',
      'Book WrestleMania 2026',
      ['hot', 'cold'],
      [
        {
          allScopeTags: ['lane:ples', 'year:2026'],
          allCategoryTags: [],
        },
        {
          allScopeTags: ['shared'],
          allCategoryTags: [],
        },
      ],
    ],
  ])('derives bounded server-owned routing for %s', async (
    _label,
    query,
    allowedTiers,
    selectors
  ) => {
    const retrievePartition = jest.fn(async (
      _universeId: string,
      plan: BackstageNotionPartitionRetrievalPlan
    ) => {
      expect(plan.relevantRoutingIntent).toMatchObject({
        allowedTiers,
        selectors,
      });
      return partitionRetrieval;
    });

    await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      query,
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrievePartition,
      })
    );
    expect(retrievePartition).toHaveBeenCalledTimes(1);
  });

  it('routes a narrowed lane with shared canon while isolating an unrelated archive omission', async () => {
    const routingState = {
      universeId: UNIVERSE_ID,
      manifestId: '11111111-1111-4111-8111-111111111111',
      manifestGeneration: '1',
      configurationVersionId: '22222222-2222-4222-8222-222222222222',
      configurationHash: 'a'.repeat(64),
      configurationCurrent: true,
      embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
      embeddingVersion: 1,
      embeddingDimension: 2,
      indexFormatVersion: 1,
      members: [
        {
          shardKey: 'raw/2026',
          partitionVersionId: '33333333-3333-4333-8333-333333333333',
          snapshotId: '44444444-4444-4444-8444-444444444444',
          retrievalTier: 'hot',
          required: true,
          decision: 'fresh',
          verifiedAt: '2026-08-24T12:00:00.000Z',
          scopeTags: ['brand:raw', 'year:2026'],
          categoryTags: ['current-canon'],
        },
        {
          shardKey: 'shared',
          partitionVersionId: '55555555-5555-4555-8555-555555555555',
          snapshotId: '66666666-6666-4666-8666-666666666666',
          retrievalTier: 'hot',
          required: true,
          decision: 'fresh',
          verifiedAt: '2026-08-24T12:00:00.000Z',
          scopeTags: ['shared'],
          categoryTags: ['current-canon'],
        },
        {
          shardKey: ['smackdown', '2026'].join('/'),
          partitionVersionId: '77777777-7777-4777-8777-777777777777',
          snapshotId: '88888888-8888-4888-8888-888888888888',
          retrievalTier: 'hot',
          required: true,
          decision: 'fresh',
          verifiedAt: '2026-08-24T12:00:00.000Z',
          scopeTags: ['brand:smackdown', 'year:2026'],
          categoryTags: ['current-canon'],
        },
        {
          shardKey: 'ples/2026',
          partitionVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          retrievalTier: 'hot',
          required: true,
          decision: 'fresh',
          verifiedAt: '2026-08-24T12:00:00.000Z',
          scopeTags: ['lane:ples', 'year:2026'],
          categoryTags: ['current-canon', 'events'],
        },
      ],
      omissions: [{
        shardKey: 'archive/raw/2025',
        partitionVersionId: '99999999-9999-4999-8999-999999999999',
        retrievalTier: 'archive',
        required: false,
        decision: 'optional_unavailable',
        safeReasonCode: 'SHARD_SYNC_INCOMPLETE',
        scopeTags: ['brand:raw', 'year:2025'],
        categoryTags: ['archive'],
      }],
    };
    let expectedShardKeys = ['raw/2026', 'shared'];
    const retrievePartition = jest.fn(async (
      _universeId: string,
      plan: BackstageNotionPartitionRetrievalPlan
    ) => {
      const resolution = resolveBackstageNotionPartitionRouting(
        routingState,
        plan.relevantRoutingIntent
      );
      expect(resolution).toMatchObject({
        status: 'resolved',
        complete: true,
        matchingOmissions: [],
      });
      if (resolution.status !== 'resolved') {
        throw new Error('Expected resolved routing.');
      }
      expect(resolution.shards.map(shard => shard.shardKey))
        .toEqual(expectedShardKeys);
      return partitionRetrieval;
    });

    await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrievePartition,
      })
    );
    expectedShardKeys = ['ples/2026', 'shared'];
    await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book WrestleMania 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrievePartition,
      })
    );
    expect(retrievePartition).toHaveBeenCalledTimes(2);
  });

  it.each([
    'Book Raw across 2010 2011 2012 2013 2014 2015 2016 2017 2018',
    'Book a cross-brand WrestleMania across 2010 2011 2012 2013 2014 2015 2016 2017',
  ])('fails closed instead of broadening an over-specified routing request: %s', async query => {
    const retrievePartition = jest.fn(async () => partitionRetrieval);
    const readEnvironment = createEnvironment('partitioned');

    await expect(retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      query,
      authorizedDependencies({ readEnvironment, retrievePartition })
    )).rejects.toBeInstanceOf(BackstageNotionIndexUnavailableError);
    expect(retrievePartition).not.toHaveBeenCalled();
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(readEnvironment).toHaveBeenCalledWith(MODE_ENV_NAME);
  });

  it.each([
    [
      'exact relevant scope',
      {
        query: 'Who is champion?',
        retrievalScope: { pageTitle: 'Monday Night Raw' },
      },
    ],
    [
      'complete scope',
      {
        query: 'Read the full scope',
        retrievalMode: 'complete_scope',
      },
    ],
  ])('never supplies caller routing intent for %s', async (_label, query) => {
    const retrievePartition = jest.fn(async (
      _universeId: string,
      plan: BackstageNotionPartitionRetrievalPlan
    ) => {
      expect(plan).toEqual({ query });
      expect(plan).not.toHaveProperty('relevantRoutingIntent');
      return partitionRetrieval;
    });

    await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      query as BackstageNotionRagQuery,
      authorizedDependencies({
        readEnvironment: createEnvironment('partitioned'),
        retrievePartition,
      })
    );
  });

  it('uses the booking monolith boundary and derives the same closed routing plan', async () => {
    const retrieveMonolith = jest.fn(async () => monolithRetrieval);
    const retrieveBookingMonolith = jest.fn(async () => monolithRetrieval);
    const retrievePartition = jest.fn(async (
      _universeId: string,
      plan: BackstageNotionPartitionRetrievalPlan
    ) => {
      expect(plan.relevantRoutingIntent?.selectors).toEqual([
        {
          allScopeTags: ['brand:smackdown', 'year:2026'],
          allCategoryTags: [],
        },
        {
          allScopeTags: ['shared'],
          allCategoryTags: [],
        },
      ]);
      return partitionRetrieval;
    });

    const result = await retrieveBackstageNotionAuthorityBookingRagContext(
      UNIVERSE_ID,
      'Book SmackDown in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('shadow'),
        retrieveMonolith,
        retrieveBookingMonolith,
        retrievePartition,
        logInfo: jest.fn(),
      })
    );

    expect(result).toBe(monolithRetrieval);
    expect(retrieveBookingMonolith).toHaveBeenCalledTimes(1);
    expect(retrieveMonolith).not.toHaveBeenCalled();
  });

  it('returns monolith without waiting for an unresolved shadow read', async () => {
    let resolvePartition!: (
      value: BackstageNotionPartitionRagRetrieval
    ) => void;
    const retrievePartition = jest.fn(() => (
      new Promise<BackstageNotionPartitionRagRetrieval>(resolve => {
        resolvePartition = resolve;
      })
    ));
    const logInfo = jest.fn();

    const result = await retrieveBackstageNotionAuthorityRagContext(
      UNIVERSE_ID,
      'Book Raw in 2026',
      authorizedDependencies({
        readEnvironment: createEnvironment('shadow'),
        retrieveMonolith: jest.fn(async () => monolithRetrieval),
        retrievePartition,
        logInfo,
      })
    );

    expect(result).toBe(monolithRetrieval);
    await drainUntil(() => retrievePartition.mock.calls.length === 1);
    expect(retrievePartition).toHaveBeenCalledTimes(1);
    expect(logInfo).not.toHaveBeenCalled();
    resolvePartition(partitionRetrieval);
    await drainUntil(() => logInfo.mock.calls.length === 1);
    expect(logInfo).toHaveBeenCalledWith(
      'backstage.notion_partition.shadow_read',
      expect.objectContaining({ outcome: 'compared' })
    );
  });

  it('admits no shadow backlog after the fixed comparison capacity is full', async () => {
    const resolvers: Array<(
      value: BackstageNotionPartitionRagRetrieval
    ) => void> = [];
    const retrievePartition = jest.fn(() => (
      new Promise<BackstageNotionPartitionRagRetrieval>(resolve => {
        resolvers.push(resolve);
      })
    ));
    const logInfo = jest.fn();
    const dependencies = authorizedDependencies({
      readEnvironment: createEnvironment('shadow'),
      retrieveMonolith: jest.fn(async () => monolithRetrieval),
      retrievePartition,
      logInfo,
    });
    const pending = Array.from(
      { length: BACKSTAGE_NOTION_PARTITION_SHADOW_MAX_IN_FLIGHT },
      () => retrieveBackstageNotionAuthorityRagContext(
        UNIVERSE_ID,
        'Book Raw in 2026',
        dependencies
      )
    );
    try {
      for (let attempt = 0; attempt < 20 && resolvers.length
        < BACKSTAGE_NOTION_PARTITION_SHADOW_MAX_IN_FLIGHT; attempt += 1) {
        await Promise.resolve();
      }
      expect(resolvers).toHaveLength(
        BACKSTAGE_NOTION_PARTITION_SHADOW_MAX_IN_FLIGHT
      );

      await expect(retrieveBackstageNotionAuthorityRagContext(
        UNIVERSE_ID,
        'Book Raw in 2026',
        dependencies
      )).resolves.toBe(monolithRetrieval);
      expect(retrievePartition).toHaveBeenCalledTimes(
        BACKSTAGE_NOTION_PARTITION_SHADOW_MAX_IN_FLIGHT
      );
      expect(logInfo).toHaveBeenCalledWith(
        'backstage.notion_partition.shadow_read',
        { outcome: 'capacity_skipped' }
      );
    } finally {
      for (const resolve of resolvers) {
        resolve(partitionRetrieval);
      }
      await Promise.all(pending);
    }
  });
});

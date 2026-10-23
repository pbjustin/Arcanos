import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  resolveBackstageNotionProtectedBookingAdmission,
  type BackstageNotionPartitionCutoverDependencies,
} from '../src/services/backstageNotionPartitionCutover.js';
import type {
  BackstageNotionMonolithAuthorityStatusData,
  BackstageNotionMonolithAuthorityStatusResolution,
} from '../src/services/backstageNotionAuthorityStatus.js';
import type {
  BackstageNotionPartitionCutoverGateEvidence,
} from '../src/shared/backstage/backstageNotionPartitionCutoverGate.js';

const UNIVERSE_ID = 'synthetic-authority-universe';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const QUERY = 'Book a Raw title match for 2026.';
const LITERAL = 'Write exactly this token and nothing else: AUTHORITY-READY';

function monolithStatus(
  overrides: Partial<BackstageNotionMonolithAuthorityStatusData> = {}
): BackstageNotionMonolithAuthorityStatusResolution {
  return { status: 'ready', data: {
    version: 1,
    surface: 'monolith_authority',
    authority: 'notion',
    status: 'current_complete',
    snapshotStatus: 'current_complete',
    freshnessSatisfied: true,
    syncInProgress: false,
    activeSnapshotReadable: true,
    activeSnapshotChunkCount: 3_349,
    latestSyncOutcome: 'unchanged',
    latestSyncFailurePhase: null,
    latestSyncFailureReason: null,
    ...overrides,
  } };
}

function runningStatus(
  overrides: Partial<BackstageNotionMonolithAuthorityStatusData> = {}
): BackstageNotionMonolithAuthorityStatusResolution {
  return monolithStatus({
    status: 'syncing',
    snapshotStatus: 'last_known_good',
    syncInProgress: true,
    latestSyncOutcome: 'running',
    ...overrides,
  });
}

function readEnvironment(mode = 'monolith', configuration?: string) {
  const partitionConfiguration = configuration ?? JSON.stringify({
    version: 1,
    generation: 'synthetic-admission-generation',
    universes: [{ universeId: UNIVERSE_ID, shards: [{
      shardKey: 'raw/year-2026',
      rootPageId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Synthetic Raw 2026',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:raw', 'year:2026'],
      categoryTags: ['show'],
      capacity: { maxPages: 64, maxChunks: 512, maxDepth: 8, maxContentCodePoints: 500_000 },
    }] }],
  });
  return (name: string): string | undefined => {
    if (name === 'ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE') return mode;
    if (name === 'ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON') return partitionConfiguration;
    if (name === 'ARCANOS_BACKSTAGE_NOTION_PARTITION_CURSOR_SECRET') return 'c'.repeat(32);
    return undefined;
  };
}

function completeEvidence(input: {
  universeId: string;
  configurationHash: string;
  configuredShardKeys: readonly string[];
}): BackstageNotionPartitionCutoverGateEvidence {
  const manifestId = '22222222-2222-4222-8222-222222222222';
  const configurationVersionId = '33333333-3333-4333-8333-333333333333';
  const sourceGenerationId = '44444444-4444-4444-8444-444444444444';
  return {
    evidenceVersion: 1,
    reconciliationGeneration: 7,
    activeReconciliationGeneration: 7,
    publishedReconciliationGeneration: 7,
    universeId: input.universeId,
    manifestId,
    activeManifestId: manifestId,
    manifestState: 'sealed',
    manifestReadable: true,
    manifestConfigurationVersionId: configurationVersionId,
    activeConfigurationVersionId: configurationVersionId,
    configurationHash: input.configurationHash,
    activeConfigurationHash: input.configurationHash,
    sourceGenerationId,
    sourceDigest: 'a'.repeat(64),
    sourcePageCount: 2,
    sourceChunkCount: 20,
    sourceVerifiedAt: new Date(Date.now() - 120_000),
    sourceVerificationHash: 'b'.repeat(64),
    manifestPageCount: 2,
    manifestChunkCount: 20,
    embeddingModel: 'text-embedding-3-small',
    indexFormatVersion: 1,
    memberCount: 1,
    omissionCount: 0,
    members: input.configuredShardKeys.map(shardKey => ({
      shardKey,
      snapshotId: '55555555-5555-4555-8555-555555555555',
      sourceGenerationId,
      indexFormatVersion: 1,
      pageCount: 2,
      chunkCount: 20,
      decision: 'fresh',
      readable: true,
    })),
    leaseFencingClear: true,
    unresolvedActivationCount: 0,
    parity: {
      shadowComparisonCompleted: true,
      exactScopeParityPassed: true,
      relevantRetrievalParityPassed: true,
      completeScopeParityPassed: true,
      cursorStabilityPassed: true,
    },
    rollbackMonolithSnapshotId: '66666666-6666-4666-8666-666666666666',
    rollbackMonolithReadable: true,
    rollbackMonolithChunkCount: 3_349,
    rollbackMonolithValidationVerifiedAt: new Date(Date.now() - 120_000),
    rollbackMonolithVerifiedAt: new Date(Date.now() - 120_000),
    rollbackMonolithValidUntil: new Date(Date.now() + 3_600_000),
    verifiedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

function dependencies(resolution = monolithStatus()) {
  const resolveMonolithAuthorityStatus = jest.fn(async () => resolution);
  const embedQuery = jest.fn(async () => [1]);
  const retrieveMonolith = jest.fn<NonNullable<BackstageNotionPartitionCutoverDependencies['retrieveMonolith']>>();
  const retrieveBookingMonolith = jest.fn<NonNullable<BackstageNotionPartitionCutoverDependencies['retrieveBookingMonolith']>>();
  const retrievePartition = jest.fn<NonNullable<BackstageNotionPartitionCutoverDependencies['retrievePartition']>>();
  const options: BackstageNotionPartitionCutoverDependencies = {
    isAuthorized: () => true,
    isProtectedQueuedExecution: () => true,
    readEnvironment: readEnvironment(),
    resolveMonolithAuthorityStatus,
    embedQuery,
    retrieveMonolith,
    retrieveBookingMonolith,
    retrievePartition,
  };
  return { options, resolveMonolithAuthorityStatus, embedQuery, retrieveMonolith, retrieveBookingMonolith, retrievePartition };
}

describe('protected Backstage cheap authority admission', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  it.each([QUERY, LITERAL])('admits current_complete authority without corpus or AI work: %s', async query => {
    const fixture = dependencies();
    await expect(resolveBackstageNotionProtectedBookingAdmission(UNIVERSE_ID, query, fixture.options)).resolves.toBe('ready');
    expect(fixture.resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(1);
    expect(fixture.resolveMonolithAuthorityStatus).toHaveBeenCalledWith({
      universeId: UNIVERSE_ID,
      dependencies: { readEnvironment: fixture.options.readEnvironment },
    });
    expect(fixture.embedQuery).not.toHaveBeenCalled();
    expect(fixture.retrieveBookingMonolith).not.toHaveBeenCalled();
    expect(fixture.retrievePartition).not.toHaveBeenCalled();
  });

  it('waits only for a readable fresh last_known_good snapshot with an active running refresh', async () => {
    const fixture = dependencies(runningStatus());
    await expect(resolveBackstageNotionProtectedBookingAdmission(UNIVERSE_ID, QUERY, fixture.options)).resolves.toBe('waiting');
    expect(fixture.resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(1);
    expect(fixture.embedQuery).not.toHaveBeenCalled();
    expect(fixture.retrieveMonolith).not.toHaveBeenCalled();
    expect(fixture.retrieveBookingMonolith).not.toHaveBeenCalled();
    expect(fixture.retrievePartition).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['stale snapshot', runningStatus({ freshnessSatisfied: false })],
    ['unreadable snapshot', runningStatus({ activeSnapshotReadable: false })],
    ['incompatible snapshot', { status: 'unavailable' } as const],
    ['orphaned running attempt', runningStatus({ status: 'last_known_good', syncInProgress: false })],
    ['failed synchronization', runningStatus({ status: 'last_known_good', syncInProgress: false, latestSyncOutcome: 'failed', latestSyncFailurePhase: 'embedding', latestSyncFailureReason: 'embedding_failed' })],
    ['last_known_good without refresh', monolithStatus({ status: 'last_known_good', snapshotStatus: 'last_known_good' })],
  ] as const)('fails closed for %s', async (_label, resolution) => {
    const fixture = dependencies(resolution);
    await expect(resolveBackstageNotionProtectedBookingAdmission(UNIVERSE_ID, QUERY, fixture.options)).resolves.toBe('unavailable');
    expect(fixture.embedQuery).not.toHaveBeenCalled();
    expect(fixture.retrieveBookingMonolith).not.toHaveBeenCalled();
  });

  it('does not widen non-Notion universe behavior', async () => {
    const fixture = dependencies({ status: 'not_found' });
    await expect(resolveBackstageNotionProtectedBookingAdmission('legacy-universe', QUERY, fixture.options)).resolves.toBe('not_applicable');
    expect(fixture.embedQuery).not.toHaveBeenCalled();
  });

  it('fails authorization and unexpected authority errors closed', async () => {
    const fixture = dependencies();
    await expect(resolveBackstageNotionProtectedBookingAdmission(UNIVERSE_ID, QUERY, {
      ...fixture.options, isAuthorized: () => false,
    })).resolves.toBe('unavailable');
    fixture.resolveMonolithAuthorityStatus.mockRejectedValueOnce(new Error('private-provider-token-sentinel'));
    await expect(resolveBackstageNotionProtectedBookingAdmission(UNIVERSE_ID, QUERY, fixture.options)).resolves.toBe('unavailable');
  });

  it('preserves selected partition authority without replacing it with monolith freshness policy', async () => {
    const fixture = dependencies(runningStatus());
    const resolveCutoverEvidence = jest.fn(completeEvidence);
    await expect(resolveBackstageNotionProtectedBookingAdmission(UNIVERSE_ID, QUERY, {
      ...fixture.options, readEnvironment: readEnvironment('partitioned'), resolveCutoverEvidence,
    })).resolves.toBe('ready');
    expect(resolveCutoverEvidence).toHaveBeenCalledTimes(1);
    expect(fixture.resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(1);
    expect(fixture.retrievePartition).not.toHaveBeenCalled();
    expect(fixture.embedQuery).not.toHaveBeenCalled();
  });

  it('uses monolith waiting only when the configured partition cutover gate selects monolith fallback', async () => {
    const fixture = dependencies(runningStatus());
    await expect(resolveBackstageNotionProtectedBookingAdmission(UNIVERSE_ID, QUERY, {
      ...fixture.options, readEnvironment: readEnvironment('partitioned'), resolveCutoverEvidence: () => null,
    })).resolves.toBe('waiting');
    expect(fixture.resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(1);
    expect(fixture.embedQuery).not.toHaveBeenCalled();
  });

  it('retains exact-literal monolith verification even when partition cutover is available', async () => {
    const fixture = dependencies(runningStatus());
    const resolveCutoverEvidence = jest.fn(completeEvidence);
    await expect(resolveBackstageNotionProtectedBookingAdmission(UNIVERSE_ID, LITERAL, {
      ...fixture.options, readEnvironment: readEnvironment('partitioned'), resolveCutoverEvidence,
    })).resolves.toBe('waiting');
    expect(resolveCutoverEvidence).not.toHaveBeenCalled();
    expect(fixture.resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(1);
    expect(fixture.embedQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed partition configuration', UNIVERSE_ID, readEnvironment('partitioned', '{')],
    ['cross-universe partition request', 'other-universe', readEnvironment('partitioned')],
  ] as const)('rejects %s without retrieval or AI work', async (_label, universeId, environment) => {
    const fixture = dependencies();
    await expect(resolveBackstageNotionProtectedBookingAdmission(universeId, QUERY, {
      ...fixture.options, readEnvironment: environment,
    })).resolves.toBe('unavailable');
    expect(fixture.resolveMonolithAuthorityStatus).toHaveBeenCalledTimes(1);
    expect(fixture.embedQuery).not.toHaveBeenCalled();
  });
});

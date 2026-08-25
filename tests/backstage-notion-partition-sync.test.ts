import { createHash, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

import type {
  ActivateBackstageNotionShardSnapshotInput,
  ActivateBackstageNotionUniverseManifestInput,
  BackstageNotionPartitionHeadExpectation,
  BackstageNotionReusablePageMaterial,
  BackstageNotionPartitionSynchronizationState,
  BackstageNotionProviderLease,
  BackstageNotionUniverseHeadExpectation,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import {
  BackstageNotionPartitionRepositoryError,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import {
  parseBackstageNotionPartitionConfiguration,
  type BackstageNotionPartitionConfiguration,
  type BackstageNotionPartitionDefinition,
  type BackstageNotionPartitionUniverse,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  decideBackstageNotionPartitionManifestMembership,
  planBackstageNotionPartitionFullReconciliation,
} from '@shared/backstage/backstageNotionPartitionSyncCore.js';
import {
  chunkBackstageNotionInspectedPage,
  inspectBackstageNotionRagPage,
} from '@shared/backstage/backstageNotionRagCore.js';
import {
  BackstageNotionReadError,
  type BackstageNotionFetchImplementation,
  type BackstageNotionMarkdownResponse,
  type BackstageNotionPageMetadata,
} from '@shared/backstage/backstageNotionContextCore.js';
import {
  createBackstageNotionPartitionProviderCaptureDependencies,
  groupBackstageNotionPartitionRootPageIdsByUniverse,
  syncBackstageNotionPartitionConfiguration,
  validateBackstageNotionPartitionCapture,
  type BackstageNotionPartitionCapturedPageMetadata,
  type BackstageNotionPartitionFullCapture,
  type BackstageNotionPartitionProviderPermit,
  type BackstageNotionPartitionSyncDependencies,
  type BackstageNotionPartitionSyncRepository,
  type BackstageNotionPartitionVerificationPass,
} from '@services/backstageNotionPartitionSync.js';

const NOW = new Date('2026-08-24T16:00:00.000Z');
const EDITED_AT = new Date('2026-08-24T15:00:00.000Z');
const EXTERNAL_PARENT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function shard(
  index: number,
  overrides: Partial<Omit<BackstageNotionPartitionDefinition, 'capacity'>> & {
    capacity?: Partial<BackstageNotionPartitionDefinition['capacity']>;
  } = {}
): BackstageNotionPartitionDefinition {
  const { capacity, ...definitionOverrides } = overrides;
  return {
    universeId: 'my-universe-2k26',
    shardKey: `shard-${index}`,
    rootPageId: uuidFor(index),
    displayName: `Shard ${index}`,
    retrievalTier: 'hot',
    required: true,
    scopeTags: [],
    categoryTags: [],
    capacity: {
      maxPages: 10,
      maxChunks: 2_048,
      maxDepth: 4,
      maxContentCodePoints: 4_000_000,
      ...capacity,
    },
    ...definitionOverrides,
  };
}

function configuration(
  shards: readonly BackstageNotionPartitionDefinition[]
): Extract<BackstageNotionPartitionConfiguration, { status: 'valid' }> {
  const parsed = parseBackstageNotionPartitionConfiguration(JSON.stringify({
    version: 1,
    generation: 'test-generation-1',
    universes: [{
      universeId: 'my-universe-2k26',
      shards: shards.map(value => ({
        shardKey: value.shardKey,
        rootPageId: value.rootPageId,
        displayName: value.displayName,
        retrievalTier: value.retrievalTier,
        required: value.required,
        scopeTags: value.scopeTags,
        categoryTags: value.categoryTags,
        capacity: value.capacity,
      })),
    }],
  }));
  if (parsed.status !== 'valid') {
    throw new Error('Test configuration is invalid.');
  }
  return parsed;
}

function fullCapture(
  definition: BackstageNotionPartitionDefinition,
  markdown = `# ${definition.displayName}\n\nCurrent canon.`,
  completeness: Partial<BackstageNotionPartitionFullCapture['completeness']> = {}
): BackstageNotionPartitionFullCapture {
  const page = inspectBackstageNotionRagPage({
    universeId: definition.universeId,
    pageId: definition.rootPageId,
    parentPageId: null,
    title: definition.displayName,
    path: [definition.displayName],
    markdown,
    sourceLastEditedAt: EDITED_AT.toISOString(),
  });
  return {
    captureMode: 'full_hierarchy_content_scan',
    pages: [{
      page,
      metadata: {
        pageId: page.pageId,
        parentPageId: EXTERNAL_PARENT_ID,
        inTrash: false,
        lastEditedAt: EDITED_AT,
      },
    }],
    completeness: {
      truncatedPageCount: 0,
      unsupportedBlockCount: 0,
      ambiguousChildReferenceCount: 0,
      ...completeness,
    },
    capturedAt: new Date('2026-08-24T15:30:00.000Z'),
  };
}

function secondPass(
  capture: BackstageNotionPartitionFullCapture,
  mutate?: (
    metadata: BackstageNotionPartitionCapturedPageMetadata
  ) => BackstageNotionPartitionCapturedPageMetadata
): BackstageNotionPartitionVerificationPass {
  return {
    verificationMode: 'full_metadata_second_pass',
    pages: capture.pages.map(item => mutate
      ? mutate(item.metadata)
      : item.metadata),
    verifiedAt: new Date('2026-08-24T15:45:00.000Z'),
  };
}

interface FakeHead {
  partitionVersionId: string;
  rootPageId: string;
  headGeneration: number;
  snapshotGeneration: number;
  activeSnapshotId: string | null;
  verifiedAt: Date | null;
  sourceManifestHash: string | null;
  embeddingModel: string | null;
  embeddingVersion: number | null;
  embeddingDimension: number | null;
  indexFormatVersion: number | null;
}

class FakePartitionRepository {
  readonly shardActivationInputs: ActivateBackstageNotionShardSnapshotInput[] = [];
  readonly manifestActivationInputs: ActivateBackstageNotionUniverseManifestInput[] = [];
  readonly shardReleaseOrder: string[] = [];
  readonly immutableManifestIds: string[] = [];
  readonly busyShardKeys = new Set<string>();
  readonly ownershipOmittedShardKeys = new Set<string>();
  providerOperations = 0;
  maximumProviderOperations = 0;
  failFirstManifestCas = false;
  failManifestOwnership = false;

  private configurationVersionId = uuidFor(9_000);
  private configurationGeneration = 'test-generation-1';
  private configurationHash = '0'.repeat(64);
  private universeHeadGeneration = 0;
  private manifestGeneration = 0;
  private activeManifestId: string | null = null;
  private definitions = new Map<string, BackstageNotionPartitionDefinition>();
  private heads = new Map<string, FakeHead>();
  private shardLeases = new Map<string, { holderId: string; leaseToken: string; generation: number }>();
  private providerLease: BackstageNotionProviderLease | null = null;
  private chunks = new Map<string, {
    id: string;
    content: string;
    contentCodePoints: number;
    embedded: boolean;
  }>();
  private pages = new Map<string, { id: string; contentHash: string }>();

  readonly loadUniverseHead = jest.fn(async (): Promise<BackstageNotionUniverseHeadExpectation | null> => (
    this.definitions.size === 0 ? null : this.universeExpectation()
  ));

  readonly registerConfiguration = jest.fn(async (input: {
    configurationGeneration: string;
    configurationHash: string;
    universe: BackstageNotionPartitionUniverse;
    expectedUniverseHead: BackstageNotionUniverseHeadExpectation | null;
  }) => {
    const nextDefinitions = new Map(input.universe.shards.map(value => [value.shardKey, value]));
    for (const value of input.universe.shards) {
      const partitionVersionId = this.partitionVersionId(value);
      const existing = this.heads.get(value.shardKey);
      if (!existing) {
        this.heads.set(value.shardKey, {
          partitionVersionId,
          rootPageId: value.rootPageId,
          headGeneration: 0,
          snapshotGeneration: 0,
          activeSnapshotId: null,
          verifiedAt: null,
          sourceManifestHash: null,
          embeddingModel: null,
          embeddingVersion: null,
          embeddingDimension: null,
          indexFormatVersion: null,
        });
      }
    }
    this.definitions = nextDefinitions;
    this.configurationGeneration = input.configurationGeneration;
    this.configurationHash = input.configurationHash;
    return {
      configurationVersionId: this.configurationVersionId,
      universeId: input.universe.universeId,
      configurationGeneration: input.configurationGeneration,
      configurationHash: input.configurationHash,
      reused: false,
      universeHeadGeneration: String(this.universeHeadGeneration),
      definitions: input.universe.shards.map(value => ({
        shardKey: value.shardKey,
        partitionVersionId: this.partitionVersionId(value),
        rootPageId: value.rootPageId,
      })),
    };
  });

  readonly loadUniverseSynchronizationState = jest.fn(async () => this.state());
  readonly loadShardPageInventory = jest.fn(async () => []);

  readonly acquireShardLease = jest.fn(async (
    universeId: string,
    shardKey: string,
    holderId: string
  ) => {
    if (this.busyShardKeys.has(shardKey) || this.shardLeases.has(shardKey)) {
      return null;
    }
    const stored = { holderId, leaseToken: randomUUID(), generation: 1 };
    this.shardLeases.set(shardKey, stored);
    return {
      universeId,
      shardKey,
      holderId,
      leaseToken: stored.leaseToken,
      leaseGeneration: '1',
      acquiredAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    };
  });

  readonly renewShardLease = jest.fn(async (
    universeId: string,
    shardKey: string,
    fence: { holderId: string; leaseToken: string; leaseGeneration: string }
  ) => {
    const stored = this.shardLeases.get(shardKey);
    if (
      !stored
      || stored.holderId !== fence.holderId
      || stored.leaseToken !== fence.leaseToken
      || String(stored.generation) !== fence.leaseGeneration
    ) {
      return null;
    }
    stored.generation += 1;
    return {
      universeId,
      shardKey,
      holderId: stored.holderId,
      leaseToken: stored.leaseToken,
      leaseGeneration: String(stored.generation),
      acquiredAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    };
  });

  readonly releaseShardLease = jest.fn(async (
    _universeId: string,
    shardKey: string,
    fence: { holderId: string; leaseToken: string; leaseGeneration: string }
  ) => {
    const stored = this.shardLeases.get(shardKey);
    const matches = stored?.holderId === fence.holderId
      && stored.leaseToken === fence.leaseToken
      && String(stored.generation) === fence.leaseGeneration;
    if (matches) {
      this.shardLeases.delete(shardKey);
      this.shardReleaseOrder.push(shardKey);
    }
    return matches;
  });

  readonly acquireProviderLease = jest.fn(async (
    providerKey: string,
    modelKey: string,
    holderId: string
  ) => {
    if (this.providerLease) {
      return null;
    }
    this.providerOperations += 1;
    this.maximumProviderOperations = Math.max(
      this.maximumProviderOperations,
      this.providerOperations
    );
    this.providerLease = {
      providerKey,
      modelKey,
      holderId,
      leaseToken: randomUUID(),
      leaseGeneration: '1',
      acquiredAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
      nextRequestAt: NOW,
    };
    return this.providerLease;
  });

  readonly renewProviderLease = jest.fn(async (
    _providerKey: string,
    _modelKey: string,
    fence: { leaseToken: string; leaseGeneration: string }
  ) => {
    if (
      !this.providerLease
      || this.providerLease.leaseToken !== fence.leaseToken
      || this.providerLease.leaseGeneration !== fence.leaseGeneration
    ) {
      return null;
    }
    this.providerLease = {
      ...this.providerLease,
      leaseGeneration: String(Number(this.providerLease.leaseGeneration) + 1),
    };
    return this.providerLease;
  });

  readonly releaseProviderLease = jest.fn(async (
    _providerKey: string,
    _modelKey: string,
    fence: { leaseToken: string; leaseGeneration: string }
  ) => {
    if (
      this.providerLease?.leaseToken !== fence.leaseToken
      || this.providerLease.leaseGeneration !== fence.leaseGeneration
    ) {
      return false;
    }
    this.providerLease = null;
    this.providerOperations -= 1;
    return true;
  });

  readonly findReusablePageMaterial = jest.fn(async (_input: {
    pageId: string;
    contentHash: string;
  }): Promise<BackstageNotionReusablePageMaterial | null> => null);

  readonly findReusableChunkMaterials = jest.fn(async (input: {
    contentHashes: readonly string[];
  }) => input.contentHashes.flatMap(contentHash => {
    const chunk = this.chunks.get(contentHash);
    return chunk ? [{
      chunkVersionId: chunk.id,
      contentHash,
      content: chunk.content,
      contentCodePoints: chunk.contentCodePoints,
      embeddingAvailable: chunk.embedded,
    }] : [];
  }));

  readonly storeChunkVersion = jest.fn(async (input: {
    contentHash: string;
    content: string;
    contentCodePoints: number;
  }) => {
    const existing = this.chunks.get(input.contentHash);
    if (existing) {
      return { id: existing.id, reused: true };
    }
    const id = randomUUID();
    this.chunks.set(input.contentHash, {
      id,
      content: input.content,
      contentCodePoints: input.contentCodePoints,
      embedded: false,
    });
    return { id, reused: false };
  });

  readonly storeEmbedding = jest.fn(async (input: {
    chunkVersionId: string;
    embeddingModel: string;
    embeddingVersion: number;
    embedding: readonly number[];
  }) => {
    const chunk = [...this.chunks.values()].find(item => item.id === input.chunkVersionId)!;
    chunk.embedded = true;
    return {
      chunkVersionId: input.chunkVersionId,
      embeddingModel: input.embeddingModel,
      embeddingVersion: input.embeddingVersion,
      embeddingDimension: input.embedding.length,
      embeddingNorm: Math.hypot(...input.embedding),
      reused: false,
    };
  });

  readonly storePageVersion = jest.fn(async (input: {
    pageId: string;
    contentHash: string;
  }) => {
    const key = `${input.pageId}:${input.contentHash}`;
    const existing = this.pages.get(key);
    if (existing) {
      return { id: existing.id, reused: true };
    }
    const stored = { id: randomUUID(), contentHash: input.contentHash };
    this.pages.set(key, stored);
    return { id: stored.id, reused: false };
  });

  readonly activateShardSnapshot = jest.fn(async (
    input: ActivateBackstageNotionShardSnapshotInput
  ) => {
    this.shardActivationInputs.push(input);
    const head = this.heads.get(input.shardKey)!;
    if (
      head.headGeneration !== Number(input.expectedHead.headGeneration)
      || head.snapshotGeneration !== Number(input.expectedHead.snapshotGeneration)
      || head.activeSnapshotId !== input.expectedHead.activeSnapshotId
      || head.partitionVersionId !== input.expectedHead.currentPartitionVersionId
    ) {
      throw new BackstageNotionPartitionRepositoryError(
        'BACKSTAGE_NOTION_PARTITION_STALE_HEAD'
      );
    }
    head.partitionVersionId = input.partitionVersionId;
    head.rootPageId = input.rootPageId;
    head.activeSnapshotId = input.snapshotId;
    head.headGeneration += 1;
    head.snapshotGeneration += 1;
    head.verifiedAt = new Date(Math.max(...input.verifications
      .filter(item => item.kind !== 'capture')
      .map(item => new Date(item.verifiedAt).getTime())));
    head.sourceManifestHash = input.sourceManifestHash;
    head.embeddingModel = input.embeddingModel;
    head.embeddingVersion = input.embeddingVersion;
    head.embeddingDimension = 1;
    head.indexFormatVersion = input.indexFormatVersion;
    return {
      snapshotId: input.snapshotId,
      universeId: input.universeId,
      shardKey: input.shardKey,
      partitionVersionId: input.partitionVersionId,
      pageCount: input.pages.length,
      chunkCount: input.occurrences.length,
      verifiedAt: head.verifiedAt,
      headGeneration: String(head.headGeneration),
      snapshotGeneration: String(head.snapshotGeneration),
    };
  });

  readonly activateUniverseManifest = jest.fn(async (
    input: ActivateBackstageNotionUniverseManifestInput
  ) => {
    expect(this.shardLeases.size).toBe(0);
    this.manifestActivationInputs.push(input);
    if (this.failFirstManifestCas) {
      this.failFirstManifestCas = false;
      throw new BackstageNotionPartitionRepositoryError(
        'BACKSTAGE_NOTION_PARTITION_STALE_HEAD'
      );
    }
    if (this.failManifestOwnership) {
      throw new BackstageNotionPartitionRepositoryError(
        'BACKSTAGE_NOTION_PARTITION_OWNERSHIP_CONFLICT'
      );
    }
    this.activeManifestId = input.manifestId;
    this.universeHeadGeneration += 1;
    this.manifestGeneration += 1;
    this.immutableManifestIds.push(input.manifestId);
    const ownershipOmissions = input.members
      .filter(member => this.ownershipOmittedShardKeys.has(member.shardKey))
      .map(member => ({
        shardKey: member.shardKey,
        safeReasonCode: 'SHARD_OWNERSHIP_CONFLICT',
      }));
    const effectiveMembers = input.members.filter(
      member => !this.ownershipOmittedShardKeys.has(member.shardKey)
    );
    const effectiveOmissions = [
      ...input.omissions.map(omission => ({
        shardKey: omission.shardKey,
        safeReasonCode: omission.safeReasonCode,
      })),
      ...ownershipOmissions,
    ];
    return {
      manifestId: input.manifestId,
      universeId: input.universeId,
      configurationVersionId: input.configurationVersionId,
      memberCount: effectiveMembers.length,
      omissionCount: effectiveOmissions.length,
      omissions: Object.freeze(effectiveOmissions.map(omission => Object.freeze(omission))),
      pageCount: effectiveMembers.length,
      chunkCount: effectiveMembers.length,
      headGeneration: String(this.universeHeadGeneration),
      manifestGeneration: String(this.manifestGeneration),
    };
  });

  seedLastKnownGood(definition: BackstageNotionPartitionDefinition): string {
    this.definitions.set(definition.shardKey, definition);
    const snapshotId = randomUUID();
    this.heads.set(definition.shardKey, {
      partitionVersionId: this.partitionVersionId(definition),
      rootPageId: definition.rootPageId,
      headGeneration: 2,
      snapshotGeneration: 1,
      activeSnapshotId: snapshotId,
      verifiedAt: new Date('2026-08-24T15:50:00.000Z'),
      sourceManifestHash: 'a'.repeat(64),
      embeddingModel: 'embedding-test-v1',
      embeddingVersion: 1,
      embeddingDimension: 1,
      indexFormatVersion: 1,
    });
    return snapshotId;
  }

  setLastKnownGoodIndexForTest(shardKey: string, embeddingModel: string): void {
    const head = this.heads.get(shardKey);
    if (!head?.activeSnapshotId) {
      throw new Error('A last-known-good snapshot must be seeded first.');
    }
    head.embeddingModel = embeddingModel;
  }

  rotateForTest(next: BackstageNotionPartitionDefinition): void {
    const oldManifest = randomUUID();
    this.immutableManifestIds.push(oldManifest);
    this.definitions.set(next.shardKey, next);
  }

  private partitionVersionId(value: BackstageNotionPartitionDefinition): string {
    const digest = hash(JSON.stringify({
      shardKey: value.shardKey,
      rootPageId: value.rootPageId,
      displayName: value.displayName,
      retrievalTier: value.retrievalTier,
      required: value.required,
      capacity: value.capacity,
    }));
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  }

  private universeExpectation(): BackstageNotionUniverseHeadExpectation {
    return {
      headGeneration: String(this.universeHeadGeneration),
      manifestGeneration: String(this.manifestGeneration),
      desiredConfigurationVersionId: this.configurationVersionId,
      activeManifestId: this.activeManifestId,
    };
  }

  private state(): BackstageNotionPartitionSynchronizationState {
    return {
      universeId: 'my-universe-2k26',
      configurationVersionId: this.configurationVersionId,
      configurationGeneration: this.configurationGeneration,
      configurationHash: this.configurationHash,
      expectedUniverseHead: this.universeExpectation(),
      shards: [...this.definitions.values()].sort((left, right) =>
        left.shardKey.localeCompare(right.shardKey)
      ).map(definition => {
        const head = this.heads.get(definition.shardKey)!;
        const expectedHead: BackstageNotionPartitionHeadExpectation = {
          headGeneration: String(head.headGeneration),
          snapshotGeneration: String(head.snapshotGeneration),
          currentPartitionVersionId: head.partitionVersionId,
          activeSnapshotId: head.activeSnapshotId,
        };
        return {
          shardKey: definition.shardKey,
          partitionVersionId: this.partitionVersionId(definition),
          rootPageId: definition.rootPageId,
          expectedHead,
          activeSnapshot: head.activeSnapshotId && head.verifiedAt && head.sourceManifestHash
            ? {
                snapshotId: head.activeSnapshotId,
                partitionVersionId: head.partitionVersionId,
                sourceManifestHash: head.sourceManifestHash,
                embeddingModel: head.embeddingModel!,
                embeddingVersion: head.embeddingVersion!,
                embeddingDimension: head.embeddingDimension!,
                indexFormatVersion: head.indexFormatVersion!,
                verifiedAt: head.verifiedAt,
              }
            : null,
        };
      }),
    };
  }
}

function dependencies(
  repository: FakePartitionRepository,
  overrides: Partial<BackstageNotionPartitionSyncDependencies> = {}
): BackstageNotionPartitionSyncDependencies {
  return {
    repository: repository as unknown as BackstageNotionPartitionSyncRepository,
    embeddingModel: 'embedding-test-v1',
    embeddingDimension: 1,
    embedBatch: async inputs => inputs.map(() => [1]),
    captureFullHierarchy: async ({ definition }) => fullCapture(definition),
    verifyFullHierarchy: async ({ captured }) => secondPass(captured),
    now: () => NOW,
    concurrency: 2,
    providerPollMs: 1,
    ...overrides,
  };
}

function captureEnvironment(name: string): string | undefined {
  return name === 'ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN'
    ? 'ntn_partition_test_token_123456789'
    : undefined;
}

function directProviderPermit() {
  const runNotionRequest = jest.fn(async (
    operation: (signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal
  ) => operation(signal));
  return {
    permit: { runNotionRequest } as unknown as BackstageNotionPartitionProviderPermit,
    runNotionRequest,
  };
}

describe('partition production capture adapter', () => {
  const fetchImpl: BackstageNotionFetchImplementation = async () => {
    throw new Error('The injected provider reader should be used.');
  };

  test('captures a bounded hierarchy and verifies every page through six permits', async () => {
    const definition = shard(1);
    const childPageId = uuidFor(41);
    const metadataByPage = new Map<string, BackstageNotionPageMetadata>([
      [definition.rootPageId, {
        pageId: definition.rootPageId,
        parentPageId: EXTERNAL_PARENT_ID,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }],
      [childPageId, {
        pageId: childPageId,
        parentPageId: definition.rootPageId,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }],
    ]);
    const fetchPageMetadata = jest.fn(async (
      _fetch: BackstageNotionFetchImplementation,
      _token: string,
      pageId: string,
      _signal: AbortSignal
    ): Promise<BackstageNotionPageMetadata> => metadataByPage.get(pageId)!);
    const fetchMarkdownPage = jest.fn(async (
      _fetch: BackstageNotionFetchImplementation,
      _token: string,
      pageId: string,
      _signal: AbortSignal
    ): Promise<BackstageNotionMarkdownResponse> => ({
      markdown: pageId === definition.rootPageId
        ? `# Root\n\n<page id="${childPageId}">Child lane</page>`
        : '# Child\n\nCurrent canon.',
      truncated: false,
      unknownBlockCount: 0,
    }));
    const adapter = createBackstageNotionPartitionProviderCaptureDependencies({
      readEnvironment: captureEnvironment,
      fetchImpl,
      fetchPageMetadata,
      fetchMarkdownPage,
      now: () => NOW,
      wait: async () => undefined,
    });
    const { permit, runNotionRequest } = directProviderPermit();
    const signal = new AbortController().signal;

    const captured = await adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal,
    });
    const verified = await adapter.verifyFullHierarchy({
      definition,
      captured,
      provider: permit,
      signal,
    });

    expect(captured).toMatchObject({
      captureMode: 'full_hierarchy_content_scan',
      completeness: {
        truncatedPageCount: 0,
        unsupportedBlockCount: 0,
        ambiguousChildReferenceCount: 0,
      },
    });
    expect(captured.pages.map(item => ({
      pageId: item.page.pageId,
      parentPageId: item.page.parentPageId,
      path: item.page.path,
    }))).toEqual([{
      pageId: definition.rootPageId,
      parentPageId: null,
      path: [definition.displayName],
    }, {
      pageId: childPageId,
      parentPageId: definition.rootPageId,
      path: [definition.displayName, 'Child lane'],
    }]);
    expect(verified.verificationMode).toBe('full_metadata_second_pass');
    expect(verified.pages).toHaveLength(2);
    expect(runNotionRequest).toHaveBeenCalledTimes(6);
  });

  test.each([
    ['truncated', { markdown: '# root', truncated: true, unknownBlockCount: 0 }],
    ['unknown', { markdown: '# root', truncated: false, unknownBlockCount: 1 }],
    ['unsupported', {
      markdown: '<database url="https://example.invalid" />',
      truncated: false,
      unknownBlockCount: 0,
    }],
    ['ambiguous child', {
      markdown: '<page id="not-a-page">Broken</page>',
      truncated: false,
      unknownBlockCount: 0,
    }],
  ] as const)('rejects %s provider content before material work', async (_label, markdown) => {
    const definition = shard(1);
    const adapter = createBackstageNotionPartitionProviderCaptureDependencies({
      readEnvironment: captureEnvironment,
      fetchImpl,
      fetchPageMetadata: async () => ({
        pageId: definition.rootPageId,
        parentPageId: EXTERNAL_PARENT_ID,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }),
      fetchMarkdownPage: async () => markdown,
      wait: async () => undefined,
    });
    const { permit } = directProviderPermit();
    await expect(adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
    });
  });

  test('releases the permit between transient retry attempts and never retries a 400', async () => {
    const definition = shard(1);
    let metadataAttempts = 0;
    const fetchPageMetadata = jest.fn(async (): Promise<BackstageNotionPageMetadata> => {
      metadataAttempts += 1;
      if (metadataAttempts === 1) {
        throw new BackstageNotionReadError('http_429');
      }
      return {
        pageId: definition.rootPageId,
        parentPageId: EXTERNAL_PARENT_ID,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      };
    });
    const adapter = createBackstageNotionPartitionProviderCaptureDependencies({
      readEnvironment: captureEnvironment,
      fetchImpl,
      fetchPageMetadata,
      fetchMarkdownPage: async () => ({
        markdown: '# Root',
        truncated: false,
        unknownBlockCount: 0,
      }),
      retryBaseDelayMs: 0,
      wait: async () => undefined,
    });
    const { permit, runNotionRequest } = directProviderPermit();
    await expect(adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ pages: [{ page: { pageId: definition.rootPageId } }] });
    expect(runNotionRequest).toHaveBeenCalledTimes(3);

    fetchPageMetadata.mockRejectedValueOnce(new BackstageNotionReadError('http_400'));
    const beforeTerminal = runNotionRequest.mock.calls.length;
    await expect(adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(BackstageNotionReadError);
    expect(runNotionRequest.mock.calls.length - beforeTerminal).toBe(1);
  });

  test('rejects a child reference that cycles back to the configured root', async () => {
    const definition = shard(1);
    const childPageId = uuidFor(42);
    const metadataByPage = new Map<string, BackstageNotionPageMetadata>([
      [definition.rootPageId, {
        pageId: definition.rootPageId,
        parentPageId: EXTERNAL_PARENT_ID,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }],
      [childPageId, {
        pageId: childPageId,
        parentPageId: definition.rootPageId,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }],
    ]);
    const adapter = createBackstageNotionPartitionProviderCaptureDependencies({
      readEnvironment: captureEnvironment,
      fetchImpl,
      fetchPageMetadata: async (_fetch, _token, pageId) => metadataByPage.get(pageId)!,
      fetchMarkdownPage: async (_fetch, _token, pageId) => ({
        markdown: pageId === definition.rootPageId
          ? `<page id="${childPageId}">Child lane</page>`
          : `<page id="${definition.rootPageId}">Root lane</page>`,
        truncated: false,
        unknownBlockCount: 0,
      }),
      wait: async () => undefined,
    });
    const { permit } = directProviderPermit();

    await expect(adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
    });
  });

  test('rejects one discovered page referenced by two different parents', async () => {
    const definition = shard(1);
    const firstParentPageId = uuidFor(43);
    const secondParentPageId = uuidFor(44);
    const duplicatedChildPageId = uuidFor(45);
    const metadataByPage = new Map<string, BackstageNotionPageMetadata>([
      [definition.rootPageId, {
        pageId: definition.rootPageId,
        parentPageId: EXTERNAL_PARENT_ID,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }],
      [firstParentPageId, {
        pageId: firstParentPageId,
        parentPageId: definition.rootPageId,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }],
      [secondParentPageId, {
        pageId: secondParentPageId,
        parentPageId: definition.rootPageId,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }],
    ]);
    const markdownByPage = new Map<string, string>([
      [definition.rootPageId, [
        `<page id="${firstParentPageId}">First parent</page>`,
        `<page id="${secondParentPageId}">Second parent</page>`,
      ].join('\n')],
      [firstParentPageId, `<page id="${duplicatedChildPageId}">Shared child</page>`],
      [secondParentPageId, `<page id="${duplicatedChildPageId}">Shared child</page>`],
    ]);
    const fetchPageMetadata = jest.fn(async (
      _fetch: BackstageNotionFetchImplementation,
      _token: string,
      pageId: string
    ): Promise<BackstageNotionPageMetadata> => metadataByPage.get(pageId)!);
    const adapter = createBackstageNotionPartitionProviderCaptureDependencies({
      readEnvironment: captureEnvironment,
      fetchImpl,
      fetchPageMetadata,
      fetchMarkdownPage: async (_fetch, _token, pageId) => ({
        markdown: markdownByPage.get(pageId) ?? '# Unexpected child fetch',
        truncated: false,
        unknownBlockCount: 0,
      }),
      wait: async () => undefined,
    });
    const { permit } = directProviderPermit();

    await expect(adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPTURE_INCOMPLETE',
    });
    expect(fetchPageMetadata).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      duplicatedChildPageId,
      expect.anything()
    );
  });

  test('rejects maxPages overflow before fetching the discovered child', async () => {
    const definition = shard(1, { capacity: { maxPages: 1 } });
    const childPageId = uuidFor(46);
    const fetchPageMetadata = jest.fn(async (
      _fetch: BackstageNotionFetchImplementation,
      _token: string,
      pageId: string
    ): Promise<BackstageNotionPageMetadata> => ({
      pageId,
      parentPageId: pageId === definition.rootPageId
        ? EXTERNAL_PARENT_ID
        : definition.rootPageId,
      lastEditedAt: EDITED_AT,
      inTrash: false,
    }));
    const adapter = createBackstageNotionPartitionProviderCaptureDependencies({
      readEnvironment: captureEnvironment,
      fetchImpl,
      fetchPageMetadata,
      fetchMarkdownPage: async () => ({
        markdown: `<page id="${childPageId}">Capacity child</page>`,
        truncated: false,
        unknownBlockCount: 0,
      }),
      wait: async () => undefined,
    });
    const { permit } = directProviderPermit();

    await expect(adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
    });
    expect(fetchPageMetadata).toHaveBeenCalledTimes(1);
  });

  test('rejects maxDepth overflow before fetching the discovered child', async () => {
    const definition = shard(1, { capacity: { maxDepth: 0 } });
    const childPageId = uuidFor(47);
    const fetchPageMetadata = jest.fn(async (
      _fetch: BackstageNotionFetchImplementation,
      _token: string,
      pageId: string
    ): Promise<BackstageNotionPageMetadata> => ({
      pageId,
      parentPageId: pageId === definition.rootPageId
        ? EXTERNAL_PARENT_ID
        : definition.rootPageId,
      lastEditedAt: EDITED_AT,
      inTrash: false,
    }));
    const adapter = createBackstageNotionPartitionProviderCaptureDependencies({
      readEnvironment: captureEnvironment,
      fetchImpl,
      fetchPageMetadata,
      fetchMarkdownPage: async () => ({
        markdown: `<page id="${childPageId}">Depth child</page>`,
        truncated: false,
        unknownBlockCount: 0,
      }),
      wait: async () => undefined,
    });
    const { permit } = directProviderPermit();

    await expect(adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
    });
    expect(fetchPageMetadata).toHaveBeenCalledTimes(1);
  });

  test('rejects total sanitized content overflow within the shard capacity', async () => {
    const definition = shard(1, { capacity: { maxContentCodePoints: 5 } });
    const adapter = createBackstageNotionPartitionProviderCaptureDependencies({
      readEnvironment: captureEnvironment,
      fetchImpl,
      fetchPageMetadata: async () => ({
        pageId: definition.rootPageId,
        parentPageId: EXTERNAL_PARENT_ID,
        lastEditedAt: EDITED_AT,
        inTrash: false,
      }),
      fetchMarkdownPage: async () => ({
        markdown: '123456',
        truncated: false,
        unknownBlockCount: 0,
      }),
      wait: async () => undefined,
    });
    const { permit } = directProviderPermit();

    await expect(adapter.captureFullHierarchy({
      definition,
      provider: permit,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_PARTITION_SYNC_CAPACITY_EXCEEDED',
    });
  });

  test('rejects a forged middle scope ancestor before any material lookup', async () => {
    const definition = shard(1, { required: false });
    const middlePageId = uuidFor(48);
    const leafPageId = uuidFor(49);
    const root = inspectBackstageNotionRagPage({
      universeId: definition.universeId,
      pageId: definition.rootPageId,
      parentPageId: null,
      title: definition.displayName,
      path: [definition.displayName],
      markdown: '# Root',
      sourceLastEditedAt: EDITED_AT.toISOString(),
    });
    const middle = inspectBackstageNotionRagPage({
      universeId: definition.universeId,
      pageId: middlePageId,
      parentPageId: definition.rootPageId,
      title: 'Middle lane',
      path: [definition.displayName, 'Middle lane'],
      markdown: '# Middle',
      sourceLastEditedAt: EDITED_AT.toISOString(),
    });
    const leaf = inspectBackstageNotionRagPage({
      universeId: definition.universeId,
      pageId: leafPageId,
      parentPageId: middlePageId,
      title: 'Leaf lane',
      path: [definition.displayName, 'Forged lane', 'Leaf lane'],
      markdown: '# Leaf',
      sourceLastEditedAt: EDITED_AT.toISOString(),
    });
    const captured: BackstageNotionPartitionFullCapture = {
      captureMode: 'full_hierarchy_content_scan',
      pages: [
        {
          page: root,
          metadata: {
            pageId: root.pageId,
            parentPageId: EXTERNAL_PARENT_ID,
            inTrash: false,
            lastEditedAt: EDITED_AT,
          },
        },
        {
          page: middle,
          metadata: {
            pageId: middle.pageId,
            parentPageId: definition.rootPageId,
            inTrash: false,
            lastEditedAt: EDITED_AT,
          },
        },
        {
          page: leaf,
          metadata: {
            pageId: leaf.pageId,
            parentPageId: middlePageId,
            inTrash: false,
            lastEditedAt: EDITED_AT,
          },
        },
      ],
      completeness: {
        truncatedPageCount: 0,
        unsupportedBlockCount: 0,
        ambiguousChildReferenceCount: 0,
      },
      capturedAt: new Date('2026-08-24T15:30:00.000Z'),
    };
    const repository = new FakePartitionRepository();

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([definition]),
      dependencies(repository, {
        captureFullHierarchy: async () => captured,
      })
    );

    expect(result.universes[0]!.shardResults[0]).toMatchObject({
      status: 'failed',
      safeReasonCode: 'SHARD_CAPTURE_INCOMPLETE',
    });
    expect(repository.findReusablePageMaterial).not.toHaveBeenCalled();
    expect(repository.shardActivationInputs).toHaveLength(0);
  });
});

describe('partition synchronization policy', () => {
  test('orders full reconciliations hot, cold, archive with stable shard ordering', () => {
    const jobs = planBackstageNotionPartitionFullReconciliation([{
      universeId: 'my-universe-2k26',
      shards: [
        shard(3, { retrievalTier: 'archive', shardKey: 'archive' }),
        shard(2, { retrievalTier: 'hot', shardKey: 'hot-b' }),
        shard(1, { retrievalTier: 'hot', shardKey: 'hot-a' }),
        shard(4, { retrievalTier: 'cold', shardKey: 'cold' }),
      ],
    }]);
    expect(jobs.map(job => job.shardKey)).toEqual([
      'hot-a',
      'hot-b',
      'cold',
      'archive',
    ]);
  });

  test('retains only a fresh last-known-good from the exact desired partition version', () => {
    const definition = shard(1);
    const base = {
      definition,
      partitionVersionId: uuidFor(100),
      attempt: {
        shardKey: definition.shardKey,
        status: 'failed' as const,
        safeReasonCode: 'SHARD_SYNC_FAILED' as const,
        freshSnapshotId: null,
      },
      expectedIndex: {
        embeddingModel: 'embedding-test-v1',
        embeddingVersion: 1,
        embeddingDimension: 1,
        indexFormatVersion: 1,
      },
      now: NOW,
      lastKnownGoodMaximumAgeMs: 60 * 60 * 1_000,
    };
    expect(decideBackstageNotionPartitionManifestMembership({
      ...base,
      terminalActiveSnapshot: {
        snapshotId: uuidFor(101),
        partitionVersionId: uuidFor(100),
        embeddingModel: 'embedding-test-v1',
        embeddingVersion: 1,
        embeddingDimension: 1,
        indexFormatVersion: 1,
        verifiedAt: new Date(NOW.getTime() - 1_000),
      },
    }).kind).toBe('retained_last_known_good');
    expect(decideBackstageNotionPartitionManifestMembership({
      ...base,
      terminalActiveSnapshot: {
        snapshotId: uuidFor(102),
        partitionVersionId: uuidFor(999),
        embeddingModel: 'embedding-test-v1',
        embeddingVersion: 1,
        embeddingDimension: 1,
        indexFormatVersion: 1,
        verifiedAt: new Date(NOW.getTime() - 1_000),
      },
    }).kind).toBe('required_unavailable');
  });
});

describe('partition synchronization orchestration', () => {
  jest.setTimeout(30_000);

  test('scopes configured-root overlap validation to one universe', () => {
    const universeA = shard(1, { universeId: 'universe-a', shardKey: 'current-a' });
    const universeB = shard(2, { universeId: 'universe-b', shardKey: 'current-b' });
    const foreignRootTitle = 'Universe B Root';
    const rootPage = inspectBackstageNotionRagPage({
      universeId: universeA.universeId,
      pageId: universeA.rootPageId,
      parentPageId: null,
      title: universeA.displayName,
      path: [universeA.displayName],
      markdown: `<page id="${universeB.rootPageId}">${foreignRootTitle}</page>`,
      sourceLastEditedAt: EDITED_AT.toISOString(),
    });
    const foreignRootPage = inspectBackstageNotionRagPage({
      universeId: universeA.universeId,
      pageId: universeB.rootPageId,
      parentPageId: universeA.rootPageId,
      title: foreignRootTitle,
      path: [universeA.displayName, foreignRootTitle],
      markdown: 'Authority content.',
      sourceLastEditedAt: EDITED_AT.toISOString(),
    });
    const capture: BackstageNotionPartitionFullCapture = {
      captureMode: 'full_hierarchy_content_scan',
      pages: [{
        page: rootPage,
        metadata: {
          pageId: rootPage.pageId,
          parentPageId: EXTERNAL_PARENT_ID,
          inTrash: false,
          lastEditedAt: EDITED_AT,
        },
      }, {
        page: foreignRootPage,
        metadata: {
          pageId: foreignRootPage.pageId,
          parentPageId: universeA.rootPageId,
          inTrash: false,
          lastEditedAt: EDITED_AT,
        },
      }],
      completeness: {
        truncatedPageCount: 0,
        unsupportedBlockCount: 0,
        ambiguousChildReferenceCount: 0,
      },
      capturedAt: NOW,
    };
    const rootsByUniverse = groupBackstageNotionPartitionRootPageIdsByUniverse([{
      universeId: universeA.universeId,
      shards: [universeA],
    }, {
      universeId: universeB.universeId,
      shards: [universeB],
    }]);

    expect(rootsByUniverse.get(universeA.universeId)?.has(universeB.rootPageId))
      .toBe(false);
    expect(validateBackstageNotionPartitionCapture({
      definition: universeA,
      capture,
      configuredRootPageIds: rootsByUniverse.get(universeA.universeId)!,
    }).get(universeB.rootPageId)).toEqual([
      universeA.rootPageId,
      universeB.rootPageId,
    ]);
  });

  test('permits the same provider root identity in distinct universe namespaces', () => {
    const sharedRootPageId = uuidFor(70);
    const parsed = parseBackstageNotionPartitionConfiguration(JSON.stringify({
      version: 1,
      generation: 'cross-universe-roots-1',
      universes: ['universe-a', 'universe-b'].map((universeId, index) => ({
        universeId,
        shards: [{
          shardKey: `current-${index}`,
          rootPageId: sharedRootPageId,
          displayName: `Universe ${index}`,
          retrievalTier: 'hot',
          required: true,
          scopeTags: [],
          categoryTags: [],
          capacity: {
            maxPages: 10,
            maxChunks: 100,
            maxDepth: 4,
            maxContentCodePoints: 10_000,
          },
        }],
      })),
    }));

    expect(parsed.status).toBe('valid');
  });

  test('activates more than 2,048 aggregate chunks when every shard is independently bounded', async () => {
    const definitions = [shard(1), shard(2), shard(3)];
    const markdownByShard = new Map(definitions.map(definition => [
      definition.shardKey,
      Array.from({ length: 700 }, (_, index) =>
        `${definition.shardKey}-${index} ${'x'.repeat(1_650)}`
      ).join('\n\n'),
    ]));
    const repository = new FakePartitionRepository();
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration(definitions),
      dependencies(repository, {
        captureFullHierarchy: async ({ definition }) => fullCapture(
          definition,
          markdownByShard.get(definition.shardKey)
        ),
        concurrency: 3,
      })
    );
    const chunks = result.universes[0]!.shardResults.map(item => item.chunkCount);
    expect(chunks.every(count => count <= 2_048)).toBe(true);
    expect(chunks.reduce((total, count) => total + count, 0)).toBeGreaterThan(2_048);
    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'published',
      memberCount: 3,
      omissionCount: 0,
    });
  });

  test('synchronizes only the selected shard and retains an exact required LKG', async () => {
    const selected = shard(1, { shardKey: 'current' });
    const untouched = shard(2, { shardKey: 'shared' });
    const repository = new FakePartitionRepository();
    const retainedSnapshotId = repository.seedLastKnownGood(untouched);
    const captureFullHierarchy = jest.fn(async ({ definition }: {
      definition: BackstageNotionPartitionDefinition;
    }) => fullCapture(definition));

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([selected, untouched]),
      dependencies(repository, {
        selection: {
          universeId: selected.universeId,
          shardKey: selected.shardKey,
        },
        captureFullHierarchy,
      })
    );

    expect(result.kind).toBe('targeted_reconciliation');
    expect(captureFullHierarchy).toHaveBeenCalledTimes(1);
    expect(captureFullHierarchy.mock.calls[0]?.[0].definition.shardKey)
      .toBe(selected.shardKey);
    expect(result.universes[0]!.shardResults).toEqual([
      expect.objectContaining({ shardKey: 'current', status: 'fresh' }),
      expect.objectContaining({
        shardKey: 'shared',
        status: 'not-requested',
        safeReasonCode: 'SHARD_NOT_REQUESTED',
      }),
    ]);
    expect(repository.manifestActivationInputs[0]!.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shardKey: 'shared',
          snapshotId: retainedSnapshotId,
          decision: 'retained_last_known_good',
        }),
      ])
    );
  });

  test('blocks targeted publication when an untouched required shard has no LKG', async () => {
    const selected = shard(1, { shardKey: 'current' });
    const unavailable = shard(2, { shardKey: 'shared' });
    const repository = new FakePartitionRepository();

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([selected, unavailable]),
      dependencies(repository, {
        selection: {
          universeId: selected.universeId,
          shardKey: selected.shardKey,
        },
      })
    );

    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'blocked',
      manifestId: null,
    });
    expect(repository.acquireShardLease).toHaveBeenCalledTimes(1);
    expect(repository.acquireShardLease.mock.calls[0]?.[1]).toBe('current');
    expect(repository.manifestActivationInputs).toHaveLength(0);
  });

  test('honestly omits an untouched optional shard with no LKG', async () => {
    const selected = shard(1, { shardKey: 'current' });
    const optional = shard(2, { shardKey: 'archive', required: false });
    const repository = new FakePartitionRepository();

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([selected, optional]),
      dependencies(repository, {
        selection: {
          universeId: selected.universeId,
          shardKey: selected.shardKey,
        },
      })
    );

    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'published',
      memberCount: 1,
      omissionCount: 1,
    });
    expect(repository.manifestActivationInputs[0]!.omissions).toEqual([
      expect.objectContaining({
        shardKey: 'archive',
        safeReasonCode: 'SHARD_NOT_REQUESTED',
      }),
    ]);
  });

  test('returns the exact ownership omission for a targeted optional shard', async () => {
    const required = shard(1, { shardKey: 'current' });
    const selected = shard(2, { shardKey: 'archive', required: false });
    const repository = new FakePartitionRepository();
    repository.seedLastKnownGood(required);
    repository.ownershipOmittedShardKeys.add(selected.shardKey);

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([required, selected]),
      dependencies(repository, {
        selection: {
          universeId: selected.universeId,
          shardKey: selected.shardKey,
        },
      })
    );

    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'published',
      memberCount: 1,
      omissionCount: 1,
      manifestOmissions: [{
        shardKey: selected.shardKey,
        safeReasonCode: 'SHARD_OWNERSHIP_CONFLICT',
      }],
    });
    expect(result.universes[0]!.shardResults.find(
      shardResult => shardResult.shardKey === selected.shardKey
    )).toMatchObject({
      status: 'fresh',
      fullSourceScan: true,
    });
  });

  test('isolates an unsupported optional archive while activating required hot canon', async () => {
    const hot = shard(1, { shardKey: 'current', retrievalTier: 'hot' });
    const archive = shard(2, {
      shardKey: 'archive',
      retrievalTier: 'archive',
      required: false,
    });
    const repository = new FakePartitionRepository();
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([archive, hot]),
      dependencies(repository, {
        captureFullHierarchy: async ({ definition }) => definition.shardKey === 'archive'
          ? fullCapture(definition, 'archive', { unsupportedBlockCount: 1 })
          : fullCapture(definition),
      })
    );
    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'published',
      memberCount: 1,
      omissionCount: 1,
    });
    expect(result.universes[0]!.shardResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ shardKey: 'current', status: 'fresh' }),
      expect.objectContaining({
        shardKey: 'archive',
        status: 'failed',
        safeReasonCode: 'SHARD_CAPTURE_INCOMPLETE',
      }),
    ]));
  });

  test('classifies unresolved required ownership ambiguity as a blocked manifest', async () => {
    const required = shard(1, { shardKey: 'current' });
    const repository = new FakePartitionRepository();
    repository.failManifestOwnership = true;

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([required]),
      dependencies(repository)
    );

    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'blocked',
      manifestId: null,
      memberCount: 0,
      omissionCount: 0,
    });
  });

  test('isolates an oversized optional archive at its per-shard chunk bound', async () => {
    const hot = shard(1, { shardKey: 'current' });
    const archive = shard(2, {
      shardKey: 'archive',
      retrievalTier: 'archive',
      required: false,
      capacity: { maxChunks: 1 },
    });
    const repository = new FakePartitionRepository();
    const embedBatch = jest.fn(async (inputs: readonly string[]) =>
      inputs.map(() => [1] as const)
    );
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([archive, hot]),
      dependencies(repository, {
        embedBatch,
        concurrency: 1,
        captureFullHierarchy: async ({ definition }) => fullCapture(
          definition,
          definition.shardKey === 'archive'
            ? `${'a'.repeat(1_700)}\n\n${'b'.repeat(1_700)}`
            : 'Current canon.'
        ),
      })
    );
    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'published',
      memberCount: 1,
      omissionCount: 1,
    });
    expect(result.universes[0]!.shardResults.find(item =>
      item.shardKey === 'archive'
    )).toMatchObject({
      status: 'failed',
      safeReasonCode: 'SHARD_CAPACITY_EXCEEDED',
      fullSourceScan: true,
    });
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch.mock.calls[0]?.[0]).toHaveLength(1);
  });

  test.each([
    ['page id', (metadata: BackstageNotionPartitionCapturedPageMetadata) => ({
      ...metadata,
      pageId: uuidFor(800),
    })],
    ['parent', (metadata: BackstageNotionPartitionCapturedPageMetadata) => ({
      ...metadata,
      parentPageId: uuidFor(801),
    })],
    ['trash', (metadata: BackstageNotionPartitionCapturedPageMetadata) => ({
      ...metadata,
      inTrash: true,
    })],
    ['last edited', (metadata: BackstageNotionPartitionCapturedPageMetadata) => ({
      ...metadata,
      lastEditedAt: new Date(metadata.lastEditedAt.getTime() + 1),
    })],
  ] as const)('rejects %s drift during the metadata second pass', async (_label, mutate) => {
    const optional = shard(1, { required: false });
    const repository = new FakePartitionRepository();
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([optional]),
      dependencies(repository, {
        verifyFullHierarchy: async ({ captured }) => secondPass(captured, mutate),
      })
    );
    expect(result.universes[0]!.shardResults[0]).toMatchObject({
      status: 'failed',
      safeReasonCode: 'SHARD_SOURCE_DRIFT',
      fullSourceScan: true,
    });
    expect(repository.shardActivationInputs).toHaveLength(0);
  });

  test('retains full-scan evidence when snapshot activation fails', async () => {
    const optional = shard(1, { required: false });
    const repository = new FakePartitionRepository();
    repository.activateShardSnapshot.mockRejectedValueOnce(
      new BackstageNotionPartitionRepositoryError(
        'BACKSTAGE_NOTION_PARTITION_STALE_HEAD'
      )
    );

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([optional]),
      dependencies(repository)
    );

    expect(result.universes[0]!.shardResults[0]).toMatchObject({
      status: 'failed',
      safeReasonCode: 'SHARD_SYNC_FAILED',
      fullSourceScan: true,
    });
  });

  test('serializes sibling Notion calls through process and database provider permits', async () => {
    const definitions = [shard(1), shard(2)];
    const repository = new FakePartitionRepository();
    let activeNotionOperations = 0;
    let maximumNotionOperations = 0;
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration(definitions),
      dependencies(repository, {
        captureFullHierarchy: async ({ definition, provider, signal }) => {
          await provider.runNotionRequest(async () => {
            activeNotionOperations += 1;
            maximumNotionOperations = Math.max(
              maximumNotionOperations,
              activeNotionOperations
            );
            await new Promise(resolve => setTimeout(resolve, 5));
            activeNotionOperations -= 1;
          }, signal);
          return fullCapture(definition);
        },
      })
    );
    expect(result.universes[0]!.manifestStatus).toBe('published');
    expect(maximumNotionOperations).toBe(1);
    expect(repository.maximumProviderOperations).toBe(1);
  });

  test('replaces renewed shard and provider fences before activation and release', async () => {
    const definition = shard(1);
    const repository = new FakePartitionRepository();
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([definition]),
      dependencies(repository, {
        shardLeaseTtlMs: 1_000,
        providerLeaseTtlMs: 1_000,
        captureFullHierarchy: async ({ definition: value, provider, signal }) => {
          await provider.runNotionRequest(
            () => new Promise(resolve => setTimeout(resolve, 380)),
            signal
          );
          return fullCapture(value);
        },
      })
    );
    expect(result.universes[0]!.manifestStatus).toBe('published');
    expect(repository.renewShardLease).toHaveBeenCalled();
    expect(repository.renewProviderLease).toHaveBeenCalled();
    expect(Number(repository.shardActivationInputs[0]!.lease.leaseGeneration))
      .toBeGreaterThan(1);
    const shardReleaseFence = repository.releaseShardLease.mock.calls[0]![2];
    const providerReleaseFence = repository.releaseProviderLease.mock.calls[0]![2];
    expect(Number(shardReleaseFence.leaseGeneration)).toBeGreaterThan(1);
    expect(Number(providerReleaseFence.leaseGeneration)).toBeGreaterThan(1);
  });

  test('aborts an in-flight provider request when its renewable lease is lost', async () => {
    const optional = shard(1, { required: false });
    const repository = new FakePartitionRepository();
    repository.renewProviderLease.mockImplementationOnce(async () => null);
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([optional]),
      dependencies(repository, {
        shardLeaseTtlMs: 5_000,
        providerLeaseTtlMs: 1_000,
        notionRequestDelayMs: 0,
        captureFullHierarchy: async ({ provider, signal }) => {
          await provider.runNotionRequest(providerSignal => new Promise<void>((
            _resolve,
            reject
          ) => {
            const abort = (): void => reject(new DOMException('fetch aborted', 'AbortError'));
            providerSignal.addEventListener('abort', abort, { once: true });
            if (providerSignal.aborted) {
              abort();
            }
          }), signal);
          return fullCapture(optional);
        },
      })
    );
    expect(result.universes[0]!.shardResults[0]).toMatchObject({
      status: 'failed',
      safeReasonCode: 'SHARD_LEASE_LOST',
      fullSourceScan: false,
    });
    expect(repository.shardActivationInputs).toHaveLength(0);
    expect(repository.releaseProviderLease).toHaveBeenCalledTimes(1);
    expect(repository.releaseShardLease).toHaveBeenCalledTimes(1);
  });

  test('rejects shard activation when provider lease release is unconfirmed', async () => {
    const optional = shard(1, { required: false });
    const repository = new FakePartitionRepository();
    repository.releaseProviderLease.mockImplementationOnce(async () => false);

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([optional]),
      dependencies(repository)
    );

    expect(result.universes[0]!.shardResults[0]).toMatchObject({
      status: 'failed',
      safeReasonCode: 'SHARD_LEASE_LOST',
      fullSourceScan: true,
      leaseReleaseVerified: true,
    });
    expect(repository.shardActivationInputs).toHaveLength(0);
    expect(repository.manifestActivationInputs).toHaveLength(0);
  });

  test('blocks required unavailability, retains same-version LKG, and omits optional absence', async () => {
    const required = shard(1, { shardKey: 'required' });
    const optional = shard(2, { shardKey: 'optional', required: false });
    const repository = new FakePartitionRepository();
    const lkgId = repository.seedLastKnownGood(required);
    repository.busyShardKeys.add('required');
    repository.busyShardKeys.add('optional');
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([required, optional]),
      dependencies(repository)
    );
    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'published',
      memberCount: 1,
      omissionCount: 1,
    });
    expect(repository.manifestActivationInputs[0]!.members[0]).toMatchObject({
      shardKey: 'required',
      snapshotId: lkgId,
      decision: 'retained_last_known_good',
    });
  });

  test('omits an optional incompatible LKG instead of blocking fresh hot canon', async () => {
    const hot = shard(1, { shardKey: 'hot' });
    const archive = shard(2, {
      shardKey: 'archive',
      retrievalTier: 'archive',
      required: false,
    });
    const repository = new FakePartitionRepository();
    repository.seedLastKnownGood(archive);
    repository.setLastKnownGoodIndexForTest('archive', 'embedding-old-v1');
    repository.busyShardKeys.add('archive');

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([archive, hot]),
      dependencies(repository)
    );

    expect(result.universes[0]).toMatchObject({
      manifestStatus: 'published',
      memberCount: 1,
      omissionCount: 1,
    });
    expect(repository.manifestActivationInputs[0]!.omissions[0]).toMatchObject({
      shardKey: 'archive',
      safeReasonCode: 'SHARD_INDEX_INCOMPATIBLE',
    });
  });

  test('classifies unchanged, moved, and deleted pages while reusing captured material', async () => {
    const definition = shard(1, { shardKey: 'raw' });
    const childPageId = uuidFor(61);
    const deletedPageId = uuidFor(62);
    const oldParentPageId = uuidFor(63);
    const repository = new FakePartitionRepository();
    const priorSnapshotId = repository.seedLastKnownGood(definition);
    const rootPage = inspectBackstageNotionRagPage({
      universeId: definition.universeId,
      pageId: definition.rootPageId,
      parentPageId: null,
      title: definition.displayName,
      path: [definition.displayName],
      markdown: '# Root\n\nCurrent canon.',
      sourceLastEditedAt: EDITED_AT.toISOString(),
    });
    const childPage = inspectBackstageNotionRagPage({
      universeId: definition.universeId,
      pageId: childPageId,
      parentPageId: definition.rootPageId,
      title: 'Child lane',
      path: [definition.displayName, 'Child lane'],
      markdown: '# Child\n\nSame material after move.',
      sourceLastEditedAt: EDITED_AT.toISOString(),
    });
    const captured: BackstageNotionPartitionFullCapture = {
      captureMode: 'full_hierarchy_content_scan',
      pages: [{
        page: rootPage,
        metadata: {
          pageId: rootPage.pageId,
          parentPageId: EXTERNAL_PARENT_ID,
          inTrash: false,
          lastEditedAt: EDITED_AT,
        },
      }, {
        page: childPage,
        metadata: {
          pageId: childPage.pageId,
          parentPageId: definition.rootPageId,
          inTrash: false,
          lastEditedAt: EDITED_AT,
        },
      }],
      completeness: {
        truncatedPageCount: 0,
        unsupportedBlockCount: 0,
        ambiguousChildReferenceCount: 0,
      },
      capturedAt: new Date('2026-08-24T15:30:00.000Z'),
    };
    repository.loadShardPageInventory.mockResolvedValueOnce([{
      pageId: rootPage.pageId,
      pageVersionId: uuidFor(70),
      contentHash: hash(rootPage.sanitizedMarkdown),
      parentPageId: null,
      title: rootPage.title,
      path: [rootPage.pageId],
      scopePath: rootPage.path,
    }, {
      pageId: childPage.pageId,
      pageVersionId: uuidFor(71),
      contentHash: hash(childPage.sanitizedMarkdown),
      parentPageId: oldParentPageId,
      title: childPage.title,
      path: [oldParentPageId, childPage.pageId],
      scopePath: ['Old lane', childPage.title],
    }, {
      pageId: deletedPageId,
      pageVersionId: uuidFor(72),
      contentHash: hash('Deleted material.'),
      parentPageId: definition.rootPageId,
      title: 'Deleted lane',
      path: [definition.rootPageId, deletedPageId],
      scopePath: [definition.displayName, 'Deleted lane'],
    }]);
    const reusable = new Map<string, BackstageNotionReusablePageMaterial>();
    [rootPage, childPage].forEach((page, pageIndex) => {
      const prepared = chunkBackstageNotionInspectedPage(page);
      reusable.set(`${page.pageId}:${hash(page.sanitizedMarkdown)}`, {
        pageVersionId: uuidFor(80 + pageIndex),
        pageId: page.pageId,
        contentHash: hash(page.sanitizedMarkdown),
        pageFormatVersion: 1,
        chunkerVersion: 1,
        chunks: prepared.chunks.map((chunk, chunkIndex) => ({
          ordinal: chunk.ordinal,
          chunkVersionId: uuidFor(90 + pageIndex * 10 + chunkIndex),
          contentHash: chunk.contentHash,
          content: chunk.content,
          contentCodePoints: chunk.codePoints,
          embeddingAvailable: true,
          headingPath: chunk.headingPath,
          scopeHeadingPathKey: chunk.headingPath,
          headingOccurrencePath: chunk.headingOccurrencePath,
        })),
      });
    });
    repository.findReusablePageMaterial.mockImplementation(async input =>
      reusable.get(`${input.pageId}:${input.contentHash}`) ?? null
    );
    const embedBatch = jest.fn(async (inputs: readonly string[]) =>
      inputs.map(() => [1] as const)
    );

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([definition]),
      dependencies(repository, {
        embedBatch,
        captureFullHierarchy: async () => captured,
      })
    );

    expect(repository.loadShardPageInventory).toHaveBeenCalledWith(
      definition.universeId,
      definition.shardKey,
      priorSnapshotId,
      512
    );
    expect(result.universes[0]!.shardResults[0]).toMatchObject({
      status: 'fresh',
      pageVersionReuseCount: 2,
      embeddedChunkCount: 0,
      pageChanges: {
        added: 0,
        changed: 0,
        moved: 1,
        deleted: 1,
        unchanged: 1,
      },
    });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  test('releases every shard lease before terminal reload and retries one stale manifest CAS', async () => {
    const definitions = [shard(1), shard(2)];
    const repository = new FakePartitionRepository();
    repository.failFirstManifestCas = true;
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration(definitions),
      dependencies(repository)
    );
    expect(repository.shardReleaseOrder).toHaveLength(2);
    expect(repository.manifestActivationInputs).toHaveLength(2);
    expect(result.universes[0]!.manifestStatus).toBe('published');
    const lastReleaseOrder = Math.max(...repository.releaseShardLease.mock.invocationCallOrder);
    const terminalReloadOrder = repository.loadUniverseSynchronizationState
      .mock.invocationCallOrder[1]!;
    expect(lastReleaseOrder).toBeLessThan(terminalReloadOrder);
  });

  test('defers manifest publication when a shard lease release is not confirmed', async () => {
    const definition = shard(1);
    const repository = new FakePartitionRepository();
    repository.releaseShardLease.mockImplementationOnce(async () => false);

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([definition]),
      dependencies(repository)
    );

    expect(result.universes[0]).toMatchObject({ manifestStatus: 'deferred' });
    expect(result.universes[0]!.shardResults[0]).toMatchObject({
      status: 'fresh',
      fullSourceScan: true,
      leaseReleaseVerified: false,
    });
    expect(repository.loadUniverseSynchronizationState).toHaveBeenCalledTimes(1);
    expect(repository.manifestActivationInputs).toHaveLength(0);
  });

  test('drains and releases shard work after parent abort without publishing', async () => {
    const definition = shard(1);
    const repository = new FakePartitionRepository();
    const controller = new AbortController();
    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([definition]),
      dependencies(repository, {
        signal: controller.signal,
        captureFullHierarchy: async ({ signal }) => {
          controller.abort(new DOMException('stop', 'AbortError'));
          throw signal.reason;
        },
      })
    );
    expect(result.universes[0]).toMatchObject({ manifestStatus: 'deferred' });
    expect(result.universes[0]!.shardResults[0]).toMatchObject({ status: 'aborted' });
    expect(repository.releaseShardLease).toHaveBeenCalledTimes(1);
    expect(repository.manifestActivationInputs).toHaveLength(0);
  });

  test('configuration rotation preserves the old head until one atomic activation', async () => {
    const original = shard(1, { shardKey: 'raw' });
    const unchanged = shard(2, { shardKey: 'nxt' });
    const repository = new FakePartitionRepository();
    const originalSnapshot = repository.seedLastKnownGood(original);
    const unchangedSnapshot = repository.seedLastKnownGood(unchanged);
    const rotated = shard(3, { shardKey: 'raw', displayName: 'Raw renamed' });
    repository.rotateForTest(rotated);
    const state = (repository as unknown as { state(): BackstageNotionPartitionSynchronizationState }).state();
    const raw = state.shards.find(item => item.shardKey === 'raw')!;
    expect(raw.activeSnapshot?.snapshotId).toBe(originalSnapshot);
    expect(raw.partitionVersionId).not.toBe(raw.expectedHead.currentPartitionVersionId);
    expect(raw.activeSnapshot?.partitionVersionId)
      .toBe(raw.expectedHead.currentPartitionVersionId);
    expect(state.shards.find(item => item.shardKey === 'nxt')!.activeSnapshot?.snapshotId)
      .toBe(unchangedSnapshot);
    expect(repository.immutableManifestIds).toHaveLength(1);

    const result = await syncBackstageNotionPartitionConfiguration(
      configuration([rotated, unchanged]),
      dependencies(repository)
    );
    const rawActivation = repository.shardActivationInputs.find(input =>
      input.shardKey === 'raw'
    )!;
    expect(rawActivation.expectedHead).toMatchObject({
      currentPartitionVersionId: raw.expectedHead.currentPartitionVersionId,
      activeSnapshotId: originalSnapshot,
    });
    expect(rawActivation.partitionVersionId).toBe(raw.partitionVersionId);
    expect(result.universes[0]!.manifestStatus).toBe('published');
    const terminal = (repository as unknown as {
      state(): BackstageNotionPartitionSynchronizationState;
    }).state().shards.find(item => item.shardKey === 'raw')!;
    expect(terminal.expectedHead.currentPartitionVersionId).toBe(raw.partitionVersionId);
    expect(terminal.activeSnapshot?.snapshotId).not.toBe(originalSnapshot);
    expect(repository.immutableManifestIds).toHaveLength(2);
  });
});

import {
  BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_SELECTORS,
  BACKSTAGE_NOTION_PARTITION_ROUTING_VERSION,
  resolveBackstageNotionPartitionRouting,
} from '../src/shared/backstage/backstageNotionPartitionRoutingCore.js';

const CONFIGURATION_HASH = 'a'.repeat(64);

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`;
}

function member(
  sequence: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    shardKey: `shard/${sequence}`,
    partitionVersionId: uuid(sequence),
    snapshotId: uuid(100 + sequence),
    retrievalTier: 'hot',
    required: true,
    decision: 'fresh',
    verifiedAt: '2026-08-24T12:00:00.000Z',
    scopeTags: [],
    categoryTags: [],
    ...overrides,
  };
}

function omission(
  sequence: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    shardKey: `optional/${sequence}`,
    partitionVersionId: uuid(sequence),
    retrievalTier: 'archive',
    required: false,
    decision: 'optional_unavailable',
    safeReasonCode: 'SHARD_SYNC_INCOMPLETE',
    scopeTags: [],
    categoryTags: [],
    ...overrides,
  };
}

function rawMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return member(1, {
    shardKey: 'raw/2026',
    scopeTags: ['year:2026', 'brand:raw'],
    categoryTags: ['show', 'current-canon'],
    ...overrides,
  });
}

function smackdownMember(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return member(2, {
    shardKey: 'blue/2026',
    scopeTags: ['brand:smackdown', 'year:2026'],
    categoryTags: ['current-canon', 'show'],
    ...overrides,
  });
}

function sharedMember(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return member(3, {
    shardKey: 'shared',
    retrievalTier: 'cold',
    scopeTags: ['shared'],
    categoryTags: ['current-canon'],
    ...overrides,
  });
}

function archiveMember(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return member(4, {
    shardKey: 'archive/raw/2025',
    retrievalTier: 'archive',
    required: false,
    scopeTags: ['year:2025', 'brand:raw'],
    categoryTags: ['show', 'archive'],
    ...overrides,
  });
}

function routingState(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    universeId: 'my-universe-2k26',
    manifestId: uuid(900),
    manifestGeneration: '7',
    configurationVersionId: uuid(901),
    configurationHash: CONFIGURATION_HASH,
    configurationCurrent: true,
    embeddingModel: 'text-embedding-3-small',
    embeddingVersion: 1,
    embeddingDimension: 1_536,
    indexFormatVersion: 1,
    members: [sharedMember(), smackdownMember(), rawMember()],
    omissions: [],
    ...overrides,
  };
}

function relevantIntent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kind: 'relevant',
    cardinality: 'all_matching',
    allowedTiers: ['hot'],
    explicitArchive: false,
    selectors: [{ allScopeTags: [], allCategoryTags: [] }],
    ...overrides,
  };
}

describe('backstage Notion partition routing core', () => {
  it('matches every tag within a selector, ORs selectors, and canonicalizes output', () => {
    const first = resolveBackstageNotionPartitionRouting(
      routingState({
        manifestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        members: [
          sharedMember(),
          smackdownMember(),
          rawMember({
            decision: 'retained_last_known_good',
            verifiedAt: '2026-08-24T08:00:00-04:00',
          }),
        ],
      }),
      relevantIntent({
        allowedTiers: ['cold', 'hot'],
        selectors: [
          {
            allScopeTags: ['year:2026', 'brand:raw'],
            allCategoryTags: ['current-canon'],
          },
          { allScopeTags: ['shared'], allCategoryTags: [] },
        ],
      })
    );
    const reordered = resolveBackstageNotionPartitionRouting(
      routingState({
        manifestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        members: [
          rawMember({
            decision: 'retained_last_known_good',
            verifiedAt: new Date('2026-08-24T12:00:00.000Z'),
            scopeTags: ['brand:raw', 'year:2026'],
            categoryTags: ['current-canon', 'show'],
          }),
          smackdownMember(),
          sharedMember(),
        ],
      }),
      relevantIntent({
        allowedTiers: ['hot', 'cold'],
        selectors: [
          { allScopeTags: ['shared'], allCategoryTags: [] },
          {
            allScopeTags: ['brand:raw', 'year:2026'],
            allCategoryTags: ['current-canon'],
          },
        ],
      })
    );

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      routingVersion: BACKSTAGE_NOTION_PARTITION_ROUTING_VERSION,
      manifestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'resolved',
      cardinality: 'all_matching',
      complete: true,
      shards: [
        {
          shardKey: 'raw/2026',
          decision: 'retained_last_known_good',
          verifiedAt: '2026-08-24T12:00:00.000Z',
        },
        { shardKey: 'shared', retrievalTier: 'cold' },
      ],
      matchingOmissions: [],
    });
    expect(first.resolutionDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.intent)).toBe(true);
    if (first.intent.kind !== 'relevant' || first.status !== 'resolved') {
      throw new Error('expected a relevant resolved result');
    }
    expect(Object.isFrozen(first.intent.allowedTiers)).toBe(true);
    expect(Object.isFrozen(first.intent.selectors)).toBe(true);
    expect(Object.isFrozen(first.intent.selectors[0])).toBe(true);
    expect(Object.isFrozen(first.intent.selectors[0]?.allScopeTags)).toBe(true);
    expect(Object.isFrozen(first.shards)).toBe(true);
    expect(first.shards.every(shard => Object.isFrozen(shard))).toBe(true);
  });

  it('requires exact archive opt-in and excludes archive shards by default', () => {
    const state = routingState({ members: [archiveMember(), rawMember()] });
    const defaultHot = resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({
        selectors: [{ allScopeTags: ['brand:raw'], allCategoryTags: [] }],
      })
    );
    expect(defaultHot).toMatchObject({
      status: 'resolved',
      shards: [{ shardKey: 'raw/2026', retrievalTier: 'hot' }],
    });

    const explicitArchive = resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({
        allowedTiers: ['archive'],
        explicitArchive: true,
        selectors: [{ allScopeTags: ['brand:raw'], allCategoryTags: [] }],
      })
    );
    expect(explicitArchive).toMatchObject({
      status: 'resolved',
      shards: [{ shardKey: 'archive/raw/2025', retrievalTier: 'archive' }],
    });

    expect(() => resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({ allowedTiers: ['hot', 'archive'], explicitArchive: false })
    )).toThrow(/exact explicit opt-in/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({ allowedTiers: ['hot'], explicitArchive: true })
    )).toThrow(/exact explicit opt-in/u);
  });

  it('enforces exact-one cardinality without selecting an arbitrary first shard', () => {
    const state = routingState({ members: [smackdownMember(), rawMember()] });
    const ambiguous = resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({
        cardinality: 'exactly_one',
        selectors: [{ allScopeTags: ['year:2026'], allCategoryTags: ['show'] }],
      })
    );
    expect(ambiguous).toMatchObject({
      status: 'ambiguous',
      cardinality: 'exactly_one',
      availableMatchCount: 2,
      omittedMatchCount: 0,
    });
    expect('shards' in ambiguous).toBe(false);

    const exact = resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({
        cardinality: 'exactly_one',
        selectors: [{ allScopeTags: ['brand:raw'], allCategoryTags: ['show'] }],
      })
    );
    expect(exact).toMatchObject({
      status: 'resolved',
      cardinality: 'exactly_one',
      shards: [{ shardKey: 'raw/2026' }],
    });

    const absent = resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({
        cardinality: 'exactly_one',
        selectors: [{ allScopeTags: ['brand:nxt'], allCategoryTags: [] }],
      })
    );
    expect(absent).toMatchObject({
      status: 'not_found',
      availableMatchCount: 0,
      omittedMatchCount: 0,
    });
  });

  it('isolates unrelated omissions while reporting selected partial and exhaustive gaps', () => {
    const state = routingState({
      members: [sharedMember(), rawMember()],
      omissions: [omission(4, {
        shardKey: 'archive/raw/2025',
        scopeTags: ['brand:raw', 'year:2025'],
        categoryTags: ['archive', 'show'],
      })],
    });
    const hot = resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({
        selectors: [{ allScopeTags: ['brand:raw'], allCategoryTags: [] }],
      })
    );
    expect(hot).toMatchObject({
      status: 'resolved',
      complete: true,
      shards: [{ shardKey: 'raw/2026' }],
      matchingOmissions: [],
    });

    const missingArchive = resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({
        cardinality: 'exactly_one',
        allowedTiers: ['archive'],
        explicitArchive: true,
        selectors: [{ allScopeTags: ['brand:raw'], allCategoryTags: [] }],
      })
    );
    expect(missingArchive).toMatchObject({
      status: 'indeterminate',
      availableMatchCount: 0,
      matchingOmissions: [{
        shardKey: 'archive/raw/2025',
        safeReasonCode: 'SHARD_SYNC_INCOMPLETE',
      }],
    });

    const selectedPartial = resolveBackstageNotionPartitionRouting(
      state,
      relevantIntent({
        allowedTiers: ['archive', 'hot'],
        explicitArchive: true,
        selectors: [{ allScopeTags: ['brand:raw'], allCategoryTags: [] }],
      })
    );
    expect(selectedPartial).toMatchObject({
      status: 'resolved',
      complete: false,
      shards: [{ shardKey: 'raw/2026' }],
      matchingOmissions: [{ shardKey: 'archive/raw/2025' }],
    });

    const exhaustive = resolveBackstageNotionPartitionRouting(
      state,
      { kind: 'complete_all', cardinality: 'all_matching' }
    );
    expect(exhaustive).toMatchObject({
      status: 'indeterminate',
      availableMatchCount: 2,
      matchingOmissions: [{ shardKey: 'archive/raw/2025' }],
    });
  });

  it('resolves an already-established scope by stable shard key', () => {
    const state = routingState({
      members: [archiveMember(), rawMember()],
      omissions: [omission(5, { shardKey: 'archive/raw/2024' })],
    });
    expect(resolveBackstageNotionPartitionRouting(
      state,
      { kind: 'resolved_scope', cardinality: 'exactly_one', shardKey: 'archive/raw/2025' }
    )).toMatchObject({
      status: 'resolved',
      shards: [{ shardKey: 'archive/raw/2025', retrievalTier: 'archive' }],
    });
    expect(resolveBackstageNotionPartitionRouting(
      state,
      { kind: 'resolved_scope', cardinality: 'exactly_one', shardKey: 'archive/raw/2024' }
    )).toMatchObject({
      status: 'indeterminate',
      availableMatchCount: 0,
      matchingOmissions: [{ shardKey: 'archive/raw/2024' }],
    });
    expect(resolveBackstageNotionPartitionRouting(
      state,
      { kind: 'resolved_scope', cardinality: 'exactly_one', shardKey: 'nxt/2026' }
    )).toMatchObject({ status: 'not_found' });
  });

  it('binds the versioned digest to the manifest, selected snapshot, and intent', () => {
    const state = routingState({ members: [rawMember()] });
    const broadIntent = relevantIntent({
      selectors: [{ allScopeTags: ['brand:raw'], allCategoryTags: [] }],
    });
    const narrowIntent = relevantIntent({
      selectors: [{
        allScopeTags: ['brand:raw', 'year:2026'],
        allCategoryTags: [],
      }],
    });
    const baseline = resolveBackstageNotionPartitionRouting(state, broadIntent);
    const rotatedDesiredConfiguration = resolveBackstageNotionPartitionRouting(
      routingState({
        members: [rawMember()],
        configurationCurrent: false,
      }),
      broadIntent
    );
    const newManifest = resolveBackstageNotionPartitionRouting(
      routingState({ members: [rawMember()], manifestId: uuid(902) }),
      broadIntent
    );
    const newSnapshot = resolveBackstageNotionPartitionRouting(
      routingState({
        members: [rawMember({ snapshotId: uuid(777) })],
      }),
      broadIntent
    );
    const narrowed = resolveBackstageNotionPartitionRouting(state, narrowIntent);

    expect(baseline.routingVersion).toBe(1);
    expect(rotatedDesiredConfiguration.configurationCurrent).toBe(false);
    expect(rotatedDesiredConfiguration.resolutionDigest)
      .toBe(baseline.resolutionDigest);
    expect(newManifest.resolutionDigest).not.toBe(baseline.resolutionDigest);
    expect(newSnapshot.resolutionDigest).not.toBe(baseline.resolutionDigest);
    expect(narrowed.resolutionDigest).not.toBe(baseline.resolutionDigest);
  });

  it('rejects unknown fields, malformed tags, duplicate identities, and invalid omissions', () => {
    expect(() => resolveBackstageNotionPartitionRouting(
      { ...routingState(), unexpected: true },
      relevantIntent()
    )).toThrow(/unknown fields/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState({ members: [{ ...rawMember(), unexpected: true }] }),
      relevantIntent()
    )).toThrow(/unknown fields/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState(),
      { ...relevantIntent(), unexpected: true }
    )).toThrow(/unknown fields/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState({ members: [rawMember({ scopeTags: ['Brand:Raw'] })] }),
      relevantIntent()
    )).toThrow(/invalid/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState({ members: [rawMember({ scopeTags: [' brand:raw'] })] }),
      relevantIntent()
    )).toThrow(/invalid/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState({ members: [rawMember({ scopeTags: ['brand:raw', 'brand:raw'] })] }),
      relevantIntent()
    )).toThrow(/duplicate tags/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState({ members: [rawMember(), rawMember({ snapshotId: uuid(999) })] }),
      relevantIntent()
    )).toThrow(/duplicate shard identities/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState({
        members: [rawMember()],
        omissions: [omission(5, { required: true })],
      }),
      relevantIntent()
    )).toThrow(/required must be false/u);
  });

  it('rejects oversized, sparse, accessor-backed, and extended arrays without invoking accessors', () => {
    const tooManySelectors = Array.from(
      { length: BACKSTAGE_NOTION_PARTITION_ROUTING_MAX_SELECTORS + 1 },
      (_, index) => ({ allScopeTags: [`scope:${index}`], allCategoryTags: [] })
    );
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState(),
      relevantIntent({ selectors: tooManySelectors })
    )).toThrow(/bounded array contract/u);

    const tooManyRows = Array.from({ length: 129 }, (_, index) => member(index + 1));
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState({ members: tooManyRows }),
      relevantIntent()
    )).toThrow(/bounded array contract/u);

    const sparseSelectors = new Array(1);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState(),
      relevantIntent({ selectors: sparseSelectors })
    )).toThrow(/inert data property/u);

    let accessorCalls = 0;
    const accessorTiers = ['hot'];
    Object.defineProperty(accessorTiers, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return 'hot';
      },
    });
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState(),
      relevantIntent({ allowedTiers: accessorTiers })
    )).toThrow(/inert data property/u);
    expect(accessorCalls).toBe(0);

    const extendedTags = ['brand:raw'];
    Object.defineProperty(extendedTags, 'hidden', { value: true });
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState({ members: [rawMember({ scopeTags: extendedTags })] }),
      relevantIntent()
    )).toThrow(/unknown array fields/u);
  });

  it('rejects duplicate selectors, mixed empty selectors, and accessor-backed records', () => {
    const duplicateSelector = {
      allScopeTags: ['brand:raw'],
      allCategoryTags: ['show'],
    };
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState(),
      relevantIntent({ selectors: [duplicateSelector, { ...duplicateSelector }] })
    )).toThrow(/duplicate selectors/u);
    expect(() => resolveBackstageNotionPartitionRouting(
      routingState(),
      relevantIntent({
        selectors: [
          { allScopeTags: [], allCategoryTags: [] },
          { allScopeTags: ['brand:raw'], allCategoryTags: [] },
        ],
      })
    )).toThrow(/empty default selector/u);

    let accessorCalls = 0;
    const accessorState = routingState();
    Object.defineProperty(accessorState, 'manifestId', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return uuid(900);
      },
    });
    expect(() => resolveBackstageNotionPartitionRouting(
      accessorState,
      relevantIntent()
    )).toThrow(/inert data property/u);
    expect(accessorCalls).toBe(0);
  });
});

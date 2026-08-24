import {
  BACKSTAGE_NOTION_PARTITION_MAX_CONFIG_BYTES,
  BACKSTAGE_NOTION_PARTITION_MAX_CONTENT_CODE_POINTS,
  BACKSTAGE_NOTION_PARTITION_MAX_PAGES,
  parseBackstageNotionPartitionConfiguration,
  parseBackstageNotionPartitionedIndexMode,
  resolveBackstageNotionPartitionUniverse,
} from '../src/shared/backstage/backstageNotionPartitionCore.js';

const universeId = 'my-universe-2k26';
const rawRootPageId = '22222222222242228222222222222222';
const normalizedRootPageId = '22222222-2222-4222-8222-222222222222';
const secondaryShardKey = ['smackdown', '2026'].join('/');

function shard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shardKey: 'raw/2026',
    rootPageId: rawRootPageId,
    displayName: 'Monday Night Raw 2026',
    retrievalTier: 'hot',
    required: true,
    scopeTags: ['year:2026', 'brand:raw'],
    categoryTags: ['current-canon'],
    capacity: {
      maxPages: 512,
      maxChunks: 2_048,
      maxDepth: 16,
      maxContentCodePoints: 4_000_000,
    },
    ...overrides,
  };
}

function envelope(
  shards: readonly Record<string, unknown>[] = [shard()],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    version: 1,
    generation: 'authority-2026.08.24-1',
    universes: [{ universeId, shards }],
    ...overrides,
  };
}

describe('Backstage Notion partition configuration core', () => {
  it('defaults absent and invalid rollout modes to monolith with validity metadata', () => {
    expect(parseBackstageNotionPartitionedIndexMode(undefined)).toEqual({
      status: 'absent',
      mode: 'monolith',
    });
    for (const mode of ['monolith', 'shadow', 'partitioned'] as const) {
      expect(parseBackstageNotionPartitionedIndexMode(mode)).toEqual({
        status: 'valid',
        mode,
      });
    }
    for (const invalid of ['', ' shadow', 'SHADOW', 'cutover', 'x'.repeat(1_024)]) {
      expect(parseBackstageNotionPartitionedIndexMode(invalid)).toEqual({
        status: 'invalid',
        mode: 'monolith',
      });
    }
  });

  it('parses, normalizes, canonically orders, and deeply freezes partitions', () => {
    const secondRoot = '11111111-1111-4111-8111-111111111111';
    const thirdRoot = '33333333-3333-4333-8333-333333333333';
    const configuration = parseBackstageNotionPartitionConfiguration(JSON.stringify({
      version: 1,
      generation: 'generation-7',
      universes: [
        {
          universeId,
          shards: [
            shard(),
            shard({
              shardKey: 'archive/raw/2025',
              rootPageId: secondRoot,
              displayName: 'Raw 2025 archive',
              retrievalTier: 'archive',
              required: false,
              scopeTags: ['year:2025', 'brand:raw'],
              categoryTags: ['recovery', 'archive'],
            }),
          ],
        },
        {
          universeId: 'alpha-universe',
          shards: [shard({
            shardKey: 'shared',
            rootPageId: thirdRoot,
            displayName: 'Shared canon',
          })],
        },
      ],
    }));

    expect(configuration).toMatchObject({
      status: 'valid',
      version: 1,
      generation: 'generation-7',
      semanticDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(configuration.universes.map(item => item.universeId)).toEqual([
      'alpha-universe',
      universeId,
    ]);
    const configuredUniverse = resolveBackstageNotionPartitionUniverse(
      configuration,
      universeId
    );
    expect(configuredUniverse?.shards.map(item => item.shardKey)).toEqual([
      'archive/raw/2025',
      'raw/2026',
    ]);
    expect(configuredUniverse?.shards[0]?.categoryTags).toEqual([
      'archive',
      'recovery',
    ]);
    expect(configuredUniverse?.shards[1]).toMatchObject({
      universeId,
      rootPageId: normalizedRootPageId,
      scopeTags: ['brand:raw', 'year:2026'],
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.universes)).toBe(true);
    expect(Object.isFrozen(configuration.universes[0])).toBe(true);
    expect(Object.isFrozen(configuredUniverse?.shards)).toBe(true);
    expect(Object.isFrozen(configuredUniverse?.shards[0]?.capacity)).toBe(true);
    expect(Object.isFrozen(configuredUniverse?.shards[0]?.scopeTags)).toBe(true);
  });

  it('keeps operator generation separate from the canonical semantic digest', () => {
    const first = parseBackstageNotionPartitionConfiguration(JSON.stringify(envelope()));
    const reordered = parseBackstageNotionPartitionConfiguration(JSON.stringify(envelope([
      shard({
        scopeTags: ['brand:raw', 'year:2026'],
        categoryTags: ['current-canon'],
      }),
    ], { generation: 'generation-2' })));

    expect(first.status).toBe('valid');
    expect(reordered.status).toBe('valid');
    expect(first.generation).not.toBe(reordered.generation);
    expect(first.semanticDigest).toBe(reordered.semanticDigest);

    const renamed = parseBackstageNotionPartitionConfiguration(JSON.stringify(envelope([
      shard({ displayName: 'Raw renamed without changing shard identity' }),
    ])));
    expect(renamed.status).toBe('valid');
    expect(renamed.universes[0]?.shards[0]?.shardKey).toBe('raw/2026');
    expect(renamed.semanticDigest).not.toBe(first.semanticDigest);
  });

  it.each([
    envelope([shard()], { unexpected: true }),
    envelope([shard()], { universes: [{ universeId, shards: [shard()], unexpected: true }] }),
    envelope([shard({ unexpected: true })]),
    envelope([shard({ capacity: {
      maxPages: 512,
      maxChunks: 2_048,
      maxDepth: 16,
      maxContentCodePoints: 4_000_000,
      unexpected: true,
    } })]),
  ])('rejects unknown fields at every closed envelope level %#', value => {
    expect(parseBackstageNotionPartitionConfiguration(JSON.stringify(value)))
      .toMatchObject({ status: 'invalid', reason: 'invalid_shape' });
  });

  it.each([
    envelope([shard(), shard({
      rootPageId: '11111111-1111-4111-8111-111111111111',
    })]),
    envelope([shard(), shard({
      shardKey: secondaryShardKey,
    })]),
    envelope([shard({ scopeTags: ['brand:raw', 'brand:raw'] })]),
    envelope([shard()], {
      universes: [
        { universeId, shards: [shard()] },
        {
          universeId,
          shards: [shard({
            shardKey: secondaryShardKey,
            rootPageId: '11111111-1111-4111-8111-111111111111',
          })],
        },
      ],
    }),
    envelope([shard()], {
      universes: [
        { universeId, shards: [shard()] },
        {
          universeId: 'other-universe',
          shards: [shard({ shardKey: 'shared', displayName: 'Duplicate root' })],
        },
      ],
    }),
  ])('rejects duplicate shard, tag, universe, or root identities %#', value => {
    expect(parseBackstageNotionPartitionConfiguration(JSON.stringify(value)))
      .toMatchObject({ status: 'invalid', reason: 'invalid_shape' });
  });

  it.each([
    envelope([shard({ shardKey: 'Raw/2026' })]),
    envelope([shard({ retrievalTier: 'warm' })]),
    envelope([shard({ required: 'yes' })]),
    envelope([shard({ rootPageId: `https://notion.so/${rawRootPageId}` })]),
    envelope([shard({ scopeTags: [' brand:raw'] })]),
    envelope([shard({ capacity: {
      maxPages: BACKSTAGE_NOTION_PARTITION_MAX_PAGES + 1,
      maxChunks: 2_048,
      maxDepth: 16,
      maxContentCodePoints: 4_000_000,
    } })]),
    envelope([shard({ capacity: {
      maxPages: 512,
      maxChunks: 2_049,
      maxDepth: 16,
      maxContentCodePoints: 4_000_000,
    } })]),
    envelope([shard({ capacity: {
      maxPages: 512,
      maxChunks: 2_048,
      maxDepth: 17,
      maxContentCodePoints: 4_000_000,
    } })]),
    envelope([shard({ capacity: {
      maxPages: 512,
      maxChunks: 2_048,
      maxDepth: 16,
      maxContentCodePoints: BACKSTAGE_NOTION_PARTITION_MAX_CONTENT_CODE_POINTS + 1,
    } })]),
    envelope([], { version: 2 }),
    envelope([], { generation: ' padded' }),
    envelope([], { universes: [] }),
  ])('rejects malformed identities, policy values, and capacity bounds %#', value => {
    expect(parseBackstageNotionPartitionConfiguration(JSON.stringify(value)))
      .toMatchObject({ status: 'invalid', reason: 'invalid_shape' });
  });

  it('classifies absent, malformed, empty, and oversized configuration safely', () => {
    expect(parseBackstageNotionPartitionConfiguration(undefined)).toEqual({
      status: 'absent',
      generation: null,
      semanticDigest: null,
      universes: [],
    });
    expect(parseBackstageNotionPartitionConfiguration('{bad json')).toMatchObject({
      status: 'invalid',
      reason: 'invalid_json',
    });
    expect(parseBackstageNotionPartitionConfiguration('')).toMatchObject({
      status: 'invalid',
      reason: 'invalid_shape',
    });
    expect(parseBackstageNotionPartitionConfiguration(
      'x'.repeat(BACKSTAGE_NOTION_PARTITION_MAX_CONFIG_BYTES + 1)
    )).toMatchObject({ status: 'invalid', reason: 'too_large' });
  });

  it('resolves exact universe identity only from valid canonical configuration', () => {
    const configuration = parseBackstageNotionPartitionConfiguration(
      JSON.stringify(envelope())
    );
    expect(resolveBackstageNotionPartitionUniverse(configuration, universeId))
      .toMatchObject({ universeId });
    expect(resolveBackstageNotionPartitionUniverse(
      configuration,
      universeId.toUpperCase()
    )).toBeNull();
    expect(resolveBackstageNotionPartitionUniverse(
      parseBackstageNotionPartitionConfiguration('{bad json'),
      universeId
    )).toBeNull();
  });
});

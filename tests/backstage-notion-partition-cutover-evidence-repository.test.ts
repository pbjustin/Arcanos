import { describe, expect, jest, test } from '@jest/globals';
import type { Pool } from 'pg';

import {
  PostgresBackstageNotionPartitionCutoverEvidenceRepository,
  type SealBackstageNotionPartitionCutoverEvidenceInput,
} from '../src/core/db/repositories/backstageNotionPartitionCutoverEvidenceRepository.js';

const UNIVERSE_ID = 'my-universe-2k26';
const MONOLITH_SNAPSHOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANIFEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONFIGURATION_VERSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SOURCE_GENERATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONFIGURATION_HASH = '1'.repeat(64);
const SOURCE_DIGEST = '2'.repeat(64);
const SOURCE_VERIFICATION_HASH = '3'.repeat(64);
const ATTESTATION_DIGEST = '4'.repeat(64);
const RECONCILIATION_GENERATION = 12;
const OBSERVED_AT = new Date('2026-08-30T12:00:00.000Z');
const SOURCE_VERIFIED_AT = new Date('2026-08-30T11:50:00.000Z');
const ROLLBACK_VERIFIED_AT = new Date('2026-08-30T11:55:00.000Z');
const ROLLBACK_VALID_UNTIL = new Date('2026-09-06T11:55:00.000Z');
const VALIDATED_AT = new Date('2026-08-30T11:59:00.000Z');
const EXPIRES_AT = new Date('2026-08-31T11:59:00.000Z');
const MAXIMUM_STALENESS_MS = 24 * 60 * 60 * 1_000;

const SHARDS = [
  {
    key: 'archive',
    snapshotId: '11111111-1111-4111-8111-111111111111',
    pageCount: '80',
    chunkCount: '500',
  },
  {
    key: 'nxt',
    snapshotId: '22222222-2222-4222-8222-222222222222',
    pageCount: '75',
    chunkCount: '480',
  },
  {
    key: 'raw',
    snapshotId: '33333333-3333-4333-8333-333333333333',
    pageCount: '70',
    chunkCount: '470',
  },
  {
    key: 'shared',
    snapshotId: '44444444-4444-4444-8444-444444444444',
    pageCount: '65',
    chunkCount: '450',
  },
  {
    key: 'smackdown',
    snapshotId: '55555555-5555-4555-8555-555555555555',
    pageCount: '76',
    chunkCount: '407',
  },
] as const;

interface MockQueryResult {
  readonly rows: Array<Record<string, unknown>>;
  readonly rowCount: number;
}

function result(
  rows: Array<Record<string, unknown>> = []
): MockQueryResult {
  return { rows, rowCount: rows.length };
}

function poolReturning(rows: Array<Record<string, unknown>>): Readonly<{
  pool: Pool;
  query: ReturnType<typeof jest.fn>;
}> {
  const query = jest.fn(async () => result(rows));
  return {
    pool: { query } as unknown as Pool,
    query,
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function expectCurrentSuccessfulMonolithPin(sql: string): void {
  expect(sql).toContain(
    'JOIN public.backstage_notion_latest_sync_attempts AS latest_sync'
  );
  expect(sql).toContain("latest_sync.outcome IN ('activated', 'unchanged')");
  expect(sql).toContain('latest_sync.completed_at IS NOT NULL');
  expect(sql).toContain(
    'latest_sync.completed_at >= latest_sync.started_at'
  );
  expect(sql).toContain(
    'latest_sync.activated_snapshot_id = rollback_snapshot.id'
  );
  expect(sql).toContain('latest_sync.failure_phase IS NULL');
  expect(sql).toContain('latest_sync.failure_reason IS NULL');
  expect(sql).toContain(
    'authority_head.active_snapshot_id = rollback_snapshot.id'
  );
}

function validationAnchorRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    universe_id: UNIVERSE_ID,
    monolith_snapshot_id: MONOLITH_SNAPSHOT_ID,
    partition_manifest_id: MANIFEST_ID,
    partition_configuration_version_id: CONFIGURATION_VERSION_ID,
    partition_configuration_hash: CONFIGURATION_HASH,
    partition_source_generation_id: SOURCE_GENERATION_ID,
    partition_source_digest: SOURCE_DIGEST,
    partition_source_verification_hash: SOURCE_VERIFICATION_HASH,
    reconciliation_generation: String(RECONCILIATION_GENERATION),
    rollback_monolith_verified_at: ROLLBACK_VERIFIED_AT,
    ...overrides,
  };
}

function sealInput(
  overrides: Partial<SealBackstageNotionPartitionCutoverEvidenceInput> = {}
): SealBackstageNotionPartitionCutoverEvidenceInput {
  return {
    version: 1,
    universeId: UNIVERSE_ID,
    monolithSnapshotId: MONOLITH_SNAPSHOT_ID,
    partitionManifestId: MANIFEST_ID,
    partitionConfigurationVersionId: CONFIGURATION_VERSION_ID,
    partitionConfigurationHash: CONFIGURATION_HASH,
    partitionSourceGenerationId: SOURCE_GENERATION_ID,
    partitionSourceDigest: SOURCE_DIGEST,
    partitionSourceVerificationHash: SOURCE_VERIFICATION_HASH,
    reconciliationGeneration: RECONCILIATION_GENERATION,
    rollbackMonolithVerifiedAt: ROLLBACK_VERIFIED_AT,
    rollbackMonolithValidUntil: ROLLBACK_VALID_UNTIL,
    caseCount: 6,
    exactScopeCaseCount: 2,
    relevantCaseCount: 2,
    completeScopeCaseCount: 2,
    cursorContinuationCaseCount: 2,
    monolithRequestCount: 10,
    partitionRequestCount: 11,
    citationCount: 100,
    exactScopeParityPassed: true,
    relevantRetrievalParityPassed: true,
    completeScopeParityPassed: true,
    cursorStabilityPassed: true,
    attestationDigest: ATTESTATION_DIGEST,
    validatedAt: VALIDATED_AT,
    ...overrides,
  };
}

function gateRow(
  shardIndex: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const shard = SHARDS[shardIndex]!;
  return {
    observed_at: OBSERVED_AT,
    universe_id: UNIVERSE_ID,
    evidence_version: '1',
    evidence_reconciliation_generation: String(RECONCILIATION_GENERATION),
    active_reconciliation_generation: String(RECONCILIATION_GENERATION),
    published_reconciliation_generation: String(RECONCILIATION_GENERATION),
    manifest_id: MANIFEST_ID,
    active_manifest_id: MANIFEST_ID,
    manifest_state: 'sealed',
    manifest_configuration_version_id: CONFIGURATION_VERSION_ID,
    active_configuration_version_id: CONFIGURATION_VERSION_ID,
    configuration_hash: CONFIGURATION_HASH,
    active_configuration_hash: CONFIGURATION_HASH,
    source_generation_id: SOURCE_GENERATION_ID,
    source_digest: SOURCE_DIGEST,
    source_page_count: '366',
    source_chunk_count: '2307',
    source_verified_at: SOURCE_VERIFIED_AT,
    source_verification_hash: SOURCE_VERIFICATION_HASH,
    manifest_page_count: '366',
    manifest_chunk_count: '2307',
    embedding_model: 'text-embedding-3-small',
    index_format_version: '1',
    member_count: '5',
    omission_count: '0',
    shard_key: shard.key,
    shard_snapshot_id: shard.snapshotId,
    shard_source_generation_id: SOURCE_GENERATION_ID,
    shard_index_format_version: '1',
    shard_page_count: shard.pageCount,
    shard_chunk_count: shard.chunkCount,
    member_decision: 'fresh',
    member_readable: true,
    active_lease_count: '0',
    unresolved_activation_count: '0',
    rollback_monolith_snapshot_id: MONOLITH_SNAPSHOT_ID,
    rollback_monolith_chunk_count: '4096',
    rollback_monolith_verified_at: ROLLBACK_VERIFIED_AT,
    rollback_monolith_valid_until: ROLLBACK_VALID_UNTIL,
    rollback_monolith_readable: true,
    shadow_comparison_completed: true,
    exact_scope_parity_passed: true,
    relevant_retrieval_parity_passed: true,
    complete_scope_parity_passed: true,
    cursor_stability_passed: true,
    case_count: '6',
    exact_scope_case_count: '2',
    relevant_case_count: '2',
    complete_scope_case_count: '2',
    cursor_continuation_case_count: '2',
    monolith_request_count: '10',
    partition_request_count: '11',
    citation_count: '100',
    attestation_digest: ATTESTATION_DIGEST,
    validated_at: VALIDATED_AT,
    expires_at: EXPIRES_AT,
    ...overrides,
  };
}

describe('PostgresBackstageNotionPartitionCutoverEvidenceRepository', () => {
  test('loads one validation anchor pinned to the exact active authority, manifest, configuration, and source generation', async () => {
    const harness = poolReturning([validationAnchorRow()]);
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );

    await expect(repository.loadValidationAnchor(UNIVERSE_ID)).resolves.toEqual({
      universeId: UNIVERSE_ID,
      monolithSnapshotId: MONOLITH_SNAPSHOT_ID,
      partitionManifestId: MANIFEST_ID,
      partitionConfigurationVersionId: CONFIGURATION_VERSION_ID,
      partitionConfigurationHash: CONFIGURATION_HASH,
      partitionSourceGenerationId: SOURCE_GENERATION_ID,
      partitionSourceDigest: SOURCE_DIGEST,
      partitionSourceVerificationHash: SOURCE_VERIFICATION_HASH,
      reconciliationGeneration: RECONCILIATION_GENERATION,
      rollbackMonolithVerifiedAt: ROLLBACK_VERIFIED_AT,
    });

    expect(harness.query).toHaveBeenCalledTimes(1);
    const [rawSql, values] = harness.query.mock.calls[0] as [string, unknown[]];
    const sql = normalizeSql(rawSql);
    expect(values).toEqual([UNIVERSE_ID]);
    expectCurrentSuccessfulMonolithPin(sql);
    expect(sql).toContain('partition_head.active_manifest_id = manifest.id');
    expect(sql).toContain(
      'partition_head.active_configuration_version_id = configuration.id'
    );
    expect(sql).toContain(
      'source_generation.source_generation_id = manifest.source_generation_id'
    );
    expect(sql).toContain(
      'source_generation.source_verification_hash = manifest.source_verification_hash'
    );
    expect(sql).toContain("manifest.state = 'sealed'");
    expect(sql).toContain('manifest.omission_count = 0');
  });

  test('returns null when no complete live validation anchor exists', async () => {
    const harness = poolReturning([]);
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );

    await expect(repository.loadValidationAnchor(UNIVERSE_ID)).resolves.toBeNull();
  });

  test.each([
    ['a different universe', [validationAnchorRow({ universe_id: 'other-universe' })]],
    ['multiple live rows', [validationAnchorRow(), validationAnchorRow()]],
  ])('rejects an inconsistent validation anchor: %s', async (_label, rows) => {
    const harness = poolReturning(rows);
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );

    await expect(repository.loadValidationAnchor(UNIVERSE_ID)).rejects.toThrow(
      'Partition cutover validation anchor is inconsistent.'
    );
  });

  test('seals with one INSERT SELECT that revalidates every live anchor and never persists case content', async () => {
    const harness = poolReturning([{ universe_id: UNIVERSE_ID }]);
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );
    const privateCaseContent = 'private storyline content must never be stored';
    const input = {
      ...sealInput(),
      caseContent: privateCaseContent,
      cases: [{ prompt: privateCaseContent }],
    } as SealBackstageNotionPartitionCutoverEvidenceInput;

    await expect(repository.sealEvidence(input)).resolves.toBeUndefined();

    expect(harness.query).toHaveBeenCalledTimes(1);
    const [rawSql, values] = harness.query.mock.calls[0] as [string, unknown[]];
    const sql = normalizeSql(rawSql);
    expect(sql).toMatch(
      /^INSERT INTO public\.backstage_notion_partition_cutover_evidence \(.+\) SELECT /u
    );
    expect(sql).toContain(
      'JOIN public.backstage_notion_partition_configuration_versions AS configuration'
    );
    expect(sql).toContain(
      'JOIN public.backstage_notion_partition_source_generations AS source_generation'
    );
    expect(sql).toContain('rollback_snapshot.id = $2::UUID');
    expect(sql).toContain('manifest.id = $3::UUID');
    expect(sql).toContain('configuration.id = $4::UUID');
    expect(sql).toContain('configuration.configuration_hash = $5');
    expect(sql).toContain('manifest.source_generation_id = $6::UUID');
    expect(sql).toContain('manifest.source_digest = $7');
    expect(sql).toContain('manifest.source_verification_hash = $8');
    expect(sql).toContain(
      'partition_head.reconciliation_generation = $25::BIGINT'
    );
    expect(sql).toContain(
      'authority_head.last_verified_at = $26::TIMESTAMPTZ'
    );
    expect(sql).toContain('$27::TIMESTAMPTZ > $23::TIMESTAMPTZ');
    expect(sql).toContain(
      "$27::TIMESTAMPTZ <= $26::TIMESTAMPTZ + INTERVAL '7 days'"
    );
    expect(sql).toContain('LEAST(');
    expectCurrentSuccessfulMonolithPin(sql);
    expect(sql).toContain('ON CONFLICT (universe_id) DO UPDATE SET');
    expect(sql).toContain('RETURNING universe_id');
    expect(rawSql).not.toContain(privateCaseContent);
    expect(values).not.toContain(privateCaseContent);
    expect(JSON.stringify(values)).not.toContain('prompt');
    expect(values).toHaveLength(27);
    expect(values.slice(0, 8)).toEqual([
      UNIVERSE_ID,
      MONOLITH_SNAPSHOT_ID,
      MANIFEST_ID,
      CONFIGURATION_VERSION_ID,
      CONFIGURATION_HASH,
      SOURCE_GENERATION_ID,
      SOURCE_DIGEST,
      SOURCE_VERIFICATION_HASH,
    ]);
    expect(values.slice(-3)).toEqual([
      RECONCILIATION_GENERATION,
      ROLLBACK_VERIFIED_AT.toISOString(),
      ROLLBACK_VALID_UNTIL.toISOString(),
    ]);
  });

  test.each([
    ['zero total cases', { caseCount: 0 }],
    ['zero reconciliation generation', { reconciliationGeneration: 0 }],
    [
      'rollback verification after validation',
      { rollbackMonolithVerifiedAt: new Date('2026-08-30T12:00:00.000Z') },
    ],
    [
      'expired rollback validation',
      { rollbackMonolithValidUntil: VALIDATED_AT },
    ],
    [
      'rollback validation beyond seven days',
      { rollbackMonolithValidUntil: new Date('2026-09-06T11:55:00.001Z') },
    ],
    ['zero exact-scope cases', { exactScopeCaseCount: 0 }],
    ['zero relevant cases', { relevantCaseCount: 0 }],
    ['zero complete-scope cases', { completeScopeCaseCount: 0 }],
    ['zero cursor continuations', { cursorContinuationCaseCount: 0 }],
    ['too few monolith requests', { monolithRequestCount: 5 }],
    ['too few partition requests', { partitionRequestCount: 5 }],
    ['too few citations', { citationCount: 5 }],
    ['failed exact-scope parity', { exactScopeParityPassed: false }],
    ['failed relevant parity', { relevantRetrievalParityPassed: false }],
    ['failed complete-scope parity', { completeScopeParityPassed: false }],
    ['failed cursor stability', { cursorStabilityPassed: false }],
  ] as const)(
    'rejects invalid or non-passing evidence before querying: %s',
    async (_label, override) => {
      const harness = poolReturning([{ universe_id: UNIVERSE_ID }]);
      const repository =
        new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
          harness.pool
        );

      await expect(repository.sealEvidence(sealInput(
        override as Partial<SealBackstageNotionPartitionCutoverEvidenceInput>
      ))).rejects.toThrow();
      expect(harness.query).not.toHaveBeenCalled();
    }
  );

  test('rejects sealing when live revalidation returns no row for the original anchor', async () => {
    const harness = poolReturning([]);
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );

    await expect(repository.sealEvidence(sealInput())).rejects.toThrow(
      'Partition cutover evidence lost its exact validation anchor.'
    );
    expect(harness.query).toHaveBeenCalledTimes(1);
  });

  test('loads five pinned members and validates positive bounded attestation counts', async () => {
    const rows = SHARDS.map((_shard, index) => gateRow(index));
    const harness = poolReturning(rows);
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );

    const evidence = await repository.loadGateEvidence({
      universeId: UNIVERSE_ID,
      configurationHash: CONFIGURATION_HASH,
      configuredShardKeys: SHARDS.map(shard => shard.key),
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
    });

    expect(evidence).not.toBeNull();
    expect(evidence).toMatchObject({
      evidenceVersion: 1,
      universeId: UNIVERSE_ID,
      manifestId: MANIFEST_ID,
      activeManifestId: MANIFEST_ID,
      sourceGenerationId: SOURCE_GENERATION_ID,
      sourcePageCount: 366,
      sourceChunkCount: 2307,
      manifestPageCount: 366,
      manifestChunkCount: 2307,
      memberCount: 5,
      omissionCount: 0,
      reconciliationGeneration: RECONCILIATION_GENERATION,
      activeReconciliationGeneration: RECONCILIATION_GENERATION,
      publishedReconciliationGeneration: RECONCILIATION_GENERATION,
      leaseFencingClear: true,
      unresolvedActivationCount: 0,
      rollbackMonolithSnapshotId: MONOLITH_SNAPSHOT_ID,
      rollbackMonolithReadable: true,
      rollbackMonolithChunkCount: 4096,
      parity: {
        shadowComparisonCompleted: true,
        exactScopeParityPassed: true,
        relevantRetrievalParityPassed: true,
        completeScopeParityPassed: true,
        cursorStabilityPassed: true,
      },
    });
    expect(evidence?.members).toHaveLength(5);
    expect(evidence?.members.map(member => member.shardKey)).toEqual(
      SHARDS.map(shard => shard.key)
    );
    expect(evidence?.members.reduce(
      (sum, member) => sum + member.chunkCount,
      0
    )).toBe(2307);
    expect(harness.query).toHaveBeenCalledTimes(1);
    const [rawSql, values] = harness.query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([
      UNIVERSE_ID,
      CONFIGURATION_HASH,
      SHARDS.map(shard => shard.key),
      MAXIMUM_STALENESS_MS,
    ]);
    expect(normalizeSql(rawSql)).toContain(
      'FROM public.backstage_notion_partition_cutover_evidence AS evidence'
    );
    const sql = normalizeSql(rawSql);
    expectCurrentSuccessfulMonolithPin(sql);
    expect(sql).toContain(
      'evidence.rollback_validation_verified_at = authority_head.last_verified_at'
    );
    expect(sql).toContain(
      'evidence.expires_at <= evidence.rollback_validation_valid_until'
    );
    expect(sql).toContain('evidence.expires_at >= statement_timestamp()');
  });

  test('returns null when latest-sync or rollback-validation evidence is stale or expired', async () => {
    const harness = poolReturning([]);
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );

    await expect(repository.loadGateEvidence({
      universeId: UNIVERSE_ID,
      configurationHash: CONFIGURATION_HASH,
      configuredShardKeys: SHARDS.map(shard => shard.key),
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
    })).resolves.toBeNull();

    const [rawSql] = harness.query.mock.calls[0] as [string, unknown[]];
    const sql = normalizeSql(rawSql);
    expectCurrentSuccessfulMonolithPin(sql);
    expect(sql).toContain(
      'evidence.rollback_validation_verified_at = authority_head.last_verified_at'
    );
    expect(sql).toContain('evidence.expires_at >= statement_timestamp()');
  });

  test.each([
    [
      'a malformed shard snapshot identifier',
      SHARDS.map((_shard, index) => gateRow(index,
        index === 2 ? { shard_snapshot_id: 'not-a-uuid' } : {})),
    ],
    [
      'a repeated shard row',
      [gateRow(0), gateRow(0), ...SHARDS.slice(2).map((_shard, index) => (
        gateRow(index + 2)
      ))],
    ],
    [
      'mismatched evidence and active reconciliation generations',
      SHARDS.map((_shard, index) => gateRow(index, {
        active_reconciliation_generation: '13',
        published_reconciliation_generation: '13',
      })),
    ],
    [
      'an unpublished reconciliation generation',
      SHARDS.map((_shard, index) => gateRow(index, {
        published_reconciliation_generation: '11',
      })),
    ],
    [
      'mixed repeated manifest and configuration fields',
      SHARDS.map((_shard, index) => gateRow(index,
        index === 4
          ? {
            manifest_id: '66666666-6666-4666-8666-666666666666',
            configuration_hash: '9'.repeat(64),
          }
          : {})),
    ],
    [
      'mixed repeated source-coverage fields',
      SHARDS.map((_shard, index) => gateRow(index,
        index === 4
          ? {
            source_digest: '8'.repeat(64),
            source_page_count: '365',
            source_verified_at: new Date('2026-08-30T11:49:00.000Z'),
          }
          : {})),
    ],
    [
      'mixed repeated attestation fields',
      SHARDS.map((_shard, index) => gateRow(index,
        index === 4
          ? {
            case_count: '7',
            validated_at: new Date('2026-08-30T11:58:00.000Z'),
            attestation_digest: '7'.repeat(64),
          }
          : {})),
    ],
  ])('rejects malformed or mixed gate rows: %s', async (_label, rows) => {
    const harness = poolReturning(rows);
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );

    await expect(repository.loadGateEvidence({
      universeId: UNIVERSE_ID,
      configurationHash: CONFIGURATION_HASH,
      configuredShardKeys: SHARDS.map(shard => shard.key),
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
    })).rejects.toThrow();
  });

  test.each([
    ['zero cases', { case_count: '0' }],
    ['zero citations', { citation_count: '0' }],
    ['inconsistent case categories', { exact_scope_case_count: '3' }],
  ])('rejects malformed gate attestation counts: %s', async (_label, override) => {
    const harness = poolReturning(
      SHARDS.map((_shard, index) => gateRow(index, override))
    );
    const repository = new PostgresBackstageNotionPartitionCutoverEvidenceRepository(
      harness.pool
    );

    await expect(repository.loadGateEvidence({
      universeId: UNIVERSE_ID,
      configurationHash: CONFIGURATION_HASH,
      configuredShardKeys: SHARDS.map(shard => shard.key),
      maximumStalenessMs: MAXIMUM_STALENESS_MS,
    })).rejects.toThrow();
  });
});

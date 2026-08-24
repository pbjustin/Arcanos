import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { BACKSTAGE_NOTION_PARTITION_STORAGE_TABLE_DEFINITIONS } from '../src/core/db/backstageNotionPartitionStorageSchema.js';

const forwardMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260824_backstage_notion_partition_storage_v1.sql'
  ),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260824_backstage_notion_partition_storage_v1.rollback.sql'
  ),
  'utf8'
);
const runtimeSql = BACKSTAGE_NOTION_PARTITION_STORAGE_TABLE_DEFINITIONS.join('\n');

const dedicatedTables = [
  'backstage_notion_partition_configuration_versions',
  'backstage_notion_partition_identities',
  'backstage_notion_partition_versions',
  'backstage_notion_partition_configuration_members',
  'backstage_notion_chunk_versions',
  'backstage_notion_chunk_embeddings',
  'backstage_notion_page_versions',
  'backstage_notion_page_version_chunks',
  'backstage_notion_shard_snapshots',
  'backstage_notion_shard_snapshot_pages',
  'backstage_notion_shard_snapshot_chunk_occurrences',
  'backstage_notion_shard_snapshot_verifications',
  'backstage_notion_shard_heads',
  'backstage_notion_shard_sync_leases',
  'backstage_notion_provider_coordinator_leases',
  'backstage_notion_universe_manifests',
  'backstage_notion_universe_manifest_shards',
  'backstage_notion_universe_manifest_omissions',
  'backstage_notion_manifest_page_ownership',
  'backstage_notion_partitioned_universe_heads',
] as const;

const normalizeSql = (value: string): string =>
  value
    .replace(/^\s*--.*$/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim();

describe('Backstage Notion partition storage database contract', () => {
  it('keeps the runtime bootstrap byte-semantics aligned with the migration', () => {
    expect(normalizeSql(runtimeSql)).toBe(normalizeSql(forwardMigration));
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration],
  ])('%s creates the complete additive shadow topology', (_label, sql) => {
    for (const table of dedicatedTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }

    expect(sql).toContain(
      'UNIQUE (universe_id, configuration_generation)'
    );
    expect(sql).toContain(
      'partition_configuration_version_id UUID NOT NULL'
    );
    expect(sql).toContain(
      'desired_configuration_version_id UUID NOT NULL'
    );
    expect(sql).toContain('active_configuration_version_id UUID');
    expect(sql).toContain(
      'PRIMARY KEY (universe_id, manifest_id, page_id)'
    );
    expect(sql).toContain("decision IN ('fresh', 'retained_last_known_good')");
    expect(sql).toContain(
      "decision IN ('optional_unavailable', 'optional_disabled')"
    );
    expect(sql).toContain('max_chunks BETWEEN 1 AND 2048');
    expect(sql).not.toMatch(/chunk_count\s+BETWEEN\s+1\s+AND\s+2048[\s\S]*universe-wide/iu);

    const semanticDefinitions = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_versions'),
      sql.indexOf(
        'CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_configuration_members'
      )
    );
    expect(semanticDefinitions).toContain(
      'UNIQUE (universe_id, shard_key, semantic_hash)'
    );
    expect(semanticDefinitions).not.toContain('partition_configuration_version_id');
    expect(semanticDefinitions).not.toContain('configuration_generation');
    expect(sql).toContain(
      'PRIMARY KEY (universe_id, partition_configuration_version_id, shard_key)'
    );
    expect(sql).toContain(
      'UNIQUE (universe_id, partition_configuration_version_id, root_page_id)'
    );
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration],
  ])('%s pins reusable embeddings without pgvector or JSON arrays', (_label, sql) => {
    expect(sql).toContain('embedding DOUBLE PRECISION[] NOT NULL');
    expect(sql).toContain('pg_catalog.array_ndims(embedding) <> 1');
    expect(sql).toContain('pg_catalog.cardinality(embedding) <> expected_dimension');
    expect(sql).toContain('coordinate >= \'Infinity\'::DOUBLE PRECISION');
    expect(sql).toContain('coordinate = \'NaN\'::DOUBLE PRECISION');
    expect(sql).toContain(
      'squared_norm := squared_norm + (coordinate::NUMERIC * coordinate::NUMERIC)'
    );
    expect(sql).toContain('recomputed_norm - expected_norm');
    expect(sql).not.toMatch(/\bvector\b|pgvector/iu);
    expect(sql).not.toContain('embedding JSONB');
    expect(sql).not.toMatch(/CREATE\s+EXTENSION/iu);

    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_snapshot_chunk_occurrences'
    );
    expect(sql).toContain(
      'REFERENCES public.backstage_notion_page_version_chunks('
    );
    expect(sql).toContain(
      'REFERENCES public.backstage_notion_chunk_embeddings('
    );
    expect(sql).toContain('embedding_model TEXT NOT NULL');
    expect(sql).toContain('embedding_version INTEGER NOT NULL');
    expect(sql.match(/embedding_dimension INTEGER NOT NULL/gu)).toHaveLength(3);
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_backstage_notion_chunk_versions_lexical'
    );
    expect(sql).toContain(
      "USING GIN (pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, content))"
    );
    expect(sql).toContain(
      'embedding.embedding_dimension <> NEW.embedding_dimension'
    );
    expect(sql).toContain(
      'snapshot.embedding_model <> NEW.embedding_model'
    );
    expect(sql).toContain(
      'snapshot.embedding_version <> NEW.embedding_version'
    );
    expect(sql).toContain(
      'snapshot.embedding_dimension <> NEW.embedding_dimension'
    );
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration],
  ])('%s stores bounded immutable retrieval scope metadata', (_label, sql) => {
    expect(sql).toContain('scope_path JSONB NOT NULL');
    expect(sql).toContain('scope_title_key TEXT NOT NULL');
    expect(sql).toContain('scope_path_key JSONB NOT NULL');
    expect(sql).toContain('scope_heading_path_key JSONB NOT NULL');
    expect(sql).toContain('heading_occurrence_path JSONB NOT NULL');
    expect(sql).toContain(
      'backstage_notion_page_scope_metadata_is_valid('
    );
    expect(sql).toContain(
      'backstage_notion_heading_occurrence_path_is_valid('
    );
    expect(sql).toContain(
      "scope_path ->> depth IS DISTINCT FROM title"
    );
    expect(sql).toContain(
      "scope_path_key ->> depth IS DISTINCT FROM scope_title_key"
    );
    expect(sql).toContain(
      "WHEN (entry.value #>> '{}') !~ '^(0|[1-9][0-9]{0,3})$' THEN TRUE"
    );
    const pageChunkDefinition = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS public.backstage_notion_page_version_chunks'),
      sql.indexOf('CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_snapshots')
    );
    const snapshotOccurrenceDefinition = sql.slice(
      sql.indexOf(
        'CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_snapshot_chunk_occurrences'
      ),
      sql.indexOf(
        'CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_snapshot_verifications'
      )
    );
    expect(pageChunkDefinition).not.toContain('category TEXT NOT NULL');
    expect(snapshotOccurrenceDefinition).toContain('category TEXT NOT NULL');
    for (const category of [
      'championships',
      'events',
      'general',
      'kayfabe',
      'nxt',
      'raw',
      'roster',
      'smackdown',
      'storylines',
    ]) {
      expect(snapshotOccurrenceDefinition).toContain(`'${category}'`);
    }
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_snapshot_pages_scope_title'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_snapshot_pages_scope_path'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_backstage_notion_page_chunks_scope_heading'
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_occurrences_category'
    );
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration],
  ])('%s seals parents and rejects child mutations after sealing', (_label, sql) => {
    expect(sql).toContain('backstage_notion_guard_partition_configuration_seal');
    expect(sql).toContain('backstage_notion_guard_page_version_seal');
    expect(sql).toContain('backstage_notion_guard_shard_snapshot_seal');
    expect(sql).toContain('backstage_notion_guard_universe_manifest_seal');
    expect(sql).toContain('backstage_notion_require_building_insert');
    expect(sql).toContain('backstage_notion_guard_page_chunk_mutation');
    expect(sql).toContain(
      'backstage_notion_guard_shard_snapshot_child_mutation'
    );
    expect(sql).toContain(
      'backstage_notion_guard_universe_manifest_child_mutation'
    );
    expect(sql).toContain(
      'may only be inserted while the snapshot is building'
    );
    expect(sql).toContain(
      'may only be inserted while the manifest is building'
    );
    expect(sql).toContain(
      'partition configuration memberships may only be inserted while their configuration is building'
    );
    expect(sql.match(/FOR SHARE;/gu)).toHaveLength(7);
    expect(sql).toContain('INTO actual_configuration_member_count');
    expect(sql).toContain('INTO uncovered_configuration_member_count');
    expect(sql).not.toContain('actual_head_count');
    expect(sql).not.toContain('uncovered_head_count');
    const omissionValidation = sql.slice(
      sql.indexOf('INTO invalid_omission_count'),
      sql.indexOf('INTO uncovered_configuration_member_count')
    );
    expect(omissionValidation).toContain(
      'configured_member.partition_version_id IS NULL'
    );
    expect(omissionValidation).not.toContain('backstage_notion_shard_heads');
    expect(omissionValidation).not.toContain('head.current_partition_version_id');
    expect(sql).toContain('actual_occurrence_count <> NEW.chunk_count');
    expect(sql).toContain('actual_ownership_count <> NEW.page_count');
    expect(sql).toContain('source_drift_verification_count <> 1');
    expect(sql).toContain('completeness_verification_count <> 1');
    expect(sql).toContain(
      'child.path <> pg_catalog.jsonb_build_array(NEW.root_page_id::TEXT)'
    );
    expect(sql).toContain(
      'child.path - (pg_catalog.jsonb_array_length(child.path) - 1)'
    );
    expect(sql).toContain('invalid_path_count <> 0');
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration],
  ])('%s fences heads, leases, dependencies, and function search paths', (_label, sql) => {
    expect(sql).toContain('backstage_notion_guard_shard_head');
    expect(sql).toContain('backstage_notion_guard_partitioned_universe_head');
    expect(sql).toContain('shard head compare-and-swap generation is stale');
    expect(sql).toContain(
      'partitioned universe head compare-and-swap generation is stale'
    );
    expect(sql).toContain(
      'can only reference a sealed snapshot for its current definition'
    );
    expect(sql).toContain(
      'can only reference a sealed exact manifest'
    );
    expect(sql).toContain('shard head pointers require active Notion authority');
    expect(sql).toContain('universe manifests require active Notion authority');
    expect(sql).toContain('backstage_notion_guard_lease_fencing');
    expect(sql).toContain('backstage_notion_partition_reject_immutable_mutation');
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION public.backstage_notion_reject_immutable_mutation()'
    );
    expect(sql).toContain('an unexpired lease cannot be taken over or rotated');
    expect(sql).not.toMatch(/ON\s+(?:UPDATE|DELETE)\s+CASCADE/iu);
    expect(sql).not.toMatch(/ON\s+DELETE\s+SET\s+NULL/iu);

    const functions = sql.match(
      /CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/gu
    );
    expect(functions).not.toBeNull();
    for (const definition of functions ?? []) {
      expect(definition).toContain('SET search_path = pg_catalog, public');
    }
  });

  it('keeps rollback empty-only, guarded, dependency-safe, and reversible', () => {
    for (const table of dedicatedTables) {
      expect(rollbackMigration).toContain(`'${table}'`);
      expect(rollbackMigration).toContain(`DROP TABLE IF EXISTS public.${table}`);
    }
    expect(rollbackMigration).toContain('IN ACCESS EXCLUSIVE MODE');
    expect(rollbackMigration).toContain(
      'partition storage rollback refused because public.%I is populated'
    );
    expect(rollbackMigration).toContain("ERRCODE = '55000'");
    expect(rollbackMigration).not.toContain('CASCADE');
    expect(rollbackMigration).toContain(
      'DROP FUNCTION IF EXISTS public.backstage_notion_embedding_values_are_valid('
    );
    expect(rollbackMigration).toContain(
      'DROP FUNCTION IF EXISTS public.backstage_notion_page_scope_metadata_is_valid('
    );
    expect(rollbackMigration).toContain(
      'DROP FUNCTION IF EXISTS public.backstage_notion_heading_occurrence_path_is_valid('
    );
    expect(rollbackMigration).toContain(
      'DROP FUNCTION IF EXISTS public.backstage_notion_scope_key_array_is_valid('
    );
    expect(rollbackMigration).toContain(
      'DROP FUNCTION IF EXISTS public.backstage_notion_partition_reject_immutable_mutation()'
    );
    expect(rollbackMigration).not.toContain(
      'DROP FUNCTION IF EXISTS public.backstage_notion_reject_immutable_mutation()'
    );
    expect(rollbackMigration.trim().endsWith('COMMIT;')).toBe(true);
  });
});

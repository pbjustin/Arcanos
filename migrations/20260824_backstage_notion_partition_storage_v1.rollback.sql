BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $block$
DECLARE
  table_name TEXT;
  has_rows BOOLEAN;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'backstage_notion_chunk_embeddings',
    'backstage_notion_chunk_versions',
    'backstage_notion_manifest_page_ownership',
    'backstage_notion_page_version_chunks',
    'backstage_notion_page_versions',
    'backstage_notion_partition_configuration_members',
    'backstage_notion_partition_configuration_versions',
    'backstage_notion_partition_identities',
    'backstage_notion_partition_versions',
    'backstage_notion_partitioned_universe_heads',
    'backstage_notion_provider_coordinator_leases',
    'backstage_notion_shard_heads',
    'backstage_notion_shard_snapshot_chunk_occurrences',
    'backstage_notion_shard_snapshot_pages',
    'backstage_notion_shard_snapshot_verifications',
    'backstage_notion_shard_snapshots',
    'backstage_notion_shard_sync_leases',
    'backstage_notion_universe_manifest_omissions',
    'backstage_notion_universe_manifest_shards',
    'backstage_notion_universe_manifests'
  ] LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',
        table_name
      );
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'backstage_notion_chunk_embeddings',
    'backstage_notion_chunk_versions',
    'backstage_notion_manifest_page_ownership',
    'backstage_notion_page_version_chunks',
    'backstage_notion_page_versions',
    'backstage_notion_partition_configuration_members',
    'backstage_notion_partition_configuration_versions',
    'backstage_notion_partition_identities',
    'backstage_notion_partition_versions',
    'backstage_notion_partitioned_universe_heads',
    'backstage_notion_provider_coordinator_leases',
    'backstage_notion_shard_heads',
    'backstage_notion_shard_snapshot_chunk_occurrences',
    'backstage_notion_shard_snapshot_pages',
    'backstage_notion_shard_snapshot_verifications',
    'backstage_notion_shard_snapshots',
    'backstage_notion_shard_sync_leases',
    'backstage_notion_universe_manifest_omissions',
    'backstage_notion_universe_manifest_shards',
    'backstage_notion_universe_manifests'
  ] LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)',
        table_name
      ) INTO has_rows;

      IF has_rows THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = pg_catalog.format(
            'partition storage rollback refused because public.%I is populated',
            table_name
          );
      END IF;
    END IF;
  END LOOP;
END;
$block$;

DROP TABLE IF EXISTS public.backstage_notion_partitioned_universe_heads;
DROP TABLE IF EXISTS public.backstage_notion_manifest_page_ownership;
DROP TABLE IF EXISTS public.backstage_notion_universe_manifest_omissions;
DROP TABLE IF EXISTS public.backstage_notion_universe_manifest_shards;
DROP TABLE IF EXISTS public.backstage_notion_universe_manifests;
DROP TABLE IF EXISTS public.backstage_notion_shard_sync_leases;
DROP TABLE IF EXISTS public.backstage_notion_shard_heads;
DROP TABLE IF EXISTS public.backstage_notion_shard_snapshot_verifications;
DROP TABLE IF EXISTS public.backstage_notion_shard_snapshot_chunk_occurrences;
DROP TABLE IF EXISTS public.backstage_notion_shard_snapshot_pages;
DROP TABLE IF EXISTS public.backstage_notion_shard_snapshots;
DROP TABLE IF EXISTS public.backstage_notion_page_version_chunks;
DROP TABLE IF EXISTS public.backstage_notion_page_versions;
DROP TABLE IF EXISTS public.backstage_notion_chunk_embeddings;
DROP TABLE IF EXISTS public.backstage_notion_chunk_versions;
DROP TABLE IF EXISTS public.backstage_notion_partition_configuration_members;
DROP TABLE IF EXISTS public.backstage_notion_partition_versions;
DROP TABLE IF EXISTS public.backstage_notion_partition_identities;
DROP TABLE IF EXISTS public.backstage_notion_partition_configuration_versions;
DROP TABLE IF EXISTS public.backstage_notion_provider_coordinator_leases;

DROP FUNCTION IF EXISTS public.backstage_notion_guard_lease_fencing();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_partitioned_universe_head();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_shard_head();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_universe_manifest_seal();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_universe_manifest_child_mutation();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_shard_snapshot_seal();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_shard_snapshot_child_mutation();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_page_chunk_mutation();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_page_version_seal();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_partition_configuration_member_mutation();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_partition_configuration_seal();
DROP FUNCTION IF EXISTS public.backstage_notion_require_building_insert();
DROP FUNCTION IF EXISTS public.backstage_notion_partition_reject_immutable_mutation();
DROP FUNCTION IF EXISTS public.backstage_notion_page_scope_metadata_is_valid(
  TEXT,
  INTEGER,
  JSONB,
  TEXT,
  JSONB
);
DROP FUNCTION IF EXISTS public.backstage_notion_heading_occurrence_path_is_valid(
  JSONB,
  INTEGER
);
DROP FUNCTION IF EXISTS public.backstage_notion_scope_key_array_is_valid(
  JSONB,
  INTEGER
);
DROP FUNCTION IF EXISTS public.backstage_notion_embedding_values_are_valid(
  DOUBLE PRECISION[],
  INTEGER,
  DOUBLE PRECISION
);
DROP FUNCTION IF EXISTS public.backstage_notion_partition_tags_are_valid(JSONB);

COMMIT;

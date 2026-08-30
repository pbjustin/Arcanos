-- Safe compensation: remove only the additive enforcement hooks. Provenance
-- columns and any immutable evidence are intentionally retained.
BEGIN;

DROP TRIGGER IF EXISTS backstage_notion_immutable_guard
  ON public.backstage_notion_partition_source_generations;

DROP TRIGGER IF EXISTS backstage_notion_active_manifest_source_generation_guard
  ON public.backstage_notion_partitioned_universe_heads;
DROP TRIGGER IF EXISTS backstage_notion_manifest_source_generation_guard
  ON public.backstage_notion_universe_manifests;
DROP TRIGGER IF EXISTS backstage_notion_shard_source_generation_guard
  ON public.backstage_notion_shard_snapshots;

DROP FUNCTION IF EXISTS public.backstage_notion_guard_active_manifest_source_generation();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_manifest_source_generation();
DROP FUNCTION IF EXISTS public.backstage_notion_guard_shard_source_generation();

COMMIT;

-- Add truthful, non-backfilled provenance for new partition generations.
BEGIN;

ALTER TABLE public.backstage_notion_shard_snapshots
  ADD COLUMN IF NOT EXISTS source_generation_id UUID;

ALTER TABLE public.backstage_notion_universe_manifests
  ADD COLUMN IF NOT EXISTS source_generation_id UUID,
  ADD COLUMN IF NOT EXISTS source_digest TEXT,
  ADD COLUMN IF NOT EXISTS source_page_count INTEGER,
  ADD COLUMN IF NOT EXISTS source_chunk_count INTEGER,
  ADD COLUMN IF NOT EXISTS source_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_verification_hash TEXT;

CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_source_generations (
  universe_id TEXT NOT NULL,
  source_generation_id UUID NOT NULL,
  partition_configuration_version_id UUID NOT NULL,
  source_digest TEXT NOT NULL,
  source_page_count INTEGER NOT NULL,
  source_chunk_count INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  source_verified_at TIMESTAMPTZ NOT NULL,
  source_verification_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, source_generation_id),
  UNIQUE (
    universe_id,
    source_generation_id,
    partition_configuration_version_id,
    source_digest,
    source_page_count,
    source_chunk_count,
    source_verified_at,
    source_verification_hash
  ),
  FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, partition_configuration_version_id)
    REFERENCES public.backstage_notion_partition_configuration_versions(universe_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  CHECK (source_verification_hash ~ '^[0-9a-f]{64}$'),
  CHECK (source_page_count > 0),
  CHECK (source_chunk_count > 0),
  CHECK (member_count BETWEEN 1 AND 512),
  CHECK (pg_catalog.isfinite(source_verified_at)),
  CHECK (pg_catalog.isfinite(created_at))
);

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.backstage_notion_universe_manifests'::pg_catalog.regclass
      AND conname = 'backstage_notion_universe_manifests_source_generation_fkey'
  ) THEN
    ALTER TABLE public.backstage_notion_universe_manifests
      ADD CONSTRAINT backstage_notion_universe_manifests_source_generation_fkey
      FOREIGN KEY (
        universe_id,
        source_generation_id,
        partition_configuration_version_id,
        source_digest,
        source_page_count,
        source_chunk_count,
        source_verified_at,
        source_verification_hash
      ) REFERENCES public.backstage_notion_partition_source_generations(
        universe_id,
        source_generation_id,
        partition_configuration_version_id,
        source_digest,
        source_page_count,
        source_chunk_count,
        source_verified_at,
        source_verification_hash
      ) ON UPDATE RESTRICT ON DELETE RESTRICT
      NOT VALID;
  END IF;
END;
$block$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_shard_source_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.state = 'sealed' AND NEW.source_generation_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'sealed shard snapshot requires source generation evidence';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_manifest_source_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  invalid_member_count BIGINT;
BEGIN
  IF NEW.state <> 'sealed' THEN
    RETURN NEW;
  END IF;

  SELECT pg_catalog.count(*)
  INTO invalid_member_count
  FROM public.backstage_notion_universe_manifest_shards AS member
  JOIN public.backstage_notion_shard_snapshots AS snapshot
    ON snapshot.universe_id = member.universe_id
   AND snapshot.shard_key = member.shard_key
   AND snapshot.id = member.shard_snapshot_id
  WHERE member.universe_id = NEW.universe_id
    AND member.manifest_id = NEW.id
    AND (
      member.decision <> 'fresh'
      OR snapshot.state <> 'sealed'
      OR snapshot.source_generation_id IS DISTINCT FROM NEW.source_generation_id
      OR member.verified_at > NEW.source_verified_at
    );

  IF NEW.source_generation_id IS NULL
     OR NEW.source_digest IS NULL
     OR NEW.source_digest !~ '^[0-9a-f]{64}$'
     OR NEW.source_page_count IS DISTINCT FROM NEW.page_count
     OR NEW.source_chunk_count IS DISTINCT FROM NEW.chunk_count
     OR NEW.source_verified_at IS NULL
     OR NOT pg_catalog.isfinite(NEW.source_verified_at)
     OR NEW.source_verification_hash IS NULL
     OR NEW.source_verification_hash !~ '^[0-9a-f]{64}$'
     OR invalid_member_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'sealed universe manifest requires one verified source generation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_active_manifest_source_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.active_manifest_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.active_manifest_id IS DISTINCT FROM OLD.active_manifest_id) THEN
    PERFORM 1
    FROM public.backstage_notion_universe_manifests AS manifest
    WHERE manifest.universe_id = NEW.universe_id
      AND manifest.id = NEW.active_manifest_id
      AND manifest.state = 'sealed'
      AND manifest.source_generation_id IS NOT NULL
      AND manifest.source_digest ~ '^[0-9a-f]{64}$'
      AND manifest.source_page_count = manifest.page_count
      AND manifest.source_chunk_count = manifest.chunk_count
      AND manifest.source_verified_at IS NOT NULL
      AND pg_catalog.isfinite(manifest.source_verified_at)
      AND manifest.source_verification_hash ~ '^[0-9a-f]{64}$'
      AND NOT EXISTS (
        SELECT 1
        FROM public.backstage_notion_universe_manifest_shards AS member
        JOIN public.backstage_notion_shard_snapshots AS snapshot
          ON snapshot.universe_id = member.universe_id
         AND snapshot.shard_key = member.shard_key
         AND snapshot.id = member.shard_snapshot_id
        WHERE member.universe_id = manifest.universe_id
          AND member.manifest_id = manifest.id
          AND (
            member.decision <> 'fresh'
            OR snapshot.state <> 'sealed'
            OR snapshot.source_generation_id IS DISTINCT FROM manifest.source_generation_id
            OR member.verified_at > manifest.source_verified_at
          )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'active partition manifest requires one verified source generation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.backstage_notion_shard_snapshots'::pg_catalog.regclass
      AND tgname = 'backstage_notion_shard_source_generation_guard'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER backstage_notion_shard_source_generation_guard
      BEFORE UPDATE ON public.backstage_notion_shard_snapshots
      FOR EACH ROW EXECUTE FUNCTION public.backstage_notion_guard_shard_source_generation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.backstage_notion_partition_source_generations'::pg_catalog.regclass
      AND tgname = 'backstage_notion_immutable_guard'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER backstage_notion_immutable_guard
      BEFORE UPDATE OR DELETE ON public.backstage_notion_partition_source_generations
      FOR EACH ROW EXECUTE FUNCTION public.backstage_notion_partition_reject_immutable_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.backstage_notion_universe_manifests'::pg_catalog.regclass
      AND tgname = 'backstage_notion_manifest_source_generation_guard'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER backstage_notion_manifest_source_generation_guard
      BEFORE UPDATE ON public.backstage_notion_universe_manifests
      FOR EACH ROW EXECUTE FUNCTION public.backstage_notion_guard_manifest_source_generation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.backstage_notion_partitioned_universe_heads'::pg_catalog.regclass
      AND tgname = 'backstage_notion_active_manifest_source_generation_guard'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER backstage_notion_active_manifest_source_generation_guard
      BEFORE INSERT OR UPDATE ON public.backstage_notion_partitioned_universe_heads
      FOR EACH ROW EXECUTE FUNCTION public.backstage_notion_guard_active_manifest_source_generation();
  END IF;
END;
$block$;

COMMIT;

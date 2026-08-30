BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_partitioned_universe_head()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  desired_state TEXT;
  manifest_state TEXT;
  manifest_configuration_version_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'partitioned universe heads cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.universe_id IS DISTINCT FROM OLD.universe_id THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'partitioned universe head identity is immutable';
    END IF;

    IF OLD.active_manifest_id IS NOT NULL AND NEW.active_manifest_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'last-known-good universe manifests cannot be cleared';
    END IF;

    IF NEW.desired_configuration_version_id IS DISTINCT FROM OLD.desired_configuration_version_id
       OR NEW.desired_configuration_generation IS DISTINCT FROM OLD.desired_configuration_generation
       OR NEW.desired_configuration_hash IS DISTINCT FROM OLD.desired_configuration_hash
       OR NEW.active_manifest_id IS DISTINCT FROM OLD.active_manifest_id
       OR NEW.active_configuration_version_id IS DISTINCT FROM OLD.active_configuration_version_id THEN
      IF NEW.head_generation <> OLD.head_generation + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'partitioned universe head compare-and-swap generation is stale';
      END IF;
    ELSIF NEW.head_generation <> OLD.head_generation THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'universe head generation cannot advance without a pointer change';
    END IF;

    IF NEW.active_manifest_id IS DISTINCT FROM OLD.active_manifest_id THEN
      IF NEW.manifest_generation <> OLD.manifest_generation + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'universe manifest generation is stale';
      END IF;
      IF NEW.active_configuration_version_id IS DISTINCT FROM NEW.desired_configuration_version_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'a newly activated manifest must match the desired configuration';
      END IF;
    ELSIF NEW.manifest_generation <> OLD.manifest_generation THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'manifest generation cannot advance without a manifest change';
    END IF;
  ELSIF NEW.active_manifest_id IS NULL THEN
    IF NEW.head_generation <> 0 OR NEW.manifest_generation <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an empty universe head starts at generation zero';
    END IF;
  ELSE
    IF NEW.head_generation <> 1 OR NEW.manifest_generation <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an initialized universe head starts at generation one';
    END IF;
    IF NEW.active_configuration_version_id IS DISTINCT FROM NEW.desired_configuration_version_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'an initially active manifest must match the desired configuration';
    END IF;
  END IF;

  SELECT configuration.state
  INTO desired_state
  FROM public.backstage_notion_partition_configuration_versions AS configuration
  WHERE configuration.universe_id = NEW.universe_id
    AND configuration.id = NEW.desired_configuration_version_id
    AND configuration.configuration_generation = NEW.desired_configuration_generation
    AND configuration.configuration_hash = NEW.desired_configuration_hash
  FOR KEY SHARE;

  IF desired_state IS DISTINCT FROM 'sealed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'desired partition configuration must be sealed';
  END IF;

  IF NEW.active_manifest_id IS NOT NULL THEN
    SELECT manifest.state, manifest.partition_configuration_version_id
    INTO manifest_state, manifest_configuration_version_id
    FROM public.backstage_notion_universe_manifests AS manifest
    WHERE manifest.universe_id = NEW.universe_id
      AND manifest.id = NEW.active_manifest_id
    FOR KEY SHARE;

    IF manifest_state IS DISTINCT FROM 'sealed'
       OR manifest_configuration_version_id IS DISTINCT FROM NEW.active_configuration_version_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'partitioned universe head can only reference a sealed exact manifest';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;

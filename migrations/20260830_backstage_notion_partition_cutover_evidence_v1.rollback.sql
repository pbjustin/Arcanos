BEGIN;

DO $$
BEGIN
  IF pg_catalog.to_regclass(
    'public.backstage_notion_partition_cutover_evidence'
  ) IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.backstage_notion_partition_cutover_evidence
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'cutover evidence rollback refused because verified evidence exists';
  END IF;
END
$$;

DROP TABLE IF EXISTS public.backstage_notion_partition_cutover_evidence;

ALTER TABLE public.backstage_notion_partitioned_universe_heads
  DROP COLUMN IF EXISTS published_reconciliation_generation,
  DROP COLUMN IF EXISTS reconciliation_generation;

COMMIT;

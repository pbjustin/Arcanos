-- V2 prevents an older already-running sync worker from activating a lower-format
-- snapshot after a newer worker has advanced the active Notion RAG index.

BEGIN;

CREATE OR REPLACE FUNCTION backstage_notion_snapshot_index_version(
  target_universe_id TEXT,
  target_snapshot_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_page_count INTEGER;
  actual_page_count BIGINT;
  distinct_marker_count BIGINT;
  derived_index_version INTEGER;
BEGIN
  SELECT snapshot.page_count
    INTO expected_page_count
    FROM public.backstage_notion_snapshots AS snapshot
    WHERE snapshot.universe_id = target_universe_id
      AND snapshot.id = target_snapshot_id;

  IF expected_page_count IS NULL THEN
    RAISE EXCEPTION 'Backstage Notion snapshot index version cannot be derived from an unknown snapshot'
      USING ERRCODE = 'BN002';
  END IF;

  SELECT
    COUNT(*),
    COUNT(DISTINCT page_marker.index_version),
    MIN(page_marker.index_version)
    INTO actual_page_count, distinct_marker_count, derived_index_version
    FROM (
      SELECT CASE
        WHEN jsonb_typeof(page.metadata -> 'indexFormat') = 'string'
          AND (page.metadata ->> 'indexFormat')
            ~ '^backstage-notion-rag-index-v(0|[1-9][0-9]{0,8})$'
        THEN substring(
          page.metadata ->> 'indexFormat'
          FROM '^backstage-notion-rag-index-v([0-9]+)$'
        )::INTEGER
        ELSE 0
      END AS index_version
      FROM public.backstage_notion_snapshot_pages AS page
      WHERE page.universe_id = target_universe_id
        AND page.snapshot_id = target_snapshot_id
    ) AS page_marker;

  IF actual_page_count IS DISTINCT FROM expected_page_count::BIGINT THEN
    RAISE EXCEPTION 'Backstage Notion snapshot page inventory is incomplete for index activation'
      USING ERRCODE = 'BN002';
  END IF;
  IF distinct_marker_count IS DISTINCT FROM 1::BIGINT THEN
    RAISE EXCEPTION 'Backstage Notion snapshot contains mixed index format markers'
      USING ERRCODE = 'BN002';
  END IF;

  RETURN derived_index_version;
END
$$;

CREATE OR REPLACE FUNCTION backstage_notion_guard_index_version_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_index_version INTEGER := 0;
  candidate_index_version INTEGER;
BEGIN
  IF NEW.active_snapshot_id IS NOT DISTINCT FROM OLD.active_snapshot_id THEN
    RETURN NEW;
  END IF;
  IF NEW.active_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'Backstage Notion active snapshot cannot be cleared across the index version fence'
      USING ERRCODE = 'BN002';
  END IF;

  candidate_index_version := public.backstage_notion_snapshot_index_version(
    NEW.universe_id,
    NEW.active_snapshot_id
  );
  IF OLD.active_snapshot_id IS NOT NULL THEN
    current_index_version := public.backstage_notion_snapshot_index_version(
      OLD.universe_id,
      OLD.active_snapshot_id
    );
  END IF;

  IF candidate_index_version < current_index_version THEN
    RAISE EXCEPTION 'Backstage Notion index version downgrade rejected (% to %)',
      current_index_version,
      candidate_index_version
      USING ERRCODE = 'BN002';
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  existing_trigger_function OID;
  existing_trigger_type SMALLINT;
  existing_trigger_enabled "char";
  existing_trigger_columns TEXT;
  existing_trigger_when TEXT;
BEGIN
  LOCK TABLE backstage_notion_universe_heads IN SHARE ROW EXCLUSIVE MODE;
  SELECT
    trigger_row.tgfoid,
    trigger_row.tgtype,
    trigger_row.tgenabled,
    trigger_row.tgattr::TEXT,
    pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid)
    INTO
      existing_trigger_function,
      existing_trigger_type,
      existing_trigger_enabled,
      existing_trigger_columns,
      existing_trigger_when
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'backstage_notion_universe_heads'::regclass
      AND trigger_row.tgname = 'trg_backstage_notion_index_version_fence'
      AND NOT trigger_row.tgisinternal;

  IF existing_trigger_function IS NULL THEN
    CREATE TRIGGER trg_backstage_notion_index_version_fence
      BEFORE UPDATE ON backstage_notion_universe_heads
      FOR EACH ROW
      EXECUTE FUNCTION backstage_notion_guard_index_version_activation();
  ELSIF existing_trigger_function
      <> 'backstage_notion_guard_index_version_activation()'::regprocedure
    OR existing_trigger_type <> 19
    OR existing_trigger_enabled <> 'O'
    OR existing_trigger_columns <> ''
    OR existing_trigger_when IS NOT NULL
  THEN
    RAISE EXCEPTION 'trg_backstage_notion_index_version_fence has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

COMMIT;

-- V3 rollback is fail-closed. Immutable expanded snapshots are never deleted
-- merely to restore the historical 2,048-chunk constraint.

BEGIN;

LOCK TABLE backstage_notion_universe_heads IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE backstage_notion_snapshots IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM backstage_notion_snapshots AS snapshot
    WHERE snapshot.chunk_count > 2048
  ) OR EXISTS (
    SELECT 1
    FROM backstage_notion_snapshot_chunks AS chunk
    GROUP BY chunk.universe_id, chunk.snapshot_id
    HAVING COUNT(*) > 2048
  ) THEN
    RAISE EXCEPTION 'cannot restore the 2048-chunk limit while expanded immutable snapshots exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE backstage_notion_snapshots
  DROP CONSTRAINT IF EXISTS ck_backstage_notion_snapshots_counts_v3;
ALTER TABLE backstage_notion_snapshots
  DROP CONSTRAINT IF EXISTS ck_backstage_notion_snapshots_counts;
ALTER TABLE backstage_notion_snapshots
  ADD CONSTRAINT ck_backstage_notion_snapshots_counts
  CHECK (page_count BETWEEN 1 AND 5000 AND chunk_count BETWEEN 1 AND 2048);

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

COMMIT;

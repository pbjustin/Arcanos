-- Run this statement by itself, outside an explicit transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_backstage_notion_shard_snapshot_pages_parent
  ON public.backstage_notion_shard_snapshot_pages(
    universe_id,
    shard_key,
    shard_snapshot_id,
    parent_page_id,
    page_id
  )
  WHERE parent_page_id IS NOT NULL;

-- This V2 rollback removes only the monotonic activation fence. It refuses while
-- an active snapshot exists because removing the trigger would reopen rolling
-- downgrade activation to an older worker.

BEGIN;

LOCK TABLE backstage_notion_universe_heads IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM backstage_notion_universe_heads
    WHERE active_snapshot_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cannot remove Backstage Notion index version fence while a snapshot is active'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS trg_backstage_notion_index_version_fence
  ON backstage_notion_universe_heads;
DROP FUNCTION IF EXISTS backstage_notion_guard_index_version_activation();
DROP FUNCTION IF EXISTS backstage_notion_snapshot_index_version(TEXT, UUID);

COMMIT;

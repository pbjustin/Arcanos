BEGIN;

-- This removes only latest-attempt diagnostics. Active snapshot rows and the
-- authoritative active pointer remain untouched and continue to be readable.
DROP TABLE IF EXISTS public.backstage_notion_latest_sync_attempts;

COMMIT;

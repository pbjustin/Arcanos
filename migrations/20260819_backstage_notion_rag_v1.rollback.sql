-- Roll back only an unused Notion RAG schema. Once a snapshot or authority
-- record exists, an operator must preserve/export it instead of dropping it.

BEGIN;

LOCK TABLE backstage_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_wrestlers IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storylines IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_story_beats IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_canon_heads IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_canon_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storyline_threads IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storyline_participants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storyline_canon_beats IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_notion_authority_epoch IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_notion_universe_heads IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_notion_snapshots IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_notion_snapshot_pages IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_notion_snapshot_chunks IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_notion_sync_leases IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM backstage_notion_universe_heads)
    OR EXISTS (SELECT 1 FROM backstage_notion_snapshots)
    OR EXISTS (SELECT 1 FROM backstage_notion_snapshot_pages)
    OR EXISTS (SELECT 1 FROM backstage_notion_snapshot_chunks)
    OR EXISTS (SELECT 1 FROM backstage_notion_sync_leases)
    OR (SELECT COUNT(*) FROM backstage_notion_authority_epoch) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM backstage_notion_authority_epoch
      WHERE singleton = TRUE
        AND epoch = 0
    )
  THEN
    RAISE EXCEPTION 'cannot roll back populated Backstage Notion RAG storage'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_events;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_wrestlers;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_storylines;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_story_beats;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_canon_heads;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_canon_revisions;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_storyline_threads;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_storyline_participants;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_guard ON backstage_storyline_canon_beats;
DROP TRIGGER IF EXISTS trg_backstage_notion_authority_persistence
  ON backstage_notion_universe_heads;

DROP TRIGGER IF EXISTS trg_backstage_notion_immutable ON backstage_notion_snapshots;
DROP TRIGGER IF EXISTS trg_backstage_notion_immutable ON backstage_notion_snapshot_pages;
DROP TRIGGER IF EXISTS trg_backstage_notion_immutable ON backstage_notion_snapshot_chunks;

DROP FUNCTION backstage_notion_guard_legacy_mutation();
DROP FUNCTION backstage_notion_guard_authority_persistence();
DROP FUNCTION backstage_notion_reject_immutable_mutation();

DROP TABLE backstage_notion_sync_leases;
DROP TABLE backstage_notion_snapshot_chunks;
DROP TABLE backstage_notion_snapshot_pages;
ALTER TABLE backstage_notion_universe_heads
  DROP CONSTRAINT fk_backstage_notion_heads_active_snapshot;
DROP TABLE backstage_notion_snapshots;
DROP TABLE backstage_notion_universe_heads;
DROP TABLE backstage_notion_authority_epoch;

COMMIT;

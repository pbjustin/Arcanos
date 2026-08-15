-- Remove the additive canon/storyline schema only before it contains domain or
-- revision history. Once canon exists, application rollback must preserve it.

BEGIN;
SET LOCAL search_path = public, pg_catalog;

-- The head is every Phase-2 writer's first lock target. Taking this lock first
-- lets an in-flight writer finish and prevents a new one from racing the guard.
LOCK TABLE backstage_canon_heads IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_canon_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storyline_threads IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storyline_participants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storyline_canon_beats IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM backstage_canon_heads WHERE revision <> 0)
    OR EXISTS (SELECT 1 FROM backstage_canon_revisions)
    OR EXISTS (SELECT 1 FROM backstage_storyline_threads)
    OR EXISTS (SELECT 1 FROM backstage_storyline_participants)
    OR EXISTS (SELECT 1 FROM backstage_storyline_canon_beats)
  THEN
    RAISE EXCEPTION 'Cannot roll back populated Backstage canon/storyline storage'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TABLE backstage_storyline_canon_beats;
DROP TABLE backstage_storyline_participants;
DROP TABLE backstage_storyline_threads;
DROP TABLE backstage_canon_revisions;
DROP TABLE backstage_canon_heads;

-- Retain the harmless redundant event identity. The forward migration may
-- have adopted an exact pre-existing constraint, so it cannot prove that it
-- owns this shared-table object and must not delete it during rollback.

COMMIT;

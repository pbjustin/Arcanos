-- Remove Backstage Booker universe scoping only when no non-legacy data exists.
-- This guard prevents distinct universe records from collapsing into global keys.

BEGIN;

-- Fence every universe-aware writer before checking the rollback invariant.
-- The fixed order matches the application context-read order and the locks are
-- retained through every constraint and column change below.
LOCK TABLE backstage_wrestlers IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_story_beats IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storylines IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  target_table TEXT;
  has_universe_column BOOLEAN;
  has_non_legacy_rows BOOLEAN;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'backstage_events',
    'backstage_wrestlers',
    'backstage_storylines',
    'backstage_story_beats'
  ]
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_attribute AS attribute
      WHERE attribute.attrelid = target_table::regclass
        AND attribute.attname = 'universe_id'
        AND NOT attribute.attisdropped
    ) INTO has_universe_column;

    IF has_universe_column THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I WHERE universe_id IS DISTINCT FROM %L)',
        target_table,
        'legacy'
      ) INTO has_non_legacy_rows;

      IF has_non_legacy_rows THEN
        RAISE EXCEPTION 'Cannot roll back Backstage universe scope while % contains non-legacy rows', target_table
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE backstage_wrestlers
  DROP CONSTRAINT IF EXISTS uq_backstage_wrestlers_universe_name;
ALTER TABLE backstage_storylines
  DROP CONSTRAINT IF EXISTS uq_backstage_storylines_universe_story_key;

DO $$
DECLARE
  existing_type "char";
  existing_definition TEXT;
BEGIN
  SELECT constraint_row.contype, pg_get_constraintdef(constraint_row.oid, false)
    INTO existing_type, existing_definition
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'backstage_wrestlers'::regclass
      AND constraint_row.conname = 'backstage_wrestlers_name_key';

  IF existing_definition IS NULL THEN
    ALTER TABLE backstage_wrestlers
      ADD CONSTRAINT backstage_wrestlers_name_key UNIQUE (name);
  ELSIF existing_type <> 'u'
    OR regexp_replace(existing_definition, '[[:space:]]+', '', 'g') <> 'UNIQUE(name)'
  THEN
    RAISE EXCEPTION 'backstage_wrestlers_name_key has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;

  existing_type := NULL;
  existing_definition := NULL;
  SELECT constraint_row.contype, pg_get_constraintdef(constraint_row.oid, false)
    INTO existing_type, existing_definition
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'backstage_storylines'::regclass
      AND constraint_row.conname = 'backstage_storylines_story_key_key';

  IF existing_definition IS NULL THEN
    ALTER TABLE backstage_storylines
      ADD CONSTRAINT backstage_storylines_story_key_key UNIQUE (story_key);
  ELSIF existing_type <> 'u'
    OR regexp_replace(existing_definition, '[[:space:]]+', '', 'g') <> 'UNIQUE(story_key)'
  THEN
    RAISE EXCEPTION 'backstage_storylines_story_key_key has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_backstage_wrestlers_universe_updated;
DROP INDEX IF EXISTS idx_backstage_events_universe_created;
DROP INDEX IF EXISTS idx_backstage_storylines_universe_updated;
DROP INDEX IF EXISTS idx_backstage_story_beats_universe_created;

ALTER TABLE backstage_events
  DROP CONSTRAINT IF EXISTS ck_backstage_events_universe_id;
ALTER TABLE backstage_wrestlers
  DROP CONSTRAINT IF EXISTS ck_backstage_wrestlers_universe_id;
ALTER TABLE backstage_storylines
  DROP CONSTRAINT IF EXISTS ck_backstage_storylines_universe_id;
ALTER TABLE backstage_story_beats
  DROP CONSTRAINT IF EXISTS ck_backstage_story_beats_universe_id;

ALTER TABLE backstage_events DROP COLUMN IF EXISTS universe_id;
ALTER TABLE backstage_wrestlers DROP COLUMN IF EXISTS universe_id;
ALTER TABLE backstage_storylines DROP COLUMN IF EXISTS universe_id;
ALTER TABLE backstage_story_beats DROP COLUMN IF EXISTS universe_id;

COMMIT;

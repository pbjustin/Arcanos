-- Add explicit universe scoping to the durable Backstage Booker model.
-- Existing rows belong to the backward-compatible legacy universe.

BEGIN;

CREATE TABLE IF NOT EXISTS backstage_wrestlers (
  id SERIAL PRIMARY KEY,
  universe_id TEXT NOT NULL DEFAULT 'legacy',
  name TEXT NOT NULL,
  overall INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backstage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id TEXT NOT NULL DEFAULT 'legacy',
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backstage_story_beats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id TEXT NOT NULL DEFAULT 'legacy',
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backstage_storylines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id TEXT NOT NULL DEFAULT 'legacy',
  story_key TEXT NOT NULL,
  storyline TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Acquire the cutover fence in the same order as the repeatable-read context
-- loader so a live reader can finish without forming a cross-table lock cycle.
LOCK TABLE backstage_wrestlers IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_story_beats IN ACCESS EXCLUSIVE MODE;
LOCK TABLE backstage_storylines IN ACCESS EXCLUSIVE MODE;

ALTER TABLE backstage_wrestlers ADD COLUMN IF NOT EXISTS universe_id TEXT;
ALTER TABLE backstage_events ADD COLUMN IF NOT EXISTS universe_id TEXT;
ALTER TABLE backstage_story_beats ADD COLUMN IF NOT EXISTS universe_id TEXT;
ALTER TABLE backstage_storylines ADD COLUMN IF NOT EXISTS universe_id TEXT;

DO $$
DECLARE
  target_table TEXT;
  universe_id_type OID;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'backstage_events',
    'backstage_wrestlers',
    'backstage_storylines',
    'backstage_story_beats'
  ]
  LOOP
    SELECT attribute.atttypid
      INTO universe_id_type
      FROM pg_attribute AS attribute
      WHERE attribute.attrelid = target_table::regclass
        AND attribute.attname = 'universe_id'
        AND NOT attribute.attisdropped;

    IF universe_id_type IS DISTINCT FROM 'text'::regtype THEN
      RAISE EXCEPTION '% universe_id must have PostgreSQL TEXT type', target_table
        USING ERRCODE = '42804';
    END IF;
  END LOOP;
END
$$;

UPDATE backstage_events
SET universe_id = 'legacy'
WHERE universe_id IS NULL OR btrim(universe_id) = '';

UPDATE backstage_wrestlers
SET universe_id = 'legacy'
WHERE universe_id IS NULL OR btrim(universe_id) = '';

UPDATE backstage_storylines
SET universe_id = 'legacy'
WHERE universe_id IS NULL OR btrim(universe_id) = '';

UPDATE backstage_story_beats
SET universe_id = 'legacy'
WHERE universe_id IS NULL OR btrim(universe_id) = '';

ALTER TABLE backstage_events ALTER COLUMN universe_id SET DEFAULT 'legacy';
ALTER TABLE backstage_events ALTER COLUMN universe_id SET NOT NULL;
ALTER TABLE backstage_wrestlers ALTER COLUMN universe_id SET DEFAULT 'legacy';
ALTER TABLE backstage_wrestlers ALTER COLUMN universe_id SET NOT NULL;
ALTER TABLE backstage_storylines ALTER COLUMN universe_id SET DEFAULT 'legacy';
ALTER TABLE backstage_storylines ALTER COLUMN universe_id SET NOT NULL;
ALTER TABLE backstage_story_beats ALTER COLUMN universe_id SET DEFAULT 'legacy';
ALTER TABLE backstage_story_beats ALTER COLUMN universe_id SET NOT NULL;

DO $$
DECLARE
  target RECORD;
  expected_constraint_name TEXT;
  actual_constraint_oid OID;
  actual_constraint_type "char";
  actual_constraint_expression TEXT;
  actual_constraint_no_inherit BOOLEAN;
  actual_constraint_is_local BOOLEAN;
  actual_constraint_inheritance_count INTEGER;
  actual_constraint_parent OID;
  actual_constraint_enforced BOOLEAN;
  expected_constraint_expression TEXT;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('backstage_wrestlers', 'ck_backstage_wrestlers_universe_id'),
      ('backstage_events', 'ck_backstage_events_universe_id'),
      ('backstage_story_beats', 'ck_backstage_story_beats_universe_id'),
      ('backstage_storylines', 'ck_backstage_storylines_universe_id')
    ) AS targets(table_name, constraint_name)
  LOOP
    actual_constraint_oid := NULL;
    actual_constraint_type := NULL;
    actual_constraint_expression := NULL;
    expected_constraint_expression := NULL;
    expected_constraint_name := target.constraint_name || '_expected';

    SELECT
      constraint_row.oid,
      constraint_row.contype,
      pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false),
      constraint_row.connoinherit,
      constraint_row.conislocal,
      constraint_row.coninhcount,
      constraint_row.conparentid,
      COALESCE((to_jsonb(constraint_row) ->> 'conenforced')::BOOLEAN, TRUE)
      INTO
        actual_constraint_oid,
        actual_constraint_type,
        actual_constraint_expression,
        actual_constraint_no_inherit,
        actual_constraint_is_local,
        actual_constraint_inheritance_count,
        actual_constraint_parent,
        actual_constraint_enforced
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = target.table_name::regclass
        AND constraint_row.conname = target.constraint_name;

    IF EXISTS (
      SELECT 1
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = target.table_name::regclass
        AND constraint_row.conname = expected_constraint_name
    ) THEN
      RAISE EXCEPTION '% is a reserved constraint verifier name', expected_constraint_name
        USING ERRCODE = '42804';
    END IF;

    IF actual_constraint_oid IS NULL THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (universe_id ~ %L) NOT VALID',
        target.table_name,
        target.constraint_name,
        '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (universe_id ~ %L) NOT VALID',
        target.table_name,
        expected_constraint_name,
        '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );

      SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false)
        INTO expected_constraint_expression
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = target.table_name::regclass
          AND constraint_row.conname = expected_constraint_name;

      EXECUTE format(
        'ALTER TABLE %I DROP CONSTRAINT %I',
        target.table_name,
        expected_constraint_name
      );

      IF actual_constraint_type <> 'c'
        OR actual_constraint_expression IS DISTINCT FROM expected_constraint_expression
        OR actual_constraint_no_inherit
        OR NOT actual_constraint_is_local
        OR actual_constraint_inheritance_count <> 0
        OR actual_constraint_parent <> 0
        OR NOT actual_constraint_enforced
      THEN
        RAISE EXCEPTION '% has an unexpected definition', target.constraint_name
          USING ERRCODE = '42804';
      END IF;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I VALIDATE CONSTRAINT %I',
      target.table_name,
      target.constraint_name
    );
  END LOOP;
END
$$;

-- Activation boundary: drain every legacy Backstage replica before removing
-- these global constraints. Their absence admits non-legacy durable writes.
ALTER TABLE backstage_wrestlers
  DROP CONSTRAINT IF EXISTS backstage_wrestlers_name_key;
ALTER TABLE backstage_storylines
  DROP CONSTRAINT IF EXISTS backstage_storylines_story_key_key;

DO $$
DECLARE
  existing_type "char";
  existing_definition TEXT;
BEGIN
  SELECT constraint_row.contype, pg_get_constraintdef(constraint_row.oid, false)
    INTO existing_type, existing_definition
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'backstage_wrestlers'::regclass
      AND constraint_row.conname = 'uq_backstage_wrestlers_universe_name';

  IF existing_definition IS NULL THEN
    ALTER TABLE backstage_wrestlers
      ADD CONSTRAINT uq_backstage_wrestlers_universe_name
      UNIQUE (universe_id, name);
  ELSIF existing_type <> 'u'
    OR regexp_replace(existing_definition, '[[:space:]]+', '', 'g')
      <> 'UNIQUE(universe_id,name)'
  THEN
    RAISE EXCEPTION 'uq_backstage_wrestlers_universe_name has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

DO $$
DECLARE
  existing_type "char";
  existing_definition TEXT;
BEGIN
  SELECT constraint_row.contype, pg_get_constraintdef(constraint_row.oid, false)
    INTO existing_type, existing_definition
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'backstage_storylines'::regclass
      AND constraint_row.conname = 'uq_backstage_storylines_universe_story_key';

  IF existing_definition IS NULL THEN
    ALTER TABLE backstage_storylines
      ADD CONSTRAINT uq_backstage_storylines_universe_story_key
      UNIQUE (universe_id, story_key);
  ELSIF existing_type <> 'u'
    OR regexp_replace(existing_definition, '[[:space:]]+', '', 'g')
      <> 'UNIQUE(universe_id,story_key)'
  THEN
    RAISE EXCEPTION 'uq_backstage_storylines_universe_story_key has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_backstage_wrestlers_universe_updated
  ON backstage_wrestlers(universe_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_backstage_events_universe_created
  ON backstage_events(universe_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backstage_storylines_universe_updated
  ON backstage_storylines(universe_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_backstage_story_beats_universe_created
  ON backstage_story_beats(universe_id, created_at DESC);

COMMIT;

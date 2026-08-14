-- Install the additive Backstage Booker canon/storyline persistence model.
-- Legacy saved prose and retained story beats are intentionally not imported:
-- neither source carries enough structured lifecycle information to do so safely.

BEGIN;
SET LOCAL search_path = public, pg_catalog;

-- Canon beats may refer to a booked event only inside the same universe. The
-- UUID primary key remains the global identity; this redundant scoped identity
-- exists solely for the composite foreign key below.
DO $$
DECLARE
  existing_type "char";
  existing_definition TEXT;
BEGIN
  SELECT constraint_row.contype, pg_get_constraintdef(constraint_row.oid, false)
    INTO existing_type, existing_definition
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'backstage_events'::regclass
      AND constraint_row.conname = 'uq_backstage_events_universe_id';

  IF existing_definition IS NULL THEN
    ALTER TABLE backstage_events
      ADD CONSTRAINT uq_backstage_events_universe_id
      UNIQUE (universe_id, id);
  ELSIF existing_type <> 'u'
    OR regexp_replace(existing_definition, '[[:space:]]+', '', 'g')
      <> 'UNIQUE(universe_id,id)'
  THEN
    RAISE EXCEPTION 'uq_backstage_events_universe_id has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS backstage_canon_heads (
  universe_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_backstage_canon_heads_universe_id
    CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT ck_backstage_canon_heads_revision
    CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS backstage_canon_revisions (
  universe_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  mutation_id UUID NOT NULL,
  operation TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_backstage_canon_revisions
    PRIMARY KEY (universe_id, revision),
  CONSTRAINT uq_backstage_canon_revisions_mutation
    UNIQUE (universe_id, mutation_id),
  CONSTRAINT fk_backstage_canon_revisions_head
    FOREIGN KEY (universe_id)
    REFERENCES backstage_canon_heads(universe_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT ck_backstage_canon_revisions_revision
    CHECK (revision > 0),
  CONSTRAINT ck_backstage_canon_revisions_operation
    CHECK (operation IN ('upsertStoryline', 'appendCanonBeat')),
  CONSTRAINT ck_backstage_canon_revisions_fingerprint
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_backstage_canon_revisions_result
    CHECK (
      jsonb_typeof(result) = 'object'
      AND octet_length(convert_to(result::TEXT, 'UTF8')) <= 262144
    )
);

CREATE TABLE IF NOT EXISTS backstage_storyline_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id TEXT NOT NULL,
  story_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_revision BIGINT NOT NULL,
  updated_revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ,
  CONSTRAINT uq_backstage_storyline_threads_universe_id
    UNIQUE (universe_id, id),
  CONSTRAINT uq_backstage_storyline_threads_universe_key
    UNIQUE (universe_id, story_key),
  CONSTRAINT fk_backstage_storyline_threads_head
    FOREIGN KEY (universe_id)
    REFERENCES backstage_canon_heads(universe_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_storyline_threads_created_revision
    FOREIGN KEY (universe_id, created_revision)
    REFERENCES backstage_canon_revisions(universe_id, revision)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_backstage_storyline_threads_updated_revision
    FOREIGN KEY (universe_id, updated_revision)
    REFERENCES backstage_canon_revisions(universe_id, revision)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_backstage_storyline_threads_story_key
    CHECK (char_length(btrim(story_key)) BETWEEN 1 AND 240),
  CONSTRAINT ck_backstage_storyline_threads_title
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
  CONSTRAINT ck_backstage_storyline_threads_summary
    CHECK (summary IS NULL OR char_length(summary) <= 10000),
  CONSTRAINT ck_backstage_storyline_threads_status
    CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
  CONSTRAINT ck_backstage_storyline_threads_version
    CHECK (version > 0),
  CONSTRAINT ck_backstage_storyline_threads_revisions
    CHECK (created_revision > 0 AND updated_revision >= created_revision),
  CONSTRAINT ck_backstage_storyline_threads_closed_at
    CHECK (
      (status IN ('completed', 'cancelled') AND closed_at IS NOT NULL)
      OR (status IN ('draft', 'active', 'paused') AND closed_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS backstage_storyline_participants (
  universe_id TEXT NOT NULL,
  storyline_id UUID NOT NULL,
  wrestler_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_backstage_storyline_participants
    PRIMARY KEY (universe_id, storyline_id, wrestler_name),
  CONSTRAINT uq_backstage_storyline_participants_order
    UNIQUE (universe_id, storyline_id, sort_order)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_backstage_storyline_participants_thread
    FOREIGN KEY (universe_id, storyline_id)
    REFERENCES backstage_storyline_threads(universe_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_storyline_participants_wrestler
    FOREIGN KEY (universe_id, wrestler_name)
    REFERENCES backstage_wrestlers(universe_id, name)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_storyline_participants_revision
    FOREIGN KEY (universe_id, created_revision)
    REFERENCES backstage_canon_revisions(universe_id, revision)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_backstage_storyline_participants_name
    CHECK (char_length(btrim(wrestler_name)) BETWEEN 1 AND 120),
  CONSTRAINT ck_backstage_storyline_participants_sort_order
    CHECK (sort_order >= 0)
);

CREATE TABLE IF NOT EXISTS backstage_storyline_canon_beats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  universe_id TEXT NOT NULL,
  storyline_id UUID NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  participant_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  event_id UUID,
  supersedes_beat_id UUID,
  universe_revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_backstage_storyline_canon_beats_universe_id
    UNIQUE (universe_id, id),
  CONSTRAINT uq_backstage_storyline_canon_beats_thread_id
    UNIQUE (universe_id, storyline_id, id),
  CONSTRAINT uq_backstage_storyline_canon_beats_sequence
    UNIQUE (universe_id, storyline_id, sequence),
  CONSTRAINT uq_backstage_storyline_canon_beats_replacement
    UNIQUE (universe_id, supersedes_beat_id),
  CONSTRAINT fk_backstage_storyline_canon_beats_thread
    FOREIGN KEY (universe_id, storyline_id)
    REFERENCES backstage_storyline_threads(universe_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_storyline_canon_beats_event
    FOREIGN KEY (universe_id, event_id)
    REFERENCES backstage_events(universe_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_storyline_canon_beats_supersedes
    FOREIGN KEY (universe_id, storyline_id, supersedes_beat_id)
    REFERENCES backstage_storyline_canon_beats(universe_id, storyline_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_storyline_canon_beats_revision
    FOREIGN KEY (universe_id, universe_revision)
    REFERENCES backstage_canon_revisions(universe_id, revision)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_backstage_storyline_canon_beats_sequence
    CHECK (sequence > 0),
  CONSTRAINT ck_backstage_storyline_canon_beats_kind
    CHECK (char_length(btrim(kind)) BETWEEN 1 AND 64),
  CONSTRAINT ck_backstage_storyline_canon_beats_summary
    CHECK (char_length(btrim(summary)) BETWEEN 1 AND 10000),
  CONSTRAINT ck_backstage_storyline_canon_beats_occurred_at
    CHECK (isfinite(occurred_at)),
  CONSTRAINT ck_backstage_storyline_canon_beats_participants
    CHECK (
      jsonb_typeof(participant_names) = 'array'
      AND jsonb_array_length(participant_names) <= 50
      AND octet_length(convert_to(participant_names::TEXT, 'UTF8')) <= 16384
    ),
  CONSTRAINT ck_backstage_storyline_canon_beats_not_self_superseding
    CHECK (supersedes_beat_id IS NULL OR supersedes_beat_id <> id),
  CONSTRAINT ck_backstage_storyline_canon_beats_revision
    CHECK (universe_revision > 0)
);

CREATE INDEX IF NOT EXISTS idx_backstage_storyline_threads_universe_status_updated
  ON backstage_storyline_threads(universe_id, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_backstage_storyline_participants_wrestler
  ON backstage_storyline_participants(universe_id, wrestler_name, storyline_id);
CREATE INDEX IF NOT EXISTS idx_backstage_storyline_canon_beats_active_context
  ON backstage_storyline_canon_beats(universe_id, occurred_at DESC, sequence DESC, id);
CREATE INDEX IF NOT EXISTS idx_backstage_canon_revisions_created
  ON backstage_canon_revisions(universe_id, created_at DESC, revision DESC);

-- CREATE ... IF NOT EXISTS is intentionally paired with an exact catalog
-- verifier. Startup may have installed this schema before the migration runs;
-- a same-named but structurally different object must fail closed instead of
-- being silently adopted.
DO $$
DECLARE
  table_pair RECORD;
  index_pair RECORD;
  expected_constraint RECORD;
  actual_constraint RECORD;
  actual_table_oid OID;
  expected_table_oid OID;
  expected_reference_oid OID;
  actual_index_oid OID;
  expected_index_oid OID;
  actual_columns JSONB;
  expected_columns JSONB;
  actual_constraint_names TEXT[];
  expected_constraint_names TEXT[];
  actual_index_signature JSONB;
  expected_index_signature JSONB;
  expected_reference_name TEXT;
  actual_table_kind "char";
  actual_table_persistence "char";
  actual_table_is_partition BOOLEAN;
  actual_table_row_security BOOLEAN;
  actual_table_force_row_security BOOLEAN;
BEGIN
  CREATE TEMP TABLE p2_expected_backstage_events (
    id UUID NOT NULL,
    universe_id TEXT NOT NULL,
    CONSTRAINT uq_backstage_events_universe_id
      UNIQUE (universe_id, id)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_wrestlers (
    id INTEGER NOT NULL,
    universe_id TEXT NOT NULL,
    name TEXT NOT NULL,
    CONSTRAINT uq_backstage_wrestlers_universe_name
      UNIQUE (universe_id, name)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_canon_heads (
    universe_id TEXT,
    revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT backstage_canon_heads_pkey
      PRIMARY KEY (universe_id),
    CONSTRAINT ck_backstage_canon_heads_universe_id
      CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    CONSTRAINT ck_backstage_canon_heads_revision
      CHECK (revision >= 0)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_canon_revisions (
    universe_id TEXT NOT NULL,
    revision BIGINT NOT NULL,
    mutation_id UUID NOT NULL,
    operation TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_backstage_canon_revisions
      PRIMARY KEY (universe_id, revision),
    CONSTRAINT uq_backstage_canon_revisions_mutation
      UNIQUE (universe_id, mutation_id),
    CONSTRAINT fk_backstage_canon_revisions_head
      FOREIGN KEY (universe_id)
      REFERENCES p2_expected_backstage_canon_heads(universe_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT ck_backstage_canon_revisions_revision
      CHECK (revision > 0),
    CONSTRAINT ck_backstage_canon_revisions_operation
      CHECK (operation IN ('upsertStoryline', 'appendCanonBeat')),
    CONSTRAINT ck_backstage_canon_revisions_fingerprint
      CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_backstage_canon_revisions_result
      CHECK (
        jsonb_typeof(result) = 'object'
        AND octet_length(convert_to(result::TEXT, 'UTF8')) <= 262144
      )
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_storyline_threads (
    id UUID DEFAULT gen_random_uuid(),
    universe_id TEXT NOT NULL,
    story_key TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_revision BIGINT NOT NULL,
    updated_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    closed_at TIMESTAMPTZ,
    CONSTRAINT backstage_storyline_threads_pkey
      PRIMARY KEY (id),
    CONSTRAINT uq_backstage_storyline_threads_universe_id
      UNIQUE (universe_id, id),
    CONSTRAINT uq_backstage_storyline_threads_universe_key
      UNIQUE (universe_id, story_key),
    CONSTRAINT fk_backstage_storyline_threads_head
      FOREIGN KEY (universe_id)
      REFERENCES p2_expected_backstage_canon_heads(universe_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_threads_created_revision
      FOREIGN KEY (universe_id, created_revision)
      REFERENCES p2_expected_backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_backstage_storyline_threads_updated_revision
      FOREIGN KEY (universe_id, updated_revision)
      REFERENCES p2_expected_backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_threads_story_key
      CHECK (char_length(btrim(story_key)) BETWEEN 1 AND 240),
    CONSTRAINT ck_backstage_storyline_threads_title
      CHECK (char_length(btrim(title)) BETWEEN 1 AND 240),
    CONSTRAINT ck_backstage_storyline_threads_summary
      CHECK (summary IS NULL OR char_length(summary) <= 10000),
    CONSTRAINT ck_backstage_storyline_threads_status
      CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
    CONSTRAINT ck_backstage_storyline_threads_version
      CHECK (version > 0),
    CONSTRAINT ck_backstage_storyline_threads_revisions
      CHECK (created_revision > 0 AND updated_revision >= created_revision),
    CONSTRAINT ck_backstage_storyline_threads_closed_at
      CHECK (
        (status IN ('completed', 'cancelled') AND closed_at IS NOT NULL)
        OR (status IN ('draft', 'active', 'paused') AND closed_at IS NULL)
      )
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_storyline_participants (
    universe_id TEXT NOT NULL,
    storyline_id UUID NOT NULL,
    wrestler_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_backstage_storyline_participants
      PRIMARY KEY (universe_id, storyline_id, wrestler_name),
    CONSTRAINT uq_backstage_storyline_participants_order
      UNIQUE (universe_id, storyline_id, sort_order)
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT fk_backstage_storyline_participants_thread
      FOREIGN KEY (universe_id, storyline_id)
      REFERENCES p2_expected_backstage_storyline_threads(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_participants_wrestler
      FOREIGN KEY (universe_id, wrestler_name)
      REFERENCES p2_expected_backstage_wrestlers(universe_id, name)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_participants_revision
      FOREIGN KEY (universe_id, created_revision)
      REFERENCES p2_expected_backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_participants_name
      CHECK (char_length(btrim(wrestler_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_backstage_storyline_participants_sort_order
      CHECK (sort_order >= 0)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE p2_expected_backstage_storyline_canon_beats (
    id UUID DEFAULT gen_random_uuid(),
    universe_id TEXT NOT NULL,
    storyline_id UUID NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    participant_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    event_id UUID,
    supersedes_beat_id UUID,
    universe_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT backstage_storyline_canon_beats_pkey
      PRIMARY KEY (id),
    CONSTRAINT uq_backstage_storyline_canon_beats_universe_id
      UNIQUE (universe_id, id),
    CONSTRAINT uq_backstage_storyline_canon_beats_thread_id
      UNIQUE (universe_id, storyline_id, id),
    CONSTRAINT uq_backstage_storyline_canon_beats_sequence
      UNIQUE (universe_id, storyline_id, sequence),
    CONSTRAINT uq_backstage_storyline_canon_beats_replacement
      UNIQUE (universe_id, supersedes_beat_id),
    CONSTRAINT fk_backstage_storyline_canon_beats_thread
      FOREIGN KEY (universe_id, storyline_id)
      REFERENCES p2_expected_backstage_storyline_threads(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_event
      FOREIGN KEY (universe_id, event_id)
      REFERENCES p2_expected_backstage_events(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_supersedes
      FOREIGN KEY (universe_id, storyline_id, supersedes_beat_id)
      REFERENCES p2_expected_backstage_storyline_canon_beats(
        universe_id,
        storyline_id,
        id
      )
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    CONSTRAINT fk_backstage_storyline_canon_beats_revision
      FOREIGN KEY (universe_id, universe_revision)
      REFERENCES p2_expected_backstage_canon_revisions(universe_id, revision)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT ck_backstage_storyline_canon_beats_sequence
      CHECK (sequence > 0),
    CONSTRAINT ck_backstage_storyline_canon_beats_kind
      CHECK (char_length(btrim(kind)) BETWEEN 1 AND 64),
    CONSTRAINT ck_backstage_storyline_canon_beats_summary
      CHECK (char_length(btrim(summary)) BETWEEN 1 AND 10000),
    CONSTRAINT ck_backstage_storyline_canon_beats_occurred_at
      CHECK (isfinite(occurred_at)),
    CONSTRAINT ck_backstage_storyline_canon_beats_participants
      CHECK (
        jsonb_typeof(participant_names) = 'array'
        AND jsonb_array_length(participant_names) <= 50
        AND octet_length(convert_to(participant_names::TEXT, 'UTF8')) <= 16384
      ),
    CONSTRAINT ck_backstage_storyline_canon_beats_not_self_superseding
      CHECK (supersedes_beat_id IS NULL OR supersedes_beat_id <> id),
    CONSTRAINT ck_backstage_storyline_canon_beats_revision
      CHECK (universe_revision > 0)
  ) ON COMMIT DROP;

  CREATE INDEX idx_backstage_storyline_threads_universe_status_updated
    ON p2_expected_backstage_storyline_threads(
      universe_id,
      status,
      updated_at DESC,
      id
    );
  CREATE INDEX idx_backstage_storyline_participants_wrestler
    ON p2_expected_backstage_storyline_participants(
      universe_id,
      wrestler_name,
      storyline_id
    );
  CREATE INDEX idx_backstage_storyline_canon_beats_active_context
    ON p2_expected_backstage_storyline_canon_beats(
      universe_id,
      occurred_at DESC,
      sequence DESC,
      id
    );
  CREATE INDEX idx_backstage_canon_revisions_created
    ON p2_expected_backstage_canon_revisions(
      universe_id,
      created_at DESC,
      revision DESC
    );

  FOR table_pair IN
    SELECT *
    FROM (VALUES
      ('backstage_canon_heads', 'p2_expected_backstage_canon_heads'),
      ('backstage_canon_revisions', 'p2_expected_backstage_canon_revisions'),
      ('backstage_storyline_threads', 'p2_expected_backstage_storyline_threads'),
      ('backstage_storyline_participants', 'p2_expected_backstage_storyline_participants'),
      ('backstage_storyline_canon_beats', 'p2_expected_backstage_storyline_canon_beats')
    ) AS expected_tables(actual_name, expected_name)
  LOOP
    actual_table_oid := to_regclass(table_pair.actual_name);
    expected_table_oid := to_regclass('pg_temp.' || table_pair.expected_name);

    SELECT
      relkind,
      relpersistence,
      relispartition,
      relrowsecurity,
      relforcerowsecurity
      INTO
        actual_table_kind,
        actual_table_persistence,
        actual_table_is_partition,
        actual_table_row_security,
        actual_table_force_row_security
      FROM pg_class
      WHERE oid = actual_table_oid;
    IF actual_table_oid IS NULL
      OR expected_table_oid IS NULL
      OR actual_table_kind <> 'r'
      OR actual_table_persistence <> 'p'
      OR actual_table_is_partition
      OR actual_table_row_security
      OR actual_table_force_row_security
    THEN
      RAISE EXCEPTION '% is not an ordinary unfiltered permanent table', table_pair.actual_name
        USING ERRCODE = '42804';
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_array(
          attribute.attnum,
          attribute.attname,
          attribute.atttypid::TEXT,
          attribute.atttypmod,
          attribute.attndims,
          attribute.attnotnull,
          attribute.attidentity::TEXT,
          attribute.attgenerated::TEXT,
          attribute.attcollation::TEXT,
          attribute.attislocal,
          attribute.attinhcount,
          attribute.atthasmissing,
          to_jsonb(attribute.attmissingval),
          pg_get_expr(attribute_default.adbin, attribute_default.adrelid, false),
          attribute.attstorage::TEXT,
          COALESCE(to_jsonb(attribute) ->> 'attcompression', '')
        )
        ORDER BY attribute.attnum
      ),
      '[]'::JSONB
    )
      INTO actual_columns
      FROM pg_attribute AS attribute
      LEFT JOIN pg_attrdef AS attribute_default
        ON attribute_default.adrelid = attribute.attrelid
       AND attribute_default.adnum = attribute.attnum
      WHERE attribute.attrelid = actual_table_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_array(
          attribute.attnum,
          attribute.attname,
          attribute.atttypid::TEXT,
          attribute.atttypmod,
          attribute.attndims,
          attribute.attnotnull,
          attribute.attidentity::TEXT,
          attribute.attgenerated::TEXT,
          attribute.attcollation::TEXT,
          attribute.attislocal,
          attribute.attinhcount,
          attribute.atthasmissing,
          to_jsonb(attribute.attmissingval),
          pg_get_expr(attribute_default.adbin, attribute_default.adrelid, false),
          attribute.attstorage::TEXT,
          COALESCE(to_jsonb(attribute) ->> 'attcompression', '')
        )
        ORDER BY attribute.attnum
      ),
      '[]'::JSONB
    )
      INTO expected_columns
      FROM pg_attribute AS attribute
      LEFT JOIN pg_attrdef AS attribute_default
        ON attribute_default.adrelid = attribute.attrelid
       AND attribute_default.adnum = attribute.attnum
      WHERE attribute.attrelid = expected_table_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped;

    IF actual_columns IS DISTINCT FROM expected_columns THEN
      RAISE EXCEPTION '% has unexpected columns', table_pair.actual_name
        USING ERRCODE = '42804';
    END IF;

    SELECT COALESCE(array_agg(conname ORDER BY conname), ARRAY[]::TEXT[])
      INTO actual_constraint_names
      FROM pg_constraint
      WHERE conrelid = actual_table_oid
        AND contype <> 'n';
    SELECT COALESCE(array_agg(conname ORDER BY conname), ARRAY[]::TEXT[])
      INTO expected_constraint_names
      FROM pg_constraint
      WHERE conrelid = expected_table_oid
        AND contype <> 'n';

    IF actual_constraint_names IS DISTINCT FROM expected_constraint_names THEN
      RAISE EXCEPTION '% has unexpected constraints', table_pair.actual_name
        USING ERRCODE = '42804';
    END IF;

    FOR expected_constraint IN
      SELECT
        constraint_row.*,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY
            AS key_column(attribute_number, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key_column.attribute_number
          ORDER BY key_column.position
        ) AS constraint_columns,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY
            AS key_column(attribute_number, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key_column.attribute_number
          ORDER BY key_column.position
        ) AS referenced_columns,
        pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          false
        ) AS constraint_expression,
        COALESCE(
          (to_jsonb(constraint_row) ->> 'conenforced')::BOOLEAN,
          TRUE
        ) AS constraint_enforced,
        to_jsonb(constraint_row) -> 'confdelsetcols'
          AS constraint_delete_set_columns,
        COALESCE(
          (to_jsonb(constraint_row) ->> 'conperiod')::BOOLEAN,
          FALSE
        ) AS constraint_period
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = expected_table_oid
        AND constraint_row.contype <> 'n'
      ORDER BY constraint_row.conname
    LOOP
      SELECT
        constraint_row.*,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY
            AS key_column(attribute_number, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = key_column.attribute_number
          ORDER BY key_column.position
        ) AS constraint_columns,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY
            AS key_column(attribute_number, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = key_column.attribute_number
          ORDER BY key_column.position
        ) AS referenced_columns,
        pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          false
        ) AS constraint_expression,
        COALESCE(
          (to_jsonb(constraint_row) ->> 'conenforced')::BOOLEAN,
          TRUE
        ) AS constraint_enforced,
        to_jsonb(constraint_row) -> 'confdelsetcols'
          AS constraint_delete_set_columns,
        COALESCE(
          (to_jsonb(constraint_row) ->> 'conperiod')::BOOLEAN,
          FALSE
        ) AS constraint_period
        INTO actual_constraint
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = actual_table_oid
          AND constraint_row.conname = expected_constraint.conname;

      IF NOT FOUND
        OR actual_constraint.contype IS DISTINCT FROM expected_constraint.contype
        OR actual_constraint.constraint_columns
          IS DISTINCT FROM expected_constraint.constraint_columns
        OR actual_constraint.referenced_columns
          IS DISTINCT FROM expected_constraint.referenced_columns
        OR actual_constraint.confupdtype IS DISTINCT FROM expected_constraint.confupdtype
        OR actual_constraint.confdeltype IS DISTINCT FROM expected_constraint.confdeltype
        OR actual_constraint.confmatchtype IS DISTINCT FROM expected_constraint.confmatchtype
        OR actual_constraint.conislocal IS DISTINCT FROM expected_constraint.conislocal
        OR actual_constraint.coninhcount IS DISTINCT FROM expected_constraint.coninhcount
        OR actual_constraint.connoinherit IS DISTINCT FROM expected_constraint.connoinherit
        OR actual_constraint.condeferrable IS DISTINCT FROM expected_constraint.condeferrable
        OR actual_constraint.condeferred IS DISTINCT FROM expected_constraint.condeferred
        OR actual_constraint.convalidated IS DISTINCT FROM expected_constraint.convalidated
        OR actual_constraint.conparentid IS DISTINCT FROM expected_constraint.conparentid
        OR actual_constraint.conpfeqop IS DISTINCT FROM expected_constraint.conpfeqop
        OR actual_constraint.conppeqop IS DISTINCT FROM expected_constraint.conppeqop
        OR actual_constraint.conffeqop IS DISTINCT FROM expected_constraint.conffeqop
        OR actual_constraint.conexclop IS DISTINCT FROM expected_constraint.conexclop
        OR actual_constraint.constraint_expression
          IS DISTINCT FROM expected_constraint.constraint_expression
        OR actual_constraint.constraint_enforced
          IS DISTINCT FROM expected_constraint.constraint_enforced
        OR actual_constraint.constraint_delete_set_columns
          IS DISTINCT FROM expected_constraint.constraint_delete_set_columns
        OR actual_constraint.constraint_period
          IS DISTINCT FROM expected_constraint.constraint_period
      THEN
        RAISE EXCEPTION '% has an unexpected definition', expected_constraint.conname
          USING ERRCODE = '42804';
      END IF;

      IF expected_constraint.contype = 'f' THEN
        SELECT regexp_replace(referenced.relname, '^p2_expected_', '')
          INTO expected_reference_name
          FROM pg_class AS referenced
          WHERE referenced.oid = expected_constraint.confrelid;
        expected_reference_oid := to_regclass(expected_reference_name);
        IF expected_reference_oid IS NULL
          OR actual_constraint.confrelid IS DISTINCT FROM expected_reference_oid
        THEN
          RAISE EXCEPTION '% references an unexpected table', expected_constraint.conname
            USING ERRCODE = '42804';
        END IF;
      END IF;

      IF expected_constraint.contype IN ('p', 'u') THEN
        SELECT jsonb_build_object(
          'access_method', index_class.relam::TEXT,
          'reloptions', to_jsonb(index_class.reloptions),
          'unique', index_row.indisunique,
          'primary', index_row.indisprimary,
          'exclusion', index_row.indisexclusion,
          'immediate', index_row.indimmediate,
          'valid', index_row.indisvalid,
          'ready', index_row.indisready,
          'live', index_row.indislive,
          'nulls_not_distinct', COALESCE(
            (to_jsonb(index_row) ->> 'indnullsnotdistinct')::BOOLEAN,
            FALSE
          ),
          'attribute_count', index_row.indnatts,
          'key_attribute_count', index_row.indnkeyatts,
          'key', index_row.indkey::TEXT,
          'collation', index_row.indcollation::TEXT,
          'operator_class', index_row.indclass::TEXT,
          'options', index_row.indoption::TEXT,
          'expressions', pg_get_expr(index_row.indexprs, index_row.indrelid, false),
          'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, false)
        )
          INTO actual_index_signature
          FROM pg_index AS index_row
          INNER JOIN pg_class AS index_class
            ON index_class.oid = index_row.indexrelid
          WHERE index_row.indexrelid = actual_constraint.conindid;

        SELECT jsonb_build_object(
          'access_method', index_class.relam::TEXT,
          'reloptions', to_jsonb(index_class.reloptions),
          'unique', index_row.indisunique,
          'primary', index_row.indisprimary,
          'exclusion', index_row.indisexclusion,
          'immediate', index_row.indimmediate,
          'valid', index_row.indisvalid,
          'ready', index_row.indisready,
          'live', index_row.indislive,
          'nulls_not_distinct', COALESCE(
            (to_jsonb(index_row) ->> 'indnullsnotdistinct')::BOOLEAN,
            FALSE
          ),
          'attribute_count', index_row.indnatts,
          'key_attribute_count', index_row.indnkeyatts,
          'key', index_row.indkey::TEXT,
          'collation', index_row.indcollation::TEXT,
          'operator_class', index_row.indclass::TEXT,
          'options', index_row.indoption::TEXT,
          'expressions', pg_get_expr(index_row.indexprs, index_row.indrelid, false),
          'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, false)
        )
          INTO expected_index_signature
          FROM pg_index AS index_row
          INNER JOIN pg_class AS index_class
            ON index_class.oid = index_row.indexrelid
          WHERE index_row.indexrelid = expected_constraint.conindid;

        IF actual_index_signature IS DISTINCT FROM expected_index_signature THEN
          RAISE EXCEPTION '% has an unexpected backing index', expected_constraint.conname
            USING ERRCODE = '42804';
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  FOR index_pair IN
    SELECT *
    FROM (VALUES
      (
        'backstage_storyline_threads',
        'p2_expected_backstage_storyline_threads',
        'idx_backstage_storyline_threads_universe_status_updated'
      ),
      (
        'backstage_storyline_participants',
        'p2_expected_backstage_storyline_participants',
        'idx_backstage_storyline_participants_wrestler'
      ),
      (
        'backstage_storyline_canon_beats',
        'p2_expected_backstage_storyline_canon_beats',
        'idx_backstage_storyline_canon_beats_active_context'
      ),
      (
        'backstage_canon_revisions',
        'p2_expected_backstage_canon_revisions',
        'idx_backstage_canon_revisions_created'
      )
    ) AS expected_indexes(actual_table, expected_table, index_name)
  LOOP
    actual_table_oid := to_regclass(index_pair.actual_table);
    expected_table_oid := to_regclass('pg_temp.' || index_pair.expected_table);

    SELECT index_class.oid
      INTO actual_index_oid
      FROM pg_index AS index_row
      INNER JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      WHERE index_row.indrelid = actual_table_oid
        AND index_class.relname = index_pair.index_name;
    SELECT index_class.oid
      INTO expected_index_oid
      FROM pg_index AS index_row
      INNER JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      WHERE index_row.indrelid = expected_table_oid
        AND index_class.relname = index_pair.index_name;

    IF actual_index_oid IS NULL OR expected_index_oid IS NULL THEN
      RAISE EXCEPTION '% is missing', index_pair.index_name
        USING ERRCODE = '42804';
    END IF;

    SELECT jsonb_build_object(
      'access_method', index_class.relam::TEXT,
      'reloptions', to_jsonb(index_class.reloptions),
      'unique', index_row.indisunique,
      'primary', index_row.indisprimary,
      'exclusion', index_row.indisexclusion,
      'immediate', index_row.indimmediate,
      'valid', index_row.indisvalid,
      'ready', index_row.indisready,
      'live', index_row.indislive,
      'nulls_not_distinct', COALESCE(
        (to_jsonb(index_row) ->> 'indnullsnotdistinct')::BOOLEAN,
        FALSE
      ),
      'attribute_count', index_row.indnatts,
      'key_attribute_count', index_row.indnkeyatts,
      'key', index_row.indkey::TEXT,
      'collation', index_row.indcollation::TEXT,
      'operator_class', index_row.indclass::TEXT,
      'options', index_row.indoption::TEXT,
      'expressions', pg_get_expr(index_row.indexprs, index_row.indrelid, false),
      'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, false)
    )
      INTO actual_index_signature
      FROM pg_index AS index_row
      INNER JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      WHERE index_row.indexrelid = actual_index_oid;

    SELECT jsonb_build_object(
      'access_method', index_class.relam::TEXT,
      'reloptions', to_jsonb(index_class.reloptions),
      'unique', index_row.indisunique,
      'primary', index_row.indisprimary,
      'exclusion', index_row.indisexclusion,
      'immediate', index_row.indimmediate,
      'valid', index_row.indisvalid,
      'ready', index_row.indisready,
      'live', index_row.indislive,
      'nulls_not_distinct', COALESCE(
        (to_jsonb(index_row) ->> 'indnullsnotdistinct')::BOOLEAN,
        FALSE
      ),
      'attribute_count', index_row.indnatts,
      'key_attribute_count', index_row.indnkeyatts,
      'key', index_row.indkey::TEXT,
      'collation', index_row.indcollation::TEXT,
      'operator_class', index_row.indclass::TEXT,
      'options', index_row.indoption::TEXT,
      'expressions', pg_get_expr(index_row.indexprs, index_row.indrelid, false),
      'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, false)
    )
      INTO expected_index_signature
      FROM pg_index AS index_row
      INNER JOIN pg_class AS index_class
        ON index_class.oid = index_row.indexrelid
      WHERE index_row.indexrelid = expected_index_oid;

    IF actual_index_signature IS DISTINCT FROM expected_index_signature THEN
      RAISE EXCEPTION '% has an unexpected definition', index_pair.index_name
        USING ERRCODE = '42804';
    END IF;
  END LOOP;

  DROP TABLE p2_expected_backstage_storyline_canon_beats;
  DROP TABLE p2_expected_backstage_storyline_participants;
  DROP TABLE p2_expected_backstage_storyline_threads;
  DROP TABLE p2_expected_backstage_canon_revisions;
  DROP TABLE p2_expected_backstage_canon_heads;
  DROP TABLE p2_expected_backstage_events;
  DROP TABLE p2_expected_backstage_wrestlers;
END
$$;

-- Establish revision-zero heads only. Existing prose and retained beats have no
-- safe deterministic mapping into the new structured lifecycle.
INSERT INTO backstage_canon_heads (universe_id)
SELECT universe_id FROM backstage_wrestlers
UNION
SELECT universe_id FROM backstage_events
UNION
SELECT universe_id FROM backstage_storylines
UNION
SELECT universe_id FROM backstage_story_beats
UNION
SELECT 'legacy'
ON CONFLICT (universe_id) DO NOTHING;

COMMIT;

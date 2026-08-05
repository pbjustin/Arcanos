-- Add exact compact-JSON and deterministic-order components for bounded
-- Backstage storyline reads. Existing rows remain paired-null until the next
-- mutation transaction admits bounded legacy objects and prunes the rest.

ALTER TABLE backstage_story_beats
  ADD COLUMN IF NOT EXISTS serialized_data TEXT;

ALTER TABLE backstage_story_beats
  ADD COLUMN IF NOT EXISTS storage_sequence BIGINT;

DO $$
DECLARE
  serialized_data_type OID;
  serialized_data_type_modifier INTEGER;
  serialized_data_not_null BOOLEAN;
  serialized_data_identity "char";
  serialized_data_generated "char";
  serialized_data_default TEXT;
  serialized_data_is_local BOOLEAN;
  serialized_data_inheritance_count INTEGER;
BEGIN
  SELECT
    attribute.atttypid,
    attribute.atttypmod,
    attribute.attnotnull,
    attribute.attidentity,
    attribute.attgenerated,
    pg_get_expr(attribute_default.adbin, attribute_default.adrelid),
    attribute.attislocal,
    attribute.attinhcount
  INTO
    serialized_data_type,
    serialized_data_type_modifier,
    serialized_data_not_null,
    serialized_data_identity,
    serialized_data_generated,
    serialized_data_default,
    serialized_data_is_local,
    serialized_data_inheritance_count
  FROM pg_attribute AS attribute
  LEFT JOIN pg_attrdef AS attribute_default
    ON attribute_default.adrelid = attribute.attrelid
   AND attribute_default.adnum = attribute.attnum
  WHERE attribute.attrelid = 'backstage_story_beats'::regclass
    AND attribute.attname = 'serialized_data'
    AND NOT attribute.attisdropped;

  IF serialized_data_type IS DISTINCT FROM 'text'::regtype
    OR serialized_data_type_modifier <> -1
    OR serialized_data_not_null
    OR serialized_data_identity <> ''
    OR serialized_data_generated <> ''
    OR serialized_data_default IS NOT NULL
    OR NOT serialized_data_is_local
    OR serialized_data_inheritance_count <> 0 THEN
    RAISE EXCEPTION
      'backstage_story_beats.serialized_data has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

DO $$
DECLARE
  storage_sequence_type OID;
  storage_sequence_type_modifier INTEGER;
  storage_sequence_not_null BOOLEAN;
  storage_sequence_identity "char";
  storage_sequence_generated "char";
  storage_sequence_default TEXT;
  storage_sequence_is_local BOOLEAN;
  storage_sequence_inheritance_count INTEGER;
BEGIN
  SELECT
    attribute.atttypid,
    attribute.atttypmod,
    attribute.attnotnull,
    attribute.attidentity,
    attribute.attgenerated,
    pg_get_expr(attribute_default.adbin, attribute_default.adrelid),
    attribute.attislocal,
    attribute.attinhcount
  INTO
    storage_sequence_type,
    storage_sequence_type_modifier,
    storage_sequence_not_null,
    storage_sequence_identity,
    storage_sequence_generated,
    storage_sequence_default,
    storage_sequence_is_local,
    storage_sequence_inheritance_count
  FROM pg_attribute AS attribute
  LEFT JOIN pg_attrdef AS attribute_default
    ON attribute_default.adrelid = attribute.attrelid
   AND attribute_default.adnum = attribute.attnum
  WHERE attribute.attrelid = 'backstage_story_beats'::regclass
    AND attribute.attname = 'storage_sequence'
    AND NOT attribute.attisdropped;

  IF storage_sequence_type IS DISTINCT FROM 'bigint'::regtype
    OR storage_sequence_type_modifier <> -1
    OR storage_sequence_not_null
    OR storage_sequence_identity <> ''
    OR storage_sequence_generated <> ''
    OR storage_sequence_default IS NOT NULL
    OR NOT storage_sequence_is_local
    OR storage_sequence_inheritance_count <> 0 THEN
    RAISE EXCEPTION
      'backstage_story_beats.storage_sequence has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

DO $$
DECLARE
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
  LOCK TABLE backstage_story_beats IN SHARE ROW EXCLUSIVE MODE;

  SELECT
    oid,
    contype,
    pg_get_expr(conbin, conrelid, false),
    connoinherit,
    conislocal,
    coninhcount,
    conparentid,
    COALESCE((to_jsonb(pg_constraint) ->> 'conenforced')::BOOLEAN, TRUE)
  INTO
    actual_constraint_oid,
    actual_constraint_type,
    actual_constraint_expression,
    actual_constraint_no_inherit,
    actual_constraint_is_local,
    actual_constraint_inheritance_count,
    actual_constraint_parent,
    actual_constraint_enforced
  FROM pg_constraint
  WHERE conrelid = 'backstage_story_beats'::regclass
    AND conname = 'backstage_story_beats_serialized_data_contract';

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'backstage_story_beats'::regclass
      AND conname = 'backstage_story_beats_serialized_data_contract_expected'
  ) THEN
    RAISE EXCEPTION
      'reserved storyline constraint verifier name is already in use'
      USING ERRCODE = '42804';
  END IF;

  IF actual_constraint_oid IS NULL THEN
    ALTER TABLE backstage_story_beats
      ADD CONSTRAINT backstage_story_beats_serialized_data_contract
      CHECK (
        (serialized_data IS NULL AND storage_sequence IS NULL)
        OR (
          serialized_data IS NOT NULL
          AND octet_length(convert_to(serialized_data, 'UTF8')) <= 16384
          AND serialized_data IS JSON OBJECT
          AND storage_sequence IS NOT NULL
          AND storage_sequence > 0
          AND created_at IS NOT NULL
          AND isfinite(created_at)
        )
      ) NOT VALID;
  ELSE
    ALTER TABLE backstage_story_beats
      ADD CONSTRAINT backstage_story_beats_serialized_data_contract_expected
      CHECK (
        (serialized_data IS NULL AND storage_sequence IS NULL)
        OR (
          serialized_data IS NOT NULL
          AND octet_length(convert_to(serialized_data, 'UTF8')) <= 16384
          AND serialized_data IS JSON OBJECT
          AND storage_sequence IS NOT NULL
          AND storage_sequence > 0
          AND created_at IS NOT NULL
          AND isfinite(created_at)
        )
      ) NOT VALID;

    SELECT pg_get_expr(conbin, conrelid, false)
    INTO expected_constraint_expression
    FROM pg_constraint
    WHERE conrelid = 'backstage_story_beats'::regclass
      AND conname = 'backstage_story_beats_serialized_data_contract_expected';

    ALTER TABLE backstage_story_beats
      DROP CONSTRAINT backstage_story_beats_serialized_data_contract_expected;

    IF actual_constraint_type <> 'c'
      OR actual_constraint_expression IS DISTINCT FROM expected_constraint_expression
      OR actual_constraint_no_inherit
      OR NOT actual_constraint_is_local
      OR actual_constraint_inheritance_count <> 0
      OR actual_constraint_parent <> 0
      OR NOT actual_constraint_enforced THEN
      RAISE EXCEPTION
        'backstage_story_beats_serialized_data_contract has an unexpected definition'
        USING ERRCODE = '42804';
    END IF;
  END IF;
END
$$;

ALTER TABLE backstage_story_beats
  VALIDATE CONSTRAINT backstage_story_beats_serialized_data_contract;

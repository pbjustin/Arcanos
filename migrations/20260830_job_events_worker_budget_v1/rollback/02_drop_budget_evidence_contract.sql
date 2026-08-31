BEGIN;
LOCK TABLE job_events IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  stats_attribute SMALLINT;
  stats_type OID;
  stats_modifier INTEGER;
  stats_collation OID;
  stats_not_null BOOLEAN;
  stats_generated "char";
  stats_identity "char";
  stats_has_default BOOLEAN;
  generation_attribute SMALLINT;
  generation_type OID;
  generation_modifier INTEGER;
  generation_collation OID;
  generation_not_null BOOLEAN;
  generation_generated "char";
  generation_identity "char";
  generation_has_default BOOLEAN;
  operation_attribute SMALLINT;
  operation_type OID;
  operation_modifier INTEGER;
  operation_not_null BOOLEAN;
  operation_generated "char";
  operation_identity "char";
  operation_has_default BOOLEAN;
  event_type_attribute SMALLINT;
  constraint_oid OID;
  constraint_type "char";
  constraint_valid BOOLEAN;
  constraint_columns SMALLINT[];
  constraint_expression TEXT;
  constraint_no_inherit BOOLEAN;
  constraint_is_local BOOLEAN;
  constraint_inheritance_count INTEGER;
  constraint_parent OID;
  constraint_enforced BOOLEAN;
  expected_expression TEXT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class AS candidate
    INNER JOIN pg_class AS table_class
      ON table_class.oid = 'job_events'::regclass
     AND table_class.relnamespace = candidate.relnamespace
    WHERE candidate.relname IN (
      'idx_job_events_worker_budget_group_window',
      'idx_job_events_worker_budget_claim_generation'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'worker budget rollback phase 2 refused because phase 1 index names remain';
  END IF;

  CREATE TEMP TABLE worker_budget_rollback_shape_guard (
    event_type TEXT NOT NULL,
    stats_worker_id TEXT,
    claim_generation BIGINT
  ) ON COMMIT DROP;
  ALTER TABLE pg_temp.worker_budget_rollback_shape_guard
    ADD CONSTRAINT worker_budget_rollback_shape_guard_check
    CHECK (
      event_type NOT IN (
        'worker.budget.job_claim',
        'worker.budget.ai_provider_attempt'
      )
      OR (
        stats_worker_id IS NOT NULL
        AND (
          (event_type = 'worker.budget.job_claim'
            AND claim_generation IS NOT NULL
            AND claim_generation > 0)
          OR (event_type = 'worker.budget.ai_provider_attempt'
            AND claim_generation IS NULL)
        )
      )
    );
  SELECT pg_get_expr(conbin, conrelid, false)
  INTO expected_expression
  FROM pg_constraint
  WHERE conrelid = 'pg_temp.worker_budget_rollback_shape_guard'::regclass
    AND conname = 'worker_budget_rollback_shape_guard_check';

  SELECT attnum, atttypid, atttypmod, attcollation, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO stats_attribute, stats_type, stats_modifier, stats_collation, stats_not_null,
       stats_generated, stats_identity, stats_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass
    AND attname = 'stats_worker_id'
    AND NOT attisdropped;

  SELECT attnum, atttypid, atttypmod, attcollation, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO generation_attribute, generation_type, generation_modifier, generation_collation,
       generation_not_null,
       generation_generated, generation_identity, generation_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass
    AND attname = 'claim_generation'
    AND NOT attisdropped;

  SELECT attnum, atttypid, atttypmod, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO operation_attribute, operation_type, operation_modifier, operation_not_null,
       operation_generated, operation_identity, operation_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass
    AND attname = 'operation'
    AND NOT attisdropped;

  SELECT attnum
  INTO event_type_attribute
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass
    AND attname = 'event_type'
    AND NOT attisdropped;

  SELECT
    oid,
    contype,
    convalidated,
    conkey,
    pg_get_expr(conbin, conrelid, false),
    connoinherit,
    conislocal,
    coninhcount,
    conparentid,
    COALESCE((to_jsonb(pg_constraint) ->> 'conenforced')::BOOLEAN, TRUE)
  INTO
    constraint_oid,
    constraint_type,
    constraint_valid,
    constraint_columns,
    constraint_expression,
    constraint_no_inherit,
    constraint_is_local,
    constraint_inheritance_count,
    constraint_parent,
    constraint_enforced
  FROM pg_constraint
  WHERE conrelid = 'job_events'::regclass
    AND conname = 'job_events_worker_budget_shape_check';

  IF stats_type IS NULL
    AND generation_type IS NULL
    AND operation_type IS NULL
    AND constraint_oid IS NULL THEN
    RETURN;
  END IF;

  IF stats_type IS DISTINCT FROM 'varchar'::regtype
    OR stats_modifier IS DISTINCT FROM 259
    OR stats_collation IS DISTINCT FROM '"C"'::regcollation
    OR stats_not_null IS DISTINCT FROM FALSE
    OR stats_generated IS DISTINCT FROM ''::"char"
    OR stats_identity IS DISTINCT FROM ''::"char"
    OR stats_has_default IS DISTINCT FROM FALSE
    OR generation_type IS DISTINCT FROM 'bigint'::regtype
    OR generation_modifier IS DISTINCT FROM -1
    OR generation_collation IS DISTINCT FROM 0
    OR generation_not_null IS DISTINCT FROM FALSE
    OR generation_generated IS DISTINCT FROM ''::"char"
    OR generation_identity IS DISTINCT FROM ''::"char"
    OR generation_has_default IS DISTINCT FROM FALSE
    OR operation_type IS DISTINCT FROM 'varchar'::regtype
    OR operation_modifier IS DISTINCT FROM 204
    OR operation_not_null IS DISTINCT FROM FALSE
    OR operation_generated IS DISTINCT FROM ''::"char"
    OR operation_identity IS DISTINCT FROM ''::"char"
    OR operation_has_default IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'worker budget evidence columns have an unexpected definition; rollback refused'
      USING ERRCODE = '42804';
  END IF;

  -- Exact pre-validation and validated lifecycle states are both owned shapes.
  IF constraint_oid IS NULL
    OR constraint_type IS DISTINCT FROM 'c'::"char"
    OR constraint_valid IS NULL
    OR constraint_columns IS DISTINCT FROM ARRAY[
      event_type_attribute,
      stats_attribute,
      generation_attribute
    ]::SMALLINT[]
    OR constraint_expression IS DISTINCT FROM expected_expression
    OR constraint_no_inherit IS DISTINCT FROM FALSE
    OR constraint_is_local IS DISTINCT FROM TRUE
    OR constraint_inheritance_count IS DISTINCT FROM 0
    OR constraint_parent IS DISTINCT FROM 0
    OR constraint_enforced IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'job_events_worker_budget_shape_check has an unexpected definition; rollback refused'
      USING ERRCODE = '42804';
  END IF;

  IF EXISTS (
    SELECT 1 FROM job_events
    WHERE stats_worker_id IS NOT NULL
       OR claim_generation IS NOT NULL
       OR operation IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'worker budget rollback refused because evidence-column data exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_depend AS dependency
    WHERE dependency.refclassid = 'pg_class'::regclass
      AND dependency.refobjid = 'job_events'::regclass
      AND dependency.refobjsubid IN (
        stats_attribute,
        generation_attribute,
        operation_attribute
      )
      AND NOT (
        dependency.classid = 'pg_constraint'::regclass
        AND dependency.objid = constraint_oid
        AND dependency.objsubid = 0
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'worker budget evidence columns have unexpected dependent objects; rollback refused';
  END IF;
END
$$;

ALTER TABLE job_events
  DROP CONSTRAINT IF EXISTS job_events_worker_budget_shape_check,
  DROP COLUMN IF EXISTS operation,
  DROP COLUMN IF EXISTS claim_generation,
  DROP COLUMN IF EXISTS stats_worker_id;

COMMIT;
